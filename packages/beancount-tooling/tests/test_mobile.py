"""Mobile snapshot: built from the synthetic ledger in ``mobile_ledger.py``."""

import datetime as dt
import json

import pytest
from beancount import loader
from beancount_tooling import billing
from beancount_tooling.mobile import (
    SCHEMA_VERSION,
    MobileConfig,
    MobileConfigError,
    build_snapshot,
    cli,
    load_config,
    parse_config,
)

from . import mobile_ledger

V1_KEYS = {
    "asOf",
    "netWorth",
    "cash",
    "cards",
    "float",
    "invest",
    "loan",
    "receivable",
    "payable",
    "spend",
    "income",
    "savingsRate3m",
    "recent",
    "upcoming",
    "goals",
    "keyDates",
}


@pytest.fixture(scope="module")
def ledger_dir(tmp_path_factory):
    return mobile_ledger.write_ledger(tmp_path_factory.mktemp("mobile-ledger"))


@pytest.fixture(scope="module")
def entries(ledger_dir):
    loaded, errors, _ = loader.load_file(
        str(ledger_dir / "journal" / "journal.beancount")
    )
    assert not errors
    return loaded


@pytest.fixture(scope="module")
def snap(ledger_dir, entries):
    cfg = load_config(ledger_dir / "config" / "mobile.yaml")
    return build_snapshot(
        entries,
        cfg,
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
    )


def _cards(snapshot):
    return {c["name"]: c for c in snapshot["accounts"]["groups"][1]["accounts"]}


def _statement(card, sid, balance, due):
    return billing.Statement(
        f"Liabilities:Credit:{card}", sid, balance, due, None, "fetch", ""
    )


def test_keeps_every_v1_field_and_adds_the_tabs(snap):
    assert V1_KEYS <= set(snap)
    assert {"meta", "accounts", "activity", "plan"} <= set(snap)
    assert snap["meta"]["schemaVersion"] == SCHEMA_VERSION
    assert snap["meta"]["asOf"] == snap["asOf"] == "2030-06-18"
    json.dumps(snap)  # everything is JSON-serialisable


def test_groups_are_fixed_and_add_up_to_net_worth(snap):
    groups = snap["accounts"]["groups"]
    assert [g["id"] for g in groups] == [
        "cash",
        "cards",
        "investments",
        "loans",
        "receivables",
        "payables",
        "other",
    ]
    by_id = {g["id"]: g for g in groups}
    assert by_id["payables"]["accounts"] == []  # an empty group is still listed
    assert len(by_id["cards"]["accounts"]) == 9
    net = sum(g["total"] if g["kind"] == "asset" else -g["total"] for g in groups)
    assert net == pytest.approx(snap["netWorth"]["value"], abs=1.0)
    assert by_id["cash"]["total"] == snap["cash"]["total"]
    assert by_id["cards"]["total"] == snap["cards"]["total"]


def test_liabilities_are_amounts_owed(snap):
    cards = {c["name"]: c for c in snap["accounts"]["groups"][1]["accounts"]}
    assert cards["Ember"]["value"] < 0  # a refund left a credit on the card
    assert cards["Summit"]["value"] > 0
    assert cards["Summit"]["displayName"] == "Summit Rewards"
    assert cards["Summit"]["due"] == "2030-07-04"
    assert cards["Ember"]["due"] is None  # no planner settings for this card
    loan = snap["accounts"]["groups"][3]["accounts"][0]
    assert loan["value"] == snap["loan"]["balance"] > 0
    assert loan["payoff"] == "2032-06-15"


def test_investment_accounts_carry_holdings(snap):
    inv = {a["name"]: a for a in snap["accounts"]["groups"][2]["accounts"]}
    assert set(inv) == {"401k", "Roth-IRA", "Brokerage"}
    roth = inv["Roth-IRA"]
    assert roth["account"] == "Assets:Investment:Northwind:Roth-IRA"
    assert {h["symbol"] for h in roth["holdings"]} == {"VTI", "VXUS", "USD"}
    assert sum(h["value"] for h in roth["holdings"]) == pytest.approx(
        roth["value"], abs=0.05
    )
    vti = next(h for h in roth["holdings"] if h["symbol"] == "VTI")
    assert vti["name"] == "Total Market ETF"
    assert vti["units"] * vti["price"] == pytest.approx(vti["value"], abs=0.01)
    suica = next(
        a
        for a in snap["accounts"]["groups"][6]["accounts"]
        if a["displayName"] == "Suica"
    )
    assert suica["holdings"][0]["symbol"] == "JPY"


