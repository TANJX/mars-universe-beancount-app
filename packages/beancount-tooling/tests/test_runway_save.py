"""ledger_data_api.runway_write: saving /runway page edits back to YAML.

Synthetic config only (tests/fixtures/runway/)."""

import copy
import datetime
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from beancount import loader
from ledger_data_api import runway, runway_write
from ledger_data_api.runway_patch import apply_patch, diff_ops, diff_patch

FIXTURES = Path(__file__).parent / "fixtures" / "runway"
TODAY = datetime.date(2026, 11, 8)
BODY_KEYS = (
    "label", "birthYear", "pay", "jobs", "contributions", "limits", "hsaCoverage",
    "spendingMonthly", "oneOffs", "cash", "returns", "playCap", "spreadThrough",
)


@pytest.fixture
def root(tmp_path):
    (tmp_path / "journal").mkdir()
    (tmp_path / "journal" / "journal.beancount").write_text("")
    (tmp_path / "config").mkdir()
    (tmp_path / "partner").mkdir()
    shutil.copy(FIXTURES / "runway.yaml", tmp_path / "config" / "runway.yaml")
    shutil.copy(FIXTURES / "partner.yaml", tmp_path / "partner" / "runway.yaml")
    return tmp_path


@pytest.fixture
def ledger():
    entries, errors, options = loader.load_string('2020-01-01 open Assets:Checking:Acme USD\n')
    assert not errors
    return SimpleNamespace(options=options), entries


def _path(root: Path) -> str:
    return str(root / "journal" / "journal.beancount")


def load(root, ledger) -> dict:
    return runway.build_runway_data(
        ledger=ledger[0], entries=ledger[1], ledger_file_path=_path(root), today=TODAY
    )


def save(root, ledger, body) -> dict:
    return runway_write.save(
        ledger=ledger[0], entries=ledger[1], ledger_file_path=_path(root), today=TODAY, body=body
    )


def person_req(p: dict, **kw) -> dict:
    return {
        "id": p["id"],
        "plan": {k: p[k] for k in BODY_KEYS},
        "overrides": list(p["overrides"]),
        "scenarios": [{"id": s["id"], "label": s["label"], "person": s["person"]} for s in p["scenarios"]],
        **kw,
    }


# ---------- patches ----------


def test_patch_roundtrip_with_keyed_lists():
    old = {
        "jobs": [{"id": "a", "salary": [{"from": "2026-01", "gross": 1}]}],
        "cash": {"buffer": 1, "earmarks": [{"label": "x", "amount": 1}]},
        "returns": {"equity": 0.07},
    }
    new = copy.deepcopy(old)
    new["jobs"][0]["salary"].append({"from": "2027-01", "gross": 2})
    new["jobs"].append({"id": "b", "salary": []})
    new["cash"]["earmarks"] = []
    del new["returns"]
    patch = diff_patch(new, old)
    assert patch["jobs"] == [
        {"id": "a", "salary": [{"from": "2027-01", "gross": 2}]},
        {"id": "b", "salary": []},
    ]
    assert patch["returns"] is None
    applied = apply_patch(old, patch)
    applied.pop("returns")
    assert applied == new
    removed = diff_patch({"jobs": []}, {"jobs": [{"id": "a"}]})
    assert removed == {"jobs": [{"id": "a", "remove": True}]}
    assert apply_patch({"jobs": [{"id": "a"}]}, removed) == {"jobs": []}


def test_diff_ops_are_fine_grained():
    old = {"jobs": [{"id": "a", "employer": "A", "salary": [{"from": "2026-01", "gross": 1}]}]}
    new = copy.deepcopy(old)
    new["jobs"][0]["salary"][0]["gross"] = 2
    assert diff_ops(new, old) == [
        {
            "op": "set",
            "path": ["jobs", {"key": "id", "value": "a"}, "salary", {"key": "from", "value": "2026-01"}, "gross"],
            "value": 2,
        }
    ]


# ---------- save ----------


def test_denorm_roundtrip(root, ledger):
    data = load(root, ledger)
    for p in data["people"]:
        body = {k: p[k] for k in BODY_KEYS}
        again = runway._resolve_body(runway._Ctx(p["id"]), runway_write.denorm_body(body), data)
        assert again == body


def test_noop_save_writes_nothing(root, ledger):
    data = load(root, ledger)
    before = (root / "config" / "runway.yaml").read_text()
    for p in data["people"]:
        out = save(root, ledger, {"version": data["version"], "person": person_req(p), "shared": data["shared"]})
        assert out == {"status": "ok", "written": []}
    assert (root / "config" / "runway.yaml").read_text() == before


