"""ledger_data_api.runway: config resolution for the /runway page.

Synthetic ledger and config only (tests/fixtures/runway/)."""

import datetime
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from beancount import loader
from ledger_data_api import runway

FIXTURES = Path(__file__).parent / "fixtures" / "runway"
TODAY = datetime.date(2026, 11, 8)

LEDGER = """
2020-01-01 open Assets:Checking:Acme USD
2020-01-01 open Assets:Saving:Acme USD
2020-01-01 open Assets:Investment:Broker:USD USD
2020-01-01 open Assets:Investment:Broker:VTI VTI
2020-01-01 open Assets:Investment:Broker:XYZ XYZ
2020-01-01 open Assets:Receivable:Friend USD
2020-01-01 open Liabilities:Credit:Card USD
2020-01-01 open Liabilities:Loan:Car USD
2020-01-01 open Equity:Opening

2026-01-01 * "opening"
  Assets:Checking:Acme          5000 USD
  Assets:Saving:Acme           20000 USD
  Assets:Investment:Broker:USD  1000 USD
  Assets:Receivable:Friend        50 USD
  Liabilities:Credit:Card       -800 USD
  Liabilities:Loan:Car         -9000 USD
  Equity:Opening

2026-02-01 * "buy"
  Assets:Investment:Broker:VTI  10 VTI {200 USD}
  Assets:Investment:Broker:XYZ   5 XYZ {10 USD}
  Equity:Opening

2026-11-01 price VTI 300 USD
2026-11-01 price XYZ 20 USD

2026-12-01 * "future-dated, after asof"
  Assets:Checking:Acme  999 USD
  Equity:Opening
"""

@pytest.fixture
def ledger():
    entries, errors, options = loader.load_string(LEDGER)
    assert not errors
    return SimpleNamespace(options=options), entries


def make_root(tmp_path: Path) -> Path:
    """<tmp>/journal/journal.beancount + config/runway.yaml + partner/runway.yaml."""
    (tmp_path / "journal").mkdir(parents=True)
    (tmp_path / "journal" / "journal.beancount").write_text("")
    (tmp_path / "config").mkdir()
    (tmp_path / "partner").mkdir()
    shutil.copy(FIXTURES / "runway.yaml", tmp_path / "config" / "runway.yaml")
    shutil.copy(FIXTURES / "partner.yaml", tmp_path / "partner" / "runway.yaml")
    return tmp_path


def build(root: Path, ledger) -> dict:
    led, entries = ledger
    return runway.build_runway_data(
        ledger=led,
        entries=entries,
        ledger_file_path=str(root / "journal" / "journal.beancount"),
        today=TODAY,
    )


# ---------- includes ----------


def test_include_happy_path(tmp_path):
    root = make_root(tmp_path)
    data, message, status = runway.resolve_include(root, "partner/runway.yaml")
    assert status == "ok" and message is None
    assert data["id"] == "sam"


@pytest.mark.parametrize("rel", ["../outside.yaml", "partner/../../outside.yaml"])
def test_include_rejects_parent_escape(tmp_path, rel):
    root = make_root(tmp_path / "ledger")
    (tmp_path / "outside.yaml").write_text("id: x\n")
    data, message, status = runway.resolve_include(root, rel)
    assert data is None and status == "error"
    assert "outside" in message


def test_include_rejects_absolute(tmp_path):
    root = make_root(tmp_path)
    data, message, status = runway.resolve_include(root, str(root / "partner" / "runway.yaml"))
    assert data is None and status == "error"
    assert "relative" in message


def test_include_rejects_symlink_escape(tmp_path):
    root = make_root(tmp_path / "ledger")
    (tmp_path / "secret.yaml").write_text("id: x\n")
    (root / "partner" / "link.yaml").symlink_to(tmp_path / "secret.yaml")
    data, _message, status = runway.resolve_include(root, "partner/link.yaml")
    assert data is None and status == "error"


