"""The dashboard files, data cache and endpoints (synthetic ledger only)."""

import datetime
import json

import pytest
from conftest import BASE_LEDGER
from ledger_data_api import dashboard
from ledger_data_api.dashboard import DashboardError

EXT = '\n2030-01-01 custom "fava-extension" "ledger_data_api"\n'
SPEC = {
    "meta": {"catalogVersion": 1, "issueDate": "2030-06-01", "lens": "morning",
             "headline": None, "note": None},
    "root": "page",
    "elements": {
        "page": {"type": "Stack", "props": {"gap": "md"}, "children": ["hero"]},
        "hero": {"type": "NetWorthHero",
                 "props": {"value": {"$state": "/netWorth/value"}}},
    },
}


def _ddir(h):
    return h.root / "config" / "dashboard"


def _write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")


# ---------- files ----------


def test_missing_files_read_as_null(h):
    assert dashboard.read_spec(h.root) is None
    assert dashboard.read_lkg(h.root) is None
    assert dashboard.read_issue(h.root, "2030-06-01") is None
    assert dashboard.list_issues(h.root) == []


def test_unreadable_files_read_as_null(h):
    _write(_ddir(h) / "spec.json", "{not json")
    _write(_ddir(h) / "spec.lkg.json", "[1, 2]")
    assert dashboard.read_spec(h.root) is None
    assert dashboard.read_lkg(h.root) is None


def test_issue_archive(h):
    for d in ("2030-06-01", "2030-06-03", "2030-05-30"):
        _write(_ddir(h) / "issues" / f"{d}.json", SPEC)
    _write(_ddir(h) / "issues" / "notes.json", SPEC)
    _write(_ddir(h) / "issues" / "2030-13-01.json", SPEC)
    _write(_ddir(h) / "issues" / "2030-06-04.txt", "x")
    assert dashboard.list_issues(h.root) == ["2030-06-03", "2030-06-01", "2030-05-30"]
    assert dashboard.read_issue(h.root, "2030-06-03") == SPEC


@pytest.mark.parametrize("bad", [None, "", "2030-6-1", "2030-02-30", "../spec", "2030-06-01x"])
def test_issue_date_is_validated(h, bad):
    with pytest.raises(DashboardError):
        dashboard.read_issue(h.root, bad)


def test_feedback_appends_lines(h):
    now = datetime.datetime(2030, 6, 1, 9, 30, 15, 123, tzinfo=datetime.UTC)
    rec = dashboard.append_feedback(
        h.root, {"issue": "2030-06-01", "element": "hero", "text": "  bigger  "}, now
    )
    assert rec == {"ts": "2030-06-01T09:30:15Z", "issue": "2030-06-01",
                   "element": "hero", "text": "bigger"}
    dashboard.append_feedback(h.root, {"issue": "2030-06-01", "element": "pace-chart",
                                       "text": "not useful"})
    lines = (_ddir(h) / "feedback.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(x)["element"] for x in lines] == ["hero", "pace-chart"]


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        {"element": "hero", "text": "x"},
        {"issue": "2030-06-01", "text": "x"},
        {"issue": "2030-06-01", "element": "has space", "text": "x"},
        {"issue": "2030-06-01", "element": "hero", "text": "   "},
        {"issue": "2030-06-01", "element": "hero", "text": 5},
        {"issue": "2030-06-01", "element": "hero", "text": "x" * 4001},
    ],
)
def test_feedback_is_validated(h, body):
    with pytest.raises(DashboardError):
        dashboard.append_feedback(h.root, body)
    assert not (_ddir(h) / "feedback.jsonl").exists()


# ---------- data cache and version ----------


@pytest.fixture
def loaded(h):
    from beancount import loader

    dashboard.clear_cache()
    ents, errors, _ = loader.load_file(h.path)
    assert not errors
    return ents


def test_payload_without_spec_files(h, loaded):
    p = dashboard.dashboard_payload(h.root, loaded, datetime.date(2030, 6, 10))
    assert p["spec"] is None and p["lkg"] is None and p["issues"] == []
    assert p["dataError"] is None
    assert p["data"]["asOf"] == "2030-06-10"
    assert set(p["data"]["derived"]) == {
        "paceDelta", "needsYou", "cardsDue", "cashProjection", "stale", "freshness",
        "findings", "context",
    }
    assert isinstance(p["version"], str) and len(p["version"]) == 16


def test_data_is_cached_until_something_changes(h, loaded, monkeypatch):
    calls = []
    real = dashboard.build_data

    def counting(*a, **kw):
        calls.append(1)
        return real(*a, **kw)

    monkeypatch.setattr(dashboard, "build_data", counting)
    day = datetime.date(2030, 6, 10)
    v1 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)["version"]
    v2 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)["version"]
    assert v1 == v2 and len(calls) == 1

    # A spec edit changes the version without rebuilding the data.
    _write(_ddir(h) / "spec.json", SPEC)
    p = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert p["spec"] == SPEC and p["version"] != v1 and len(calls) == 1

    # A Fava reload (new mark), a new day, or a side input rebuilds.
    dashboard.dashboard_payload(h.root, loaded, day, load_mark=2)
    assert len(calls) == 2
    dashboard.dashboard_payload(h.root, loaded, datetime.date(2030, 6, 11), load_mark=2)
    assert len(calls) == 3
    _write(h.root / "statements" / "fetch-status.jsonl",
           json.dumps({"account": "Card B", "status": "SKIP", "reason": "login"}))
    p = dashboard.dashboard_payload(h.root, loaded, datetime.date(2030, 6, 11), load_mark=2)
    assert len(calls) == 4
    assert p["data"]["derived"]["stale"] == [{"account": "Card B", "reason": "login"}]


