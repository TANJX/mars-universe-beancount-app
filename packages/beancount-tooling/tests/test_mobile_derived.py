"""The snapshot's ``derived`` block and the shared assembly (synthetic data only)."""

import datetime as dt
import json
import os
import shutil
import subprocess

import pytest
from beancount import loader
from beancount_tooling.mobile import cli
from beancount_tooling.mobile.assemble import (
    assemble_snapshot,
    inputs_signature,
    ledger_meta,
)
from beancount_tooling.mobile.context import empty_context
from beancount_tooling.mobile.derived import (
    build_derived,
    cash_projection,
    freshness,
    read_findings,
    read_stale,
    usd,
)

from . import mobile_ledger

DERIVED_KEYS = {
    "paceDelta", "needsYou", "cardsDue", "cashProjection", "stale", "freshness", "findings",
    "context",
}


def _snap(**over):
    """A hand-written snapshot fragment: invented names, round numbers."""
    snap = {
        "asOf": "2030-03-10",
        "meta": {
            "asOf": "2030-03-10",
            "generatedAt": "2030-03-10T12:00:00Z",
            "ledgerCommit": "abc1234",
            "ledgerDirty": None,
        },
        "spend": {"flex": {"mtd": 900.0, "usualByToday": 1000.0}},
        "cards": {
            "accounts": [
                {"name": "Card B", "displayName": "Card B", "value": 500.0,
                 "due": "2030-03-25", "statement": 400.0, "fundedBy": "Checking A"},
                {"name": "Card C", "displayName": "Card C", "value": 50.0,
                 "due": "2030-03-15", "statement": 100.0, "fundedBy": None},
                # Paid off (statement under 1): not due.
                {"name": "Card D", "value": 0.0, "due": "2030-03-12", "statement": 0.5},
                # No due date: not due.
                {"name": "Card E", "value": 10.0},
                # Due beyond the 21-day window: in cardsDue, not needsYou.
                {"name": "Card F", "displayName": "Card F", "value": 300.0,
                 "due": "2030-04-20", "statement": 300.0, "fundedBy": "Checking A"},
            ]
        },
        "keyDates": [
            {"date": "2030-03-12", "label": "Renewal", "note": "Lease renewal"},
            {"date": "2030-05-01", "label": "Far off", "note": "beyond 30 days"},
        ],
        "plan": {
            "horizon": "2030-03-15",
            "startCash": 2000.0,
            "events": [
                {"date": "2030-03-12", "balance": 1500.0},
                {"date": "2030-03-14", "balance": 1800.0},
                {"date": "2030-03-14", "balance": 1700.0},
            ],
        },
    }
    snap.update(over)
    return snap


def test_build_derived_matches_the_contract(tmp_path):
    d = build_derived(_snap(), tmp_path)
    assert set(d) == DERIVED_KEYS
    assert d["paceDelta"] == -100.0

    assert [c["name"] for c in d["cardsDue"]] == ["Card C", "Card B", "Card F"]
    assert d["cardsDue"][0] == {
        "name": "Card C", "due": "2030-03-15", "statement": 100.0, "fundedBy": None,
    }

    assert [(n["date"], n["kind"]) for n in d["needsYou"]] == [
        ("2030-03-12", "date"),
        ("2030-03-15", "card"),
        ("2030-03-25", "card"),
    ]
    card_c = d["needsYou"][1]
    assert card_c["title"] == "Card C statement"
    assert card_c["detail"] == "$100.00 from checking"
    assert d["needsYou"][2]["detail"] == "$400.00 from Checking A"
    assert d["needsYou"][0] == {
        "date": "2030-03-12", "title": "Renewal", "detail": "Lease renewal", "kind": "date",
    }

    assert d["stale"] == []
    assert d["freshness"] == {
        "asOf": "2030-03-10",
        "generatedAt": "2030-03-10T12:00:00Z",
        "ledgerCommit": "abc1234",
        # Unknown (no git) stays unknown rather than reading as clean.
        "ledgerDirty": None,
    }
    assert d["findings"] == []
    assert d["context"] == empty_context()
    json.dumps(d)  # serializable


def test_freshness_keeps_a_known_dirty_flag():
    for v in (True, False):
        snap = _snap()
        snap["meta"]["ledgerDirty"] = v
        assert freshness(snap)["ledgerDirty"] is v