def test_include_gitcrypt_locked(tmp_path):
    root = make_root(tmp_path)
    (root / "partner" / "runway.yaml").write_bytes(b"\x00GITCRYPT\x00\x01binary")
    data, message, status = runway.resolve_include(root, "partner/runway.yaml")
    assert data is None and status == "locked"
    assert "git-crypt" in message


def test_include_missing(tmp_path):
    root = make_root(tmp_path)
    data, _message, status = runway.resolve_include(root, "partner/nope.yaml")
    assert data is None and status == "missing"


def test_include_nested_rejected(tmp_path):
    root = make_root(tmp_path)
    (root / "partner" / "runway.yaml").write_text("id: sam\ninclude: other.yaml\n")
    data, message, status = runway.resolve_include(root, "partner/runway.yaml")
    assert data is None and status == "error"
    assert "may not include" in message


def test_include_malformed_yaml(tmp_path):
    root = make_root(tmp_path)
    (root / "partner" / "runway.yaml").write_text("id: [unclosed\n")
    data, message, status = runway.resolve_include(root, "partner/runway.yaml")
    assert data is None and status == "error"
    assert "malformed" in message


def test_include_rejects_non_yaml(tmp_path):
    root = make_root(tmp_path)
    _data, _message, status = runway.resolve_include(root, "journal/journal.beancount")
    assert status == "error"


# ---------- sleeve mapping ----------


def test_map_sleeves_first_match_wins_and_signs():
    positions = [
        ("Assets:Broker:SPY", "SPY", 100.0),
        ("Assets:Broker:ABC", "ABC", 50.0),
        ("Assets:Checking:Bank", "USD", 10.0),
        ("Assets:Other:Thing", "USD", 7.0),
        ("Liabilities:Credit:A", "USD", -300.0),
        ("Liabilities:Credit:B", "USD", 20.0),
        ("Liabilities:Loan:Car", "USD", -900.0),
    ]
    rules = [
        ("core", r"^Assets:Broker:SPY$"),
        ("play", r"^Assets:Broker:"),
        ("core", r"^Assets:Broker:ABC$"),  # shadowed by the play rule above
        ("checking", r"^Assets:Checking:"),
    ]
    out = runway.map_sleeves(rules, r"^Liabilities:Credit:", r"^Liabilities:Loan:", positions)
    assert out["sleeves"]["core"] == 100.0
    assert out["sleeves"]["play"] == 50.0
    assert out["sleeves"]["checking"] == 10.0
    assert out["cards"] == 280.0
    assert out["loans"] == 900.0
    assert out["unmapped"] == [{"account": "Assets:Other:Thing", "currency": "USD", "usd": 7.0}]
    assert set(out["sleeves"]) == set(runway.SLEEVES)


# ---------- end to end ----------