def test_edit_plan_scenarios_and_shared_keeps_comments(root, ledger):
    data = load(root, ledger)
    alex = copy.deepcopy(data["people"][0])
    alex["jobs"][0]["salary"][1]["gross"] = 105000
    alex["returns"]["equity"] = 0.08
    alex["overrides"] = ["returns.reserve", "returns.equity"]
    req = person_req(alex)
    nxt = req["scenarios"][0]
    nxt["label"] = "Next job (raised)"
    nxt["person"]["jobs"][0]["salary"][1]["gross"] = 105000
    nxt["person"]["returns"]["equity"] = 0.08
    nxt["person"]["jobs"][1]["salary"][0]["gross"] = 125000
    req["scenarios"] = [nxt, {"id": "lean", "label": "Lean", "person": {**req["plan"], "spendingMonthly": 2500}}]
    shared = copy.deepcopy(data["shared"])
    shared["playCap"] = 0.2

    out = save(root, ledger, {"version": data["version"], "person": req, "shared": shared})
    assert out["written"] == ["config/runway.yaml"]
    text = (root / "config" / "runway.yaml").read_text()
    assert "# Synthetic runway.yaml for test_runway_api.py." in text
    assert "- { from: 2027-02, gross: 105000, note: review }" in text
    assert "returns: { reserve: 0.04, equity: 0.08 }" in text
    assert "play_cap: 0.2" in text
    assert "id: no-ira" not in text

    after = load(root, ledger)
    assert after["errors"] == []
    a = after["people"][0]
    assert a["jobs"][0]["salary"][1]["gross"] == 105000
    assert sorted(a["overrides"]) == ["returns.equity", "returns.reserve"]
    assert [(s["id"], s["label"]) for s in a["scenarios"]] == [("next", "Next job (raised)"), ("lean", "Lean")]
    assert a["scenarios"][0]["person"]["jobs"][1]["salary"][0]["gross"] == 125000
    assert a["scenarios"][1]["person"]["spendingMonthly"] == 2500
    assert after["shared"]["playCap"] == 0.2
    assert a["playCap"] == 0.2  # not overridden, so the shared value applies


def test_dropping_an_override_removes_the_key(root, ledger):
    data = load(root, ledger)
    alex = copy.deepcopy(data["people"][0])
    alex["returns"]["reserve"] = data["shared"]["returns"]["reserve"]
    alex["overrides"] = []
    req = person_req(alex)
    # Scenarios follow the plan where they do not differ (as the page derives them).
    for s in req["scenarios"]:
        s["person"] = {**s["person"], "returns": dict(alex["returns"])}
    save(root, ledger, {"version": data["version"], "person": req})
    assert "returns:" not in (root / "config" / "runway.yaml").read_text().split("people:")[1]
    assert load(root, ledger)["people"][0]["overrides"] == []


def test_included_person_writes_its_own_file(root, ledger):
    data = load(root, ledger)
    sam = copy.deepcopy(data["people"][1])
    sam["spendingMonthly"] = 3100
    sam["label"] = "Sam (renamed)"
    out = save(root, ledger, {"version": data["version"], "person": person_req(sam)})
    assert out["written"] == ["config/runway.yaml", "partner/runway.yaml"]
    assert "spending: { monthly: 3100 }" in (root / "partner" / "runway.yaml").read_text()
    # label sits inline beside `include`, so it is written there
    assert "label: Sam (renamed)" in (root / "config" / "runway.yaml").read_text()


def test_stale_version_is_rejected(root, ledger):
    data = load(root, ledger)
    (root / "partner" / "runway.yaml").write_text((root / "partner" / "runway.yaml").read_text() + "\n")
    with pytest.raises(runway_write.SaveError) as ex:
        save(root, ledger, {"version": data["version"], "shared": data["shared"]})
    assert ex.value.status == 409


def test_invalid_edit_is_rejected_and_nothing_written(root, ledger):
    data = load(root, ledger)
    before = (root / "config" / "runway.yaml").read_text()
    alex = copy.deepcopy(data["people"][0])
    alex["jobs"].append(copy.deepcopy(alex["jobs"][0]) | {"id": "x", "start": "2027-05", "leave": "2027-01"})
    with pytest.raises(runway_write.SaveError) as ex:
        save(root, ledger, {"version": data["version"], "person": person_req(alex)})
    assert ex.value.status == 422
    assert any("before start" in i["message"] for i in ex.value.issues)
    assert (root / "config" / "runway.yaml").read_text() == before


def test_locked_person_cannot_be_saved(root, ledger):
    (root / "partner" / "runway.yaml").write_bytes(b"\x00GITCRYPT\x00rest")
    data = load(root, ledger)
    with pytest.raises(runway_write.SaveError):
        save(root, ledger, {"version": data["version"], "person": {"id": "sam", "plan": {}, "scenarios": []}})


def test_ytd_from_survives_a_save_and_is_not_written_as_a_number(root, ledger):
    path = root / "config" / "runway.yaml"
    text = path.read_text()
    old = "      - id: ira-roth\n        account: ira\n        tax: roth\n"
    assert old in text
    path.write_text(text.replace(old, old + '        ytd_from: "^Assets:Investment:Broker:Roth-IRA:"\n'))
    data = load(root, ledger)
    assert data["errors"] == []
    alex = data["people"][0]
    ira = next(c for c in alex["contributions"] if c["id"] == "ira-roth")
    assert ira["ytdLedger"] == {"2026": 0.0}

    before = path.read_text()
    out = save(root, ledger, {"version": data["version"], "person": person_req(alex), "shared": data["shared"]})
    assert out == {"status": "ok", "written": []}
    assert path.read_text() == before

    edited = copy.deepcopy(alex)
    edited["spendingMonthly"] = 3100
    out = save(root, ledger, {"version": data["version"], "person": person_req(edited), "shared": data["shared"]})
    assert out["written"] == ["config/runway.yaml"]
    after = path.read_text()
    assert 'ytd_from: "^Assets:Investment:Broker:Roth-IRA:"' in after
    ira_block = after[after.index("- id: ira-roth") : after.index("returns:", after.index("- id: ira-roth"))]
    assert "ytd:" not in ira_block