def test_cash_projection_steps_at_events():
    pts = cash_projection(_snap(), dt.date(2030, 3, 10))
    assert [p["date"] for p in pts] == [
        "2030-03-10", "2030-03-11", "2030-03-12", "2030-03-13", "2030-03-14", "2030-03-15",
    ]
    # The last event of a day wins (as in the prototype's Map).
    assert [p["balance"] for p in pts] == [2000.0, 2000.0, 1500.0, 1500.0, 1700.0, 1700.0]


def test_derived_tolerates_a_bare_snapshot():
    d = build_derived({"asOf": "2030-03-10"})
    assert d["paceDelta"] == 0
    assert d["needsYou"] == [] and d["cardsDue"] == [] and d["stale"] == []
    assert d["cashProjection"] == [{"date": "2030-03-10", "balance": 0.0}]
    assert d["freshness"]["ledgerCommit"] is None


def test_usd_uses_a_true_minus():
    assert usd(1234.5, 2) == "$1,234.50"
    assert usd(-50) == "−$50"


def test_read_stale_takes_the_latest_record_per_account(tmp_path):
    assert read_stale(tmp_path) == []
    assert read_stale(None) == []
    status = tmp_path / "statements" / "fetch-status.jsonl"
    status.parent.mkdir(parents=True)
    status.write_text(
        "\n".join(
            [
                json.dumps({"account": "Card B", "status": "SKIP", "reason": "login failed"}),
                json.dumps({"account": "Checking A", "status": "SKIP", "reason": "no file"}),
                "not json",
                json.dumps(["not", "an", "object"]),
                json.dumps({"status": "SKIP"}),
                json.dumps({"account": "Card B", "status": "OK"}),
                json.dumps({"account": "Card G", "status": "skip"}),
            ]
        ),
        encoding="utf-8",
    )
    assert read_stale(tmp_path) == [
        {"account": "Checking A", "reason": "no file"},
        {"account": "Card G", "reason": "skipped"},
    ]


# ---------- shared assembly over the synthetic ledger ----------


@pytest.fixture(scope="module")
def ledger_dir(tmp_path_factory):
    return mobile_ledger.write_ledger(tmp_path_factory.mktemp("derived-ledger"))


@pytest.fixture(scope="module")
def entries(ledger_dir):
    loaded, errors, _ = loader.load_file(str(ledger_dir / "journal" / "journal.beancount"))
    assert not errors
    return loaded


def test_cli_and_assembly_build_the_same_snapshot(ledger_dir, entries, tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))
    monkeypatch.delenv(cli.LOGO_TOKEN_VAR, raising=False)
    out = tmp_path / "snapshot.json"
    assert cli.main(["--asof", mobile_ledger.ASOF.isoformat(), "--out", str(out)]) == 0
    from_cli = json.loads(out.read_text(encoding="utf-8"))
    assert set(from_cli["derived"]) == DERIVED_KEYS

    assembled = assemble_snapshot(
        ledger_dir,
        entries,
        mobile_ledger.ASOF,
        out_path=out,
        generated_at=from_cli["meta"]["generatedAt"],
    )
    assert json.loads(json.dumps(assembled, ensure_ascii=False)) == from_cli

    d = from_cli["derived"]
    assert d["freshness"]["asOf"] == mobile_ledger.ASOF.isoformat()
    assert d["cashProjection"][0]["date"] == mobile_ledger.ASOF.isoformat()
    assert d["cashProjection"][-1]["date"] == from_cli["plan"]["horizon"]
    assert d["cardsDue"] == sorted(d["cardsDue"], key=lambda c: c["due"])
    assert all(c["statement"] > 1 for c in d["cardsDue"])


def test_inputs_signature_moves_with_side_files(tmp_path):
    before = inputs_signature(tmp_path)
    assert all(m == 0 for m in before)
    status = tmp_path / "statements" / "fetch-status.jsonl"
    status.parent.mkdir(parents=True)
    status.write_text("{}\n", encoding="utf-8")
    assert inputs_signature(tmp_path) != before


# ---------- findings.json ----------


def _findings(cfg, doc):
    path = cfg / "dashboard" / "findings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")


GOOD_FINDING = {
    "id": "drift-rent", "kind": "drift", "title": "Rent posted above forecast",
    "amount": 25, "from": 1000, "to": 1025.5, "account": "Expenses:Rent", "date": "2030-03-01",
}


def test_findings_absent_or_invalid_read_as_empty(tmp_path):
    cfg = tmp_path / "config"
    assert read_findings(None) == []
    assert read_findings(cfg) == []
    for bad in ("not json", "{}", '{"id": "x"}', "null", "\xff"):
        _findings(cfg, bad)
        assert read_findings(cfg) == []
    (cfg / "dashboard" / "findings.json").write_bytes(b"\xff\xfe")
    assert read_findings(cfg) == []