def test_build_end_to_end(tmp_path, ledger):
    data = build(make_root(tmp_path), ledger)
    assert data["fromConfig"] is True
    assert data["asof"] == "2026-11-08"
    assert data["start"] == "2026-11"
    assert data["months"] == 24
    assert data["spreadThrough"] == "horizon"
    assert data["firstMonthSpendFraction"] == round(22 / 30, 4)
    assert data["errors"] == []
    assert [p["id"] for p in data["people"]] == ["alex", "sam"]
    assert [(r["id"], r["status"]) for r in data["roster"]] == [("alex", "ok"), ("sam", "ok")]

    alex = data["people"][0]
    start = alex["starting"]
    assert start["source"] == "ledger"
    assert start["sleeves"]["checking"] == 5000.0  # the 2026-12-01 entry is after asof
    assert start["sleeves"]["ef"] == 20000.0
    assert start["sleeves"]["reserve"] == 1000.0
    assert start["sleeves"]["core"] == 3000.0
    assert start["sleeves"]["play"] == 100.0
    assert start["cards"] == 800.0
    assert start["loans"] == 9000.0
    assert start["unmapped"] == [
        {"account": "Assets:Receivable:Friend", "currency": "USD", "usd": 50.0}
    ]

    assert alex["label"] == "Alex"
    assert alex["spendingMonthly"] == 3000.0
    assert alex["readOnly"] is False

    # defaults deep-merge under the person; the person's own keys win
    assert alex["returns"] == {"equity": 0.06, "reserve": 0.04, "ef": 0.0365, "gold": 0.03}
    assert alex["overrides"] == ["returns.reserve"]
    assert alex["limits"] == {"2028": {"k401": 25000.0}}
    assert alex["spreadThrough"] == "horizon" and alex["playCap"] == 0.10
    assert data["shared"] == {
        "returns": {"equity": 0.06, "reserve": 0.039, "ef": 0.0365, "gold": 0.03},
        "limits": {"2028": {"k401": 25000.0}},
        "playCap": 0.10,
        "spreadThrough": "horizon",
    }
    assert len(data["version"]) == 16

    # pay settings at person level; jobs carry salary steps and nulls for pay
    assert alex["pay"]["schedule"] == {"frequency": "semimonthly", "anchor": None, "days": [15, -1]}
    assert alex["pay"]["deductions"][0]["paycheckOfMonth"] == 1
    assert alex["pay"]["withholding"]["state"] == "ny_nonresident"
    (cur,) = alex["jobs"]
    assert cur == {
        "id": "cur",
        "employer": "Current job",
        "start": "2024-06",
        "leave": None,
        "enabled": True,
        "note": None,
        "salary": [
            {"from": "2026-01", "gross": 100000.0, "enabled": True, "note": None},
            {"from": "2027-02", "gross": 103000.0, "enabled": True, "note": "review"},
        ],
        "match": {"type": "none"},
        "vesting": None,
        "hsaEmployer": None,
        "schedule": None,
        "deductions": None,
        "withholding": None,
    }
    assert alex["cash"]["cardPayoff"] == {"checking": 1.0}
    assert alex["hsaCoverage"] == []
    assert alex["birthYear"] is None

    # scenarios: patches over the plan, resolved into whole plan bodies
    assert [s["id"] for s in alex["scenarios"]] == ["next", "no-ira"]
    nxt, no_ira = (s["person"] for s in alex["scenarios"])
    assert [j["id"] for j in nxt["jobs"]] == ["cur", "next"]
    assert nxt["jobs"][1]["match"] == {"type": "flat", "pct": 0.04}
    assert nxt["contributions"] == alex["contributions"]
    assert [c["id"] for c in no_ira["contributions"]] == ["k401-pretax"]
    assert no_ira["spendingMonthly"] == 3200.0
    assert "starting" not in nxt and "scenarios" not in nxt

    msgs = [(w["personId"], w["message"]) for w in data["warnings"]]
    assert any(pid == "alex" and "matches no sleeve rule" in m for pid, m in msgs)


def test_build_partner_include_static_and_inline_override(tmp_path, ledger):
    data = build(make_root(tmp_path), ledger)
    sam = data["people"][1]
    assert sam["label"] == "Sam (inline)"  # inline key beside include wins
    assert sam["starting"]["source"] == "static"
    assert sam["starting"]["asof"] == "2026-11-01"
    assert sam["starting"]["sleeves"]["reserve"] == 40000.0
    assert sam["starting"]["cards"] == 2000.0
    assert sam["starting"]["unvested"] == 300.0
    assert sam["jobs"][0]["vesting"] == {"date": "2027-05-01", "unvestedStart": 300.0}
    # contribution streams: ids default from (account, tax), phases sort by month
    assert [c["id"] for c in sam["contributions"]] == [
        "k401-pretax",
        "k401-roth",
        "hsa-payroll",
        "ira-roth",
    ]
    pretax, roth, hsa, ira = sam["contributions"]
    assert pretax == {
        "id": "k401-pretax",
        "account": "k401",
        "tax": "traditional",
        "channel": "payroll",
        "ytd": {"2026": 1000.0},
        "schedule": [
            {"from": "2026-11", "pace": "percent", "pct": 0.5},
            {"from": "2027-01", "pace": "even", "share": 1.0, "capPct": 0.8},
        ],
    }
    assert roth["schedule"][1] == {"from": "2027-01", "pace": "off"}
    assert hsa["channel"] == "payroll"
    assert hsa["schedule"] == [
        {"from": "2026-11", "pace": "fixed", "amount": 150.0, "per": "month", "paycheckOfMonth": 2},
        {"from": "2027-01", "pace": "front_load", "share": 1.0, "capPct": 0.25},
    ]
    assert ira["channel"] == "direct"
    assert ira["schedule"] == [{"from": "2026-11", "pace": "lump", "month": 1, "amount": None}]
    assert sam["limits"] == {"2027": {"hsaSelf": 4500.0}, "2028": {"k401": 25000.0}}
    assert sam["overrides"] == ["limits.2027.hsaSelf"]
    assert sam["hsaCoverage"] == [
        {"from": "2026-01", "tier": "self"},
        {"from": "2027-06", "tier": "none"},
    ]
    assert sam["jobs"][0]["hsaEmployer"] == {"amount": 500.0, "month": 1}
    offer = sam["scenarios"][0]["person"]
    assert offer["hsaCoverage"] == [
        {"from": "2026-01", "tier": "self"},
        {"from": "2027-06", "tier": "family"},
    ]
    assert offer["jobs"][1]["vesting"] is None
    assert sam["cash"]["cardPayoff"] == {"checking": 0.5, "ef": 0.5}