def test_invalid_mobile_config_is_not_a_crash(h, loaded):
    _write(h.root / "config" / "mobile.yaml", "nonsense_key: 1\n")
    p = dashboard.dashboard_payload(h.root, loaded, datetime.date(2030, 6, 10))
    assert p["data"] is None and p["dataError"]


def test_any_assembly_failure_is_a_data_error(h, loaded, monkeypatch, caplog):
    def boom(*a, **kw):
        raise KeyError("snapshot edge case " + "x" * 1000)

    monkeypatch.setattr(dashboard, "build_data", boom)
    _write(_ddir(h) / "spec.json", SPEC)
    with caplog.at_level("ERROR", logger="ledger_data_api.dashboard"):
        p = dashboard.dashboard_payload(h.root, loaded, datetime.date(2030, 6, 10))
    assert p["data"] is None and p["spec"] == SPEC
    assert p["dataError"].startswith("could not build dashboard data: KeyError")
    assert len(p["dataError"]) <= dashboard.MAX_DATA_ERROR and "\n" not in p["dataError"]
    assert "Traceback" in caplog.text


def test_findings_reach_the_data_and_refresh_the_cache(h, loaded):
    day = datetime.date(2030, 6, 10)
    p = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert p["data"]["derived"]["findings"] == []
    _write(_ddir(h) / "findings.json", [
        {"id": "drift-1", "kind": "drift", "title": "Rent posted above forecast",
         "amount": 25, "from": 1000, "to": 1025, "account": None, "date": "2030-06-01"},
    ])
    p2 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert [f["id"] for f in p2["data"]["derived"]["findings"]] == ["drift-1"]
    assert p2["version"] != p["version"]
    _write(_ddir(h) / "findings.json", "not json")
    p3 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert p3["dataError"] is None and p3["data"]["derived"]["findings"] == []


def test_context_reaches_the_data_and_refreshes_the_cache(h, loaded):
    day = datetime.date(2030, 6, 10)
    p = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    ctx = p["data"]["derived"]["context"]
    assert set(ctx) == {"generatedAt", "market", "news", "plan", "insights"}
    assert ctx["plan"] == [] and ctx["market"]["indices"] == []
    _write(_ddir(h) / "context.json", {
        "plan": [{"id": "p1", "date": "2030-06-20", "title": "Renew lease", "detail": "",
                  "source": "docs/planning/short-term.md", "status": "upcoming"}],
    })
    p2 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert [r["id"] for r in p2["data"]["derived"]["context"]["plan"]] == ["p1"]
    assert p2["version"] != p["version"]
    _write(_ddir(h) / "context.json", "not json")
    p3 = dashboard.dashboard_payload(h.root, loaded, day, load_mark=1)
    assert p3["dataError"] is None and p3["data"]["derived"]["context"]["plan"] == []


def test_endpoint_and_cli_read_the_same_config_dir(h, monkeypatch):
    from beancount_tooling import paths

    monkeypatch.setenv("LEDGER_DIR", str(h.root))
    assert dashboard.config_dir_of(h.root).resolve() == paths.get_config_dir()
    seen = {}

    def fake(ledger_dir, entries, asof, **kw):
        seen.update(kw)
        return {}

    monkeypatch.setattr("beancount_tooling.mobile.assemble.assemble_snapshot", fake)
    dashboard.build_data(h.root, [], datetime.date(2030, 6, 10))
    assert seen["config_dir"] == h.root / "config"


# ---------- HTTP ----------


@pytest.fixture
def client(h):
    from fava.application import create_app

    dashboard.clear_cache()
    h.write_ledger(BASE_LEDGER + EXT)
    app = create_app([h.path])
    app.testing = True
    slug = next(iter(app.config["LEDGERS"].ledgers_by_slug))
    base = f"/{slug}/extension/LedgerDataApi/"
    with app.test_client() as c:

        def get(name, **q):
            r = c.get(base + name, query_string=q)
            return r.status_code, json.loads(r.data)

        def post(name, body=None, data=None):
            r = (c.post(base + name, json=body) if data is None
                 else c.post(base + name, data=data, content_type="application/json"))
            return r.status_code, json.loads(r.data)

        yield get, post


def test_dashboard_endpoint(client, h):
    get, _ = client
    status, body = get("dashboard")
    assert status == 200
    assert body["spec"] is None and body["lkg"] is None and body["issues"] == []
    assert body["data"]["asOf"] == datetime.date.today().isoformat()
    assert "derived" in body["data"]
    v1 = body["version"]

    _write(_ddir(h) / "spec.json", SPEC)
    _write(_ddir(h) / "spec.lkg.json", SPEC)
    _write(_ddir(h) / "issues" / "2030-06-01.json", SPEC)
    status, body = get("dashboard")
    assert status == 200
    assert body["spec"] == SPEC and body["lkg"] == SPEC
    assert body["issues"] == ["2030-06-01"] and body["version"] != v1


def test_dashboard_issue_endpoint(client, h):
    get, _ = client
    assert get("dashboard_issue")[0] == 400
    assert get("dashboard_issue", date="nope")[0] == 400
    assert get("dashboard_issue", date="2030-06-01") == (200, {"spec": None})
    _write(_ddir(h) / "issues" / "2030-06-01.json", SPEC)
    assert get("dashboard_issue", date="2030-06-01") == (200, {"spec": SPEC})


def test_dashboard_feedback_endpoint(client, h):
    _, post = client
    ok = {"issue": "2030-06-01", "element": "hero", "text": "always show this"}
    assert post("dashboard_feedback", ok) == (200, {"status": "ok"})
    assert post("dashboard_feedback", {"issue": "x"})[0] == 400
    assert post("dashboard_feedback", data="{broken")[0] == 400
    lines = (_ddir(h) / "feedback.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["text"] == "always show this"