def test_findings_keep_valid_records_only(tmp_path):
    cfg = tmp_path / "config"
    _findings(cfg, [
        GOOD_FINDING,
        {"id": "note-1", "kind": "note", "title": "  Checking A fetched  "},
        GOOD_FINDING | {"title": "repeated id"},
        GOOD_FINDING | {"id": "k", "kind": "guess"},
        GOOD_FINDING | {"id": "a", "amount": "25"},
        GOOD_FINDING | {"id": "b", "amount": True},
        GOOD_FINDING | {"id": "d", "date": "2030-02-31"},
        GOOD_FINDING | {"id": "e", "account": 7},
        GOOD_FINDING | {"id": "t", "title": ""},
        {"kind": "note", "title": "no id"},
        "not an object",
    ])
    assert read_findings(cfg) == [
        {"id": "drift-rent", "kind": "drift", "title": "Rent posted above forecast",
         "amount": 25.0, "from": 1000.0, "to": 1025.5, "account": "Expenses:Rent",
         "date": "2030-03-01"},
        {"id": "note-1", "kind": "note", "title": "Checking A fetched",
         "amount": None, "from": None, "to": None, "account": None, "date": None},
    ]


def test_findings_merge_into_derived(tmp_path):
    _findings(tmp_path / "config", [GOOD_FINDING])
    assert [f["id"] for f in build_derived(_snap(), tmp_path)["findings"]] == ["drift-rent"]
    other = tmp_path / "elsewhere"
    assert build_derived(_snap(), tmp_path, config_dir=other)["findings"] == []
    _findings(other, [GOOD_FINDING | {"id": "x"}])
    assert [f["id"] for f in build_derived(_snap(), tmp_path, config_dir=other)["findings"]] == ["x"]


def test_inputs_signature_moves_with_findings_and_config_dir(tmp_path):
    before = inputs_signature(tmp_path)
    _findings(tmp_path / "config", [])
    assert inputs_signature(tmp_path) != before
    other = tmp_path / "other-config"
    before = inputs_signature(tmp_path, other)
    _findings(other, [])
    assert inputs_signature(tmp_path, other) != before


def test_assembly_reads_the_given_config_dir(ledger_dir, entries, tmp_path):
    other = tmp_path / "cfg"
    _findings(other, [GOOD_FINDING])
    snap = assemble_snapshot(ledger_dir, entries, mobile_ledger.ASOF, config_dir=other)
    assert [f["id"] for f in snap["derived"]["findings"]] == ["drift-rent"]
    snap = assemble_snapshot(ledger_dir, entries, mobile_ledger.ASOF)
    assert snap["derived"]["findings"] == []


# ---------- git freshness ----------

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _git(repo, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


def _touch(path, text="x\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@needs_git
def test_ledger_dirty_ignores_dashboard_docs_and_mobile(tmp_path):
    _git(tmp_path, "init", "-q")
    _touch(tmp_path / "journal" / "journal.beancount")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "init")
    out = tmp_path / "mobile" / "snapshot.json"
    meta = ledger_meta(tmp_path, out)
    assert meta["ledgerCommit"] and meta["ledgerDirty"] is False

    for rel in ("config/dashboard/spec.json", "config/dashboard/issues/2030-03-10.json",
                "docs/notes/dashboard-standards.md", "mobile/snapshot.json"):
        _touch(tmp_path / rel)
    assert ledger_meta(tmp_path, out)["ledgerDirty"] is False

    _touch(tmp_path / "config" / "ui.yaml")
    assert ledger_meta(tmp_path, out)["ledgerDirty"] is True


def test_ledger_meta_is_unknown_without_git(tmp_path):
    meta = ledger_meta(tmp_path, tmp_path / "mobile" / "snapshot.json")
    assert meta == {"ledgerCommit": None, "ledgerDirty": None}


@needs_git
def test_inputs_signature_moves_with_a_commit(tmp_path):
    _git(tmp_path, "init", "-q")
    _touch(tmp_path / "a.txt")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "one")
    before = inputs_signature(tmp_path)
    gd = tmp_path / ".git"
    kept = {p: p.stat().st_mtime_ns for p in (gd / "index", gd / "HEAD")}
    _touch(tmp_path / "b.txt")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "two")
    assert inputs_signature(tmp_path) != before
    # Even with HEAD and the index mtimes put back, the branch ref moved.
    for p, m in kept.items():
        os.utime(p, ns=(m, m))
    assert inputs_signature(tmp_path) != before