def test_activity_classifies_every_kind(snap):
    rows = snap["activity"]["transactions"]
    assert len({r["id"] for r in rows}) == len(rows)
    assert rows == sorted(rows, key=lambda r: r["date"], reverse=True)
    assert rows[-1]["date"] >= snap["activity"]["from"]
    kinds = {r["kind"] for r in rows}
    assert kinds == {
        "expense",
        "income",
        "transfer",
        "card payment",
        "investment",
        "loan payment",
    }

    def one(**match):
        return next(r for r in rows if all(r[k] == v for k, v in match.items()))

    refund = one(payee="Skyline Air", kind="expense", account="Ember")
    assert refund["amount"] == 640.0  # a refund is a positive expense row
    assert refund["category"] == "Travel" and refund["subcategory"] == "Flight"
    split = one(payee="City Power & Light")
    assert split["amount"] == -46.0  # own share, not the 92.00 that left checking
    assert one(kind="loan payment")["amount"] == -550.25
    assert one(kind="card payment")["amount"] > 0
    assert one(payee="IRA Contribution")["amount"] == 500.0
    buy = next(r for r in rows if "market buy" in r["payee"])
    assert buy["kind"] == "investment" and buy["amount"] < 0
    assert buy["accountPath"] == "Assets:Investment:Northwind:Roth-IRA"
    sell = next(r for r in rows if "market sell" in r["payee"])
    assert sell["kind"] == "investment" and sell["amount"] > 0
    reimbursable = one(narration="Team dinner, reimbursed by Acme")
    assert reimbursable["kind"] == "transfer" and reimbursable["amount"] == -212.4
    assert one(payee="Tokyo Metro")["amount"] == -1.41  # JPY leg valued in USD


def test_spend_by_month_matches_the_summary(snap):
    months = snap["activity"]["spendByMonth"]
    assert len(months) == 13
    assert months[-1]["month"] == "2030-06"
    assert months[-1]["total"] == snap["spend"]["mtd"]
    assert sum(c["value"] for c in months[-1]["categories"]) == pytest.approx(
        months[-1]["total"], abs=0.05
    )
    assert [m["month"] for m in months] == [
        m["month"] for m in snap["spend"]["byMonth"]
    ]
    # Day-to-day spending leaves out the configured category (Home).
    home = next(c["value"] for c in snap["spend"]["categories"] if c["name"] == "Home")
    assert snap["spend"]["flex"]["mtd"] == pytest.approx(
        snap["spend"]["mtd"] - home, abs=1
    )


def test_plan_events_run_a_cash_balance(snap):
    plan = snap["plan"]
    events = plan["events"]
    assert plan["horizon"] == "2030-07-31"
    assert plan["startCash"] == snap["cash"]["total"]
    assert events == sorted(events, key=lambda e: e["date"])
    balance = plan["startCash"]
    for e in events:
        balance += e["amount"]
        assert e["balance"] == pytest.approx(balance, abs=0.01)
        assert snap["asOf"] < e["date"] <= plan["horizon"]
    assert {e["kind"] for e in events} == {"pay", "bill", "card", "info"}
    # The two deposit splits of one payday merge into one paycheck.
    assert plan["nextPay"]["label"] == "Paycheck"
    assert plan["nextPay"]["amount"] == 2600.0
    assert plan["nextPay"] == next(e for e in events if e["label"] == "Paycheck")
    assert plan["low"]["balance"] == min(e["balance"] for e in events)
    labels = {e["label"] for e in events}
    assert {"Car loan", "Commuter benefit", "Summit Rewards", "Rent"} <= labels
    assert "Ember" not in labels  # a card in credit has nothing due
    assert plan["goals"] == snap["goals"]
    assert plan["keyDates"][0]["label"] == "Renters insurance renews"


def test_goals_measure_what_the_config_asks(snap):
    goals = {g["id"]: g for g in snap["goals"]}
    assert list(goals) == ["ef", "ira", "k401", "bonus"]
    assert goals["ef"]["value"] == snap["float"]["reserve"]
    assert goals["ira"]["value"] == 3000.0  # six monthly contributions in 2030
    assert goals["ira"]["progress"] == 0.4
    assert goals["ira"]["remaining"] == 4500.0
    assert goals["k401"]["value"] == 4400.0  # eleven paychecks at 400
    assert 0 < goals["bonus"]["value"] < goals["bonus"]["target"]