def test_build_locked_partner_listed_in_roster(tmp_path, ledger):
    root = make_root(tmp_path)
    (root / "partner" / "runway.yaml").write_bytes(b"\x00GITCRYPT\x00rest")
    cfg = (root / "config" / "runway.yaml").read_text()
    cfg = cfg.replace("label: Sam (inline)", "id: sam\n    label: Sam")
    (root / "config" / "runway.yaml").write_text(cfg)
    data = build(root, ledger)
    assert [p["id"] for p in data["people"]] == ["alex"]
    assert data["roster"][1] == {
        "id": "sam",
        "label": "Sam",
        "status": "locked",
        "file": "partner/runway.yaml",
        "message": "partner/runway.yaml: git-crypt encrypted; unlock the repo",
    }
    assert data["errors"][0]["path"] == "people[1].include"


def test_build_missing_config(tmp_path, ledger):
    (tmp_path / "journal").mkdir()
    data = build(tmp_path, ledger)
    assert data["fromConfig"] is False
    assert data["people"] == [] and data["roster"] == []
    assert data["errors"] == []
    assert data["start"] == "2026-11"


def test_build_malformed_config(tmp_path, ledger):
    root = make_root(tmp_path)
    (root / "config" / "runway.yaml").write_text("people: [\n")
    data = build(root, ledger)
    assert data["fromConfig"] is False
    assert data["errors"] and "malformed" in data["errors"][0]["message"]


def _write(root: Path, text: str) -> None:
    (root / "config" / "runway.yaml").write_text(text)


BASE_PERSON = """
  - id: p
    pay:
      schedule: { frequency: biweekly, anchor: 2026-11-13 }
    jobs:
      - id: j
        salary: [ { from: 2026-01, gross: 50000 } ]
    spending: { monthly: 1000 }
    starting: { source: static, balances: { checking: 100 } }
"""