def test_no_config_still_builds(entries):
    snap = build_snapshot(entries, MobileConfig(), mobile_ledger.ASOF)
    assert snap["goals"] == [] and snap["keyDates"] == [] and snap["loan"] is None
    assert snap["plan"]["nextPay"] is None
    assert snap["netWorth"]["value"] != 0
    assert snap["plan"]["horizon"] == "2030-08-07"  # 50 days out by default


def test_horizon_falls_back_to_days_once_until_has_passed():
    cfg = parse_config({"plan": {"horizon": {"until": "2030-01-31", "days": 10}}})
    assert cfg.horizon(mobile_ledger.ASOF).isoformat() == "2030-06-28"


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"gaols": []}, "unknown key"),
        (
            {
                "goals": [
                    {
                        "id": "x",
                        "name": "X",
                        "target": 1,
                        "measure": {"type": "vibes", "account": "A"},
                    }
                ]
            },
            "type must be",
        ),
        (
            {
                "goals": [
                    {
                        "id": "x",
                        "name": "X",
                        "measure": {"type": "balance", "account": "A"},
                    }
                ]
            },
            "missing 'target'",
        ),
        (
            {
                "goals": [
                    {
                        "id": "ef",
                        "name": "X",
                        "target": 1,
                        "measure": {"type": "balance", "account": "A"},
                    }
                ],
                "emergency_fund": {"account": "A", "target": 1},
            },
            "duplicate id",
        ),
        ({"plan": {"events": [{"label": "X"}]}}, "at least one condition"),
        (
            {
                "investments": {
                    "accounts": [{"prefix": "A", "name": "x", "component": 2}]
                }
            },
            "exactly one",
        ),
        ({"key_dates": [{"date": "soon", "label": "X"}]}, "YYYY-MM-DD"),
    ],
)
def test_config_errors_name_the_problem(doc, message):
    with pytest.raises(MobileConfigError, match=message):
        parse_config(doc)


def test_cli_writes_the_snapshot_into_the_ledger(ledger_dir, monkeypatch, capsys):
    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))
    assert cli.main(["--asof", "2030-06-18"]) == 0
    out = ledger_dir / "mobile" / "snapshot.json"
    snap = json.loads(out.read_text(encoding="utf-8"))
    assert snap["asOf"] == "2030-06-18"
    assert snap["meta"]["generatedAt"].endswith("Z")
    assert str(out) in capsys.readouterr().out


def test_cli_reads_billing_files(ledger_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))
    out = tmp_path / "snapshot.json"
    assert cli.main(["--asof", "2030-06-18", "--out", str(out)]) == 0
    cards = _cards(json.loads(out.read_text(encoding="utf-8")))
    assert cards["Cobalt"]["due"] == "2030-06-26"
    assert cards["Cobalt"]["statement"] == 412.34
    assert cards["Summit"]["due"] == "2030-07-04"


def test_card_uses_latest_closed_statement_for_due_and_amount(snap):
    cobalt = _cards(snap)["Cobalt"]
    assert cobalt["due"] == "2030-06-26"  # the settings alone say 2030-07-09
    assert cobalt["statement"] == 412.34  # the newest of its two statements
    assert cobalt["fundedBy"] == "Harbor"
    assert cobalt["fundedByName"] == "Harbor"
    top = next(c for c in snap["cards"]["accounts"] if c["name"] == "Cobalt")
    assert (top["due"], top["statement"]) == ("2030-06-26", 412.34)
    event = next(e for e in snap["plan"]["events"] if e["label"] == "Cobalt Cash")
    assert event["date"] == "2030-06-26"


def test_voided_statement_falls_back(snap, ledger_dir, entries):
    meadowlark = _cards(snap)["Meadowlark"]
    assert meadowlark["due"] == "2030-07-14"  # nothing left: the settings
    assert meadowlark["statement"] == 195.0
    # With an earlier statement still on record, that one is used instead.
    lines = [
        {
            "account": "Liabilities:Credit:Cobalt",
            "id": "2030-06-01",
            "void": True,
            "source": "manual",
            "capturedAt": "",
        }
    ]
    path = ledger_dir / "statements" / "billing" / "credit" / "Cobalt.jsonl"
    reduced = billing.reduce_lines(
        path.read_text(encoding="utf-8").splitlines()
        + [json.dumps(line) for line in lines]
    )
    assert [s.id for s in reduced] == ["2030-05-01"]
    earlier = build_snapshot(
        entries,
        MobileConfig(),
        dt.date(2030, 5, 20),
        cc_cards=mobile_ledger.cc_cards(),
        statements={"Liabilities:Credit:Cobalt": reduced},
    )
    cobalt = _cards(earlier)["Cobalt"]
    assert (cobalt["due"], cobalt["statement"]) == ("2030-05-26", 301.15)