@pytest.mark.parametrize(
    ("patch", "path", "fragment"),
    [
        (("frequency: biweekly", "frequency: weekly"), "pay.schedule.frequency", "unknown pay"),
        (("anchor: 2026-11-13", "anchor: soon"), "pay.schedule.anchor", "YYYY-MM-DD"),
        (("monthly: 1000 }", "monthly: 1000 }\n    one_offs: [ { month: 2027-4, amount: 1 } ]"),
         "one_offs[0].month", "YYYY-MM"),
        (("checking: 100", "cash: 100"), "starting.balances.cash", "unknown sleeve"),
        (("source: static", "source: ledger, rules: [ { sleeve: core, accounts: '(' } ]"),
         "starting.rules[0].accounts", "bad regex"),
        (("monthly: 1000 }", "monthly: 1000 }\n    cash: { card_payoff: { checking: 0.5 } }"),
         "cash.card_payoff", "sum to 1"),
        (("monthly: 1000 }", "monthly: 1000 }\n    k401: { ytd: { 2026: 0 } }"), "k401", "contributions"),
        (("jobs:", "job: { gross_annual: 1 }\n    jobs:"), "job", "became `jobs:`"),
        (("gross: 50000 }", "gross: 50000 }, { from: 2026-01, gross: 1 }"),
         "jobs[0].salary[1].from", "already starts"),
        (("- id: j", "- id: j\n        leave: 2025-01\n        start: 2026-01"), "jobs[0].leave", "before start"),
        (("- id: j", "- id: j\n      - id: j"), "jobs[1].id", "duplicate job"),
        (("pay:\n      schedule: { frequency: biweekly, anchor: 2026-11-13 }", "pay: {}"),
         "pay.schedule", "no pay schedule"),
        (("monthly: 1000 }", "monthly: 1000 }\n    contributions: [ { account: roth } ]"),
         "contributions[0].account", "unknown account"),
        (("monthly: 1000 }", "monthly: 1000 }\n    contributions: [ { account: ira, channel: payroll } ]"),
         "contributions[0].channel", "must be direct"),
        (("monthly: 1000 }", "monthly: 1000 }\n    contributions: [ { account: hsa, tax: roth } ]"),
         "contributions[0].tax", "an HSA has none"),
        (("monthly: 1000 }",
          "monthly: 1000 }\n    contributions: [ { account: ira, schedule: [ { from: 2026-11, pace: percent } ] } ]"),
         "contributions[0].schedule[0].pace", "unknown pace"),
        (("monthly: 1000 }",
          ("monthly: 1000 }\n    contributions: [ { account: k401, schedule: "
           "[ { from: 2026-11, pace: off }, { from: 2026-11, pace: max } ] } ]")),
         "contributions[0].schedule[1].from", "already starts"),
        (("monthly: 1000 }",
          "monthly: 1000 }\n    contributions: [ { account: hsa } ]\n    pay: { deductions: [ { label: H, amount: 1, sleeve: hsa } ] }"),
         "pay.deductions[0]", "keep one"),
        (("monthly: 1000 }", "monthly: 1000 }\n    hsa_coverage: [ { from: 2026-11, tier: plus } ]"),
         "hsa_coverage[0].tier", "tier must be"),
        (("monthly: 1000 }", "monthly: 1000 }\n    limits: { 2026: { roth: 1 } }"),
         "limits.2026.roth", "unknown limit"),
        (("- id: j", "- id: j\n        match: { type: magic }"), "jobs[0].match.type", "unknown match"),
        (("schedule:", "withholding: { state: ca }\n      schedule:"), "pay.withholding.state", "unknown state"),
    ],
)
def test_validation_errors_drop_person(tmp_path, ledger, patch, path, fragment):
    root = make_root(tmp_path)
    _write(root, "people:" + BASE_PERSON.replace(*patch))
    data = build(root, ledger)
    assert data["people"] == []
    assert data["roster"][0]["status"] == "error"
    assert any(e["path"] == f"people[0].{path}" and fragment in e["message"] for e in data["errors"]), data[
        "errors"
    ]


def test_duplicate_person_id(tmp_path, ledger):
    root = make_root(tmp_path)
    _write(root, "people:" + BASE_PERSON + BASE_PERSON)
    data = build(root, ledger)
    assert [p["id"] for p in data["people"]] == ["p"]
    assert any("duplicate person id" in e["message"] for e in data["errors"])


def test_missing_id_and_semimonthly_without_days(tmp_path, ledger):
    root = make_root(tmp_path)
    person = BASE_PERSON.replace("id: p", "label: Nobody")
    other = BASE_PERSON.replace("id: p", "id: q").replace(
        "frequency: biweekly, anchor: 2026-11-13", "frequency: semimonthly"
    )
    _write(root, "people:" + person + other)
    data = build(root, ledger)
    assert data["people"] == []
    paths = {e["path"] for e in data["errors"]}
    assert "people[0].id" in paths
    assert "people[1].pay.schedule.days" in paths


def test_warnings(tmp_path, ledger):
    root = make_root(tmp_path)
    _write(
        root,
        "asof: 2026-11-08\npeople:"
        + BASE_PERSON.replace("balances: { checking: 100 }", "balances: { checking: -5 }").replace(
            "salary: [ { from: 2026-01", "salary: [ { from: 2027-03"
        )
        + "    cash: { earmarks: [ { label: Big, amount: 999 } ] }\n",
    )
    data = build(root, ledger)
    person = data["people"][0]
    assert person["limits"] == {}
    messages = [w["message"] for w in data["warnings"]]
    assert "negative starting balance" in messages
    assert "earmarks are larger than the starting reserve" in messages
    assert "the first salary step starts 2027-03; nothing is paid before it" in messages


def test_scenario_errors_keep_the_person(tmp_path, ledger):
    root = make_root(tmp_path)
    _write(
        root,
        "people:"
        + BASE_PERSON
        + "    scenarios:\n"
        + "      - { id: bad, patch: { jobs: [ { id: j, match: { type: magic } } ] } }\n"
        + "      - { id: old, job: { start: 2027-01 } }\n"
        + "      - { id: plan }\n"
        + "      - { id: ok, label: Fine, patch: { spending: { monthly: 2000 } } }\n",
    )
    data = build(root, ledger)
    (person,) = data["people"]
    assert [s["id"] for s in person["scenarios"]] == ["ok"]
    paths = {e["path"] for e in data["errors"]}
    assert "people[0].scenarios[0].patch.jobs[0].match.type" in paths
    assert "people[0].scenarios[1]" in paths
    assert "people[0].scenarios[2].id" in paths


def test_example_config_resolves_cleanly(tmp_path):
    """apps/web/lib/runway/runway.example.yaml parses with no errors against a
    ledger that has its accounts."""
    example = Path(__file__).parents[3] / "apps" / "web" / "lib" / "runway" / "runway.example.yaml"
    (tmp_path / "journal").mkdir()
    (tmp_path / "config").mkdir()
    shutil.copy(example, tmp_path / "config" / "runway.yaml")
    entries, errors, options = loader.load_string(
        """
2020-01-01 open Assets:Checking:Acme-Bank USD
2020-01-01 open Assets:Saving:Acme-Bank USD
2020-01-01 open Assets:Investment:Brokerage:Cash USD
2020-01-01 open Equity:Opening
2026-01-02 * "opening"
  Assets:Checking:Acme-Bank            4000 USD
  Assets:Saving:Acme-Bank             20000 USD
  Assets:Investment:Brokerage:Cash    30000 USD
  Equity:Opening
"""
    )
    assert not errors
    data = build(tmp_path, (SimpleNamespace(options=options), entries))
    assert data["errors"] == []
    person = data["people"][0]
    assert person["id"] == "alex"
    assert [(c["account"], c["tax"], c["channel"]) for c in person["contributions"]] == [
        ("k401", "traditional", "payroll"),
        ("k401", "roth", "payroll"),
        ("hsa", "traditional", "payroll"),
        ("ira", "roth", "direct"),
    ]
    assert data["warnings"] == []
    assert [s["id"] for s in person["scenarios"]] == ["new-job"]
    assert person["starting"]["sleeves"]["reserve"] == 30000.0
    assert person["spreadThrough"] == "year_end"
    assert person["playCap"] == 0.10


# ---------- ytd_from: contributions so far, from the ledger ----------