def test_statement_past_due_never_uses_typed_balance(snap, entries):
    # Juniper's statement was due 06-12, before the as-of date. Until the next
    # one closes nothing is billed: the next due day, and no amount. The
    # statementBalance typed in cc-cards.json (232.25) is frozen since the card
    # got statement records, so it must not come back.
    juniper = _cards(snap)["Juniper"]
    assert juniper["due"] == "2030-06-20"
    assert juniper["statement"] is None
    assert juniper["fundedBy"]
    top = next(c for c in snap["cards"]["accounts"] if c["name"] == "Juniper")
    assert (top["due"], top["statement"]) == ("2030-06-20", None)
    # Without a payment-due day there is no date to predict either.
    bare = build_snapshot(
        entries,
        MobileConfig(),
        mobile_ledger.ASOF,
        cc_cards={},
        statements={
            "Liabilities:Credit:Juniper": [
                _statement("Juniper", "2030-05-18", "64.20", "2030-06-12")
            ]
        },
    )
    juniper = _cards(bare)["Juniper"]
    assert (juniper["due"], juniper["statement"]) == (None, None)


def test_statement_due_on_asof_still_applies(entries):
    snapshot = build_snapshot(
        entries,
        MobileConfig(),
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements={
            "Liabilities:Credit:Juniper": [
                _statement("Juniper", "2030-05-24", "64.20", "2030-06-18")
            ]
        },
    )
    juniper = _cards(snapshot)["Juniper"]
    assert (juniper["due"], juniper["statement"]) == ("2030-06-18", 64.2)


def test_statement_null_due_uses_payment_due_day(snap, entries):
    atlas = _cards(snap)["Atlas"]
    assert atlas["due"] == "2030-06-24"  # first 24th after the 05-28 close
    assert atlas["statement"] == 219.05
    # Without a paymentDueDay there is nothing to predict from.
    bare = build_snapshot(
        entries,
        MobileConfig(),
        mobile_ledger.ASOF,
        statements={
            "Liabilities:Credit:Atlas": [
                _statement("Atlas", "2030-05-28", "219.05", None)
            ]
        },
    )
    assert _cards(bare)["Atlas"]["due"] is None
    assert _cards(bare)["Atlas"]["statement"] is None


def test_statement_after_asof_is_ignored(snap):
    orchard = _cards(snap)["Orchard"]
    assert orchard["due"] == "2030-06-28"
    assert orchard["statement"] == 306.75


def test_statement_without_card_settings(snap):
    driftwood = _cards(snap)["Driftwood"]
    assert driftwood["due"] == "2030-06-28"
    assert driftwood["statement"] == 88.1
    assert driftwood["fundedBy"] == ""
    assert driftwood["fundedByName"] is None
    event = next(e for e in snap["plan"]["events"] if e["label"] == "Driftwood")
    assert event["note"] == "Paid from"


def test_card_without_statements_unchanged(snap, entries):
    cfg = MobileConfig()
    plain = build_snapshot(
        entries, cfg, mobile_ledger.ASOF, cc_cards=mobile_ledger.cc_cards()
    )
    empty = build_snapshot(
        entries,
        cfg,
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements={},
    )
    assert plain == empty
    for name in ("Summit", "Pinnacle", "Ember"):
        with_facts, without = _cards(snap)[name], _cards(plain)[name]
        for key in ("due", "statement", "fundedBy", "value"):
            assert with_facts[key] == without[key]
    assert _cards(snap)["Summit"]["statement"] == 120.5


def test_snapshot_schema_keys_unchanged(snap, entries):
    plain = build_snapshot(
        entries, MobileConfig(), mobile_ledger.ASOF, cc_cards=mobile_ledger.cc_cards()
    )
    assert set(snap) == set(plain)
    for name, row in _cards(snap).items():
        assert set(row) == set(_cards(plain)[name])
    top = {c["name"]: c for c in snap["cards"]["accounts"]}
    plain_top = {c["name"]: c for c in plain["cards"]["accounts"]}
    for name in ("Summit", "Cobalt", "Ember"):
        assert set(top[name]) == set(plain_top[name])