IRA_LEDGER = """
2020-01-01 open Assets:Checking:Acme USD
2020-01-01 open Assets:Investment:Broker:Roth-IRA:USD USD
2020-01-01 open Assets:Investment:Broker:Roth-IRA:VTI VTI
2020-01-01 open Assets:Investment:Broker:Trad-IRA:USD USD
2020-01-01 open Income:Match USD
2020-01-01 open Income:Dividends USD
2020-01-01 open Equity:Opening

2026-01-05 * "Deposit for last year, with a 3% match"
  contribution: 290.00 USD
  tax-year: 2025
  Assets:Investment:Broker:Roth-IRA:USD  298.70 USD
  Assets:Checking:Acme                  -290.00 USD
  Income:Match                            -8.70 USD

2026-03-02 * "Deposit with a 3% match"
  contribution: 100.00 USD
  Assets:Investment:Broker:Roth-IRA:USD  103.00 USD
  Assets:Checking:Acme                  -100.00 USD
  Income:Match                            -3.00 USD

2026-04-01 * "Deposit without metadata: the funding leg counts"
  Assets:Investment:Broker:Roth-IRA:USD   50.00 USD
  Assets:Checking:Acme                   -50.00 USD

2026-04-02 * "Buy inside the IRA: not a contribution"
  Assets:Investment:Broker:Roth-IRA:VTI  1 VTI {100 USD}
  Assets:Investment:Broker:Roth-IRA:USD  -100.00 USD

2026-04-03 * "Dividend: not a contribution"
  Assets:Investment:Broker:Roth-IRA:USD    2.00 USD
  Income:Dividends                        -2.00 USD

2026-04-10 * "Roth conversion from the traditional IRA: not a contribution"
  Assets:Investment:Broker:Roth-IRA:USD  784.04 USD
  Assets:Investment:Broker:Trad-IRA:USD -784.04 USD

2026-05-01 * "Traditional IRA deposit: other pattern"
  contribution: 40.00 USD
  Assets:Investment:Broker:Trad-IRA:USD   40.00 USD
  Assets:Checking:Acme                   -40.00 USD

2026-12-01 * "After asof"
  contribution: 500.00 USD
  Assets:Investment:Broker:Roth-IRA:USD  500.00 USD
  Assets:Checking:Acme                  -500.00 USD
"""


@pytest.fixture
def ira_ledger():
    entries, errors, options = loader.load_string(IRA_LEDGER)
    assert not errors
    return SimpleNamespace(options=options), entries


def test_ledger_contributions_by_tax_year(ira_ledger):
    _led, entries = ira_ledger
    got = runway.ledger_contributions(entries, "^Assets:Investment:Broker:Roth-IRA:", TODAY)
    # 2025: the January deposit tagged tax-year 2025. 2026: 100 (metadata, match
    # excluded) + 50 (funding leg); the buy, the dividend, the conversion from
    # the traditional IRA and December are out.
    assert got == {"2025": 290.0, "2026": 150.0}


def test_ytd_from_fills_ytd_and_warns_on_a_stale_hand_value(tmp_path, ira_ledger):
    root = make_root(tmp_path)
    _write(
        root,
        "asof: 2026-11-08\npeople:"
        + BASE_PERSON
        + "    contributions:\n"
        + "      - id: ira-roth\n        account: ira\n        tax: roth\n"
        + '        ytd_from: "^Assets:Investment:Broker:Roth-IRA:"\n'
        + "        ytd: { 2026: 440, 2025: 7000 }\n"
        + "        schedule: [ { from: 2026-11, pace: even } ]\n",
    )
    data = build(root, ira_ledger)
    assert data["errors"] == []
    (c,) = data["people"][0]["contributions"]
    assert c["ytd"] == {"2026": 150.0, "2025": 7000.0}  # only the asof year comes from the ledger
    assert c["ytdFrom"] == "^Assets:Investment:Broker:Roth-IRA:"
    assert c["ytdLedger"] == {"2026": 150.0}
    assert any(
        w["path"].endswith("contributions[0].ytd.2026") and "using the ledger" in w["message"]
        for w in data["warnings"]
    )


def test_ytd_from_rejects_a_bad_regex(tmp_path, ira_ledger):
    root = make_root(tmp_path)
    _write(
        root,
        "asof: 2026-11-08\npeople:"
        + BASE_PERSON
        + '    contributions:\n      - { id: ira-roth, account: ira, tax: roth, ytd_from: "(" }\n',
    )
    data = build(root, ira_ledger)
    assert any(e["path"].endswith("contributions[0].ytd_from") for e in data["errors"])
