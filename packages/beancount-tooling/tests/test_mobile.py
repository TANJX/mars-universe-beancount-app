"""Mobile snapshot: built from the synthetic ledger in ``mobile_ledger.py``."""

import datetime as dt
import json
import re
from pathlib import Path

import pytest
import yaml
from beancount import loader
from beancount_tooling import billing
from beancount_tooling.mobile import (
    SCHEMA_VERSION,
    MobileConfig,
    MobileConfigError,
    build_snapshot,
    cli,
    equity,
    leave,
    load_config,
    logos,
    parse_config,
    payees,
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
        logos=logos.load_resolver(ledger_dir / "config" / "ui.yaml"),
        leave=leave.read_leave(ledger_dir),
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


def test_spend_by_month_splits_fixed_from_day_to_day(snap):
    assert snap["spend"]["dayToDayExclude"] == ["Home"]
    months = snap["activity"]["spendByMonth"]
    for m in months:
        home = sum(c["value"] for c in m["categories"] if c["name"] == "Home")
        assert m["fixed"] == pytest.approx(home, abs=0.01)
        assert m["fixed"] + m["dayToDay"] == pytest.approx(m["total"], abs=0.01)
        to_date = m["throughDay"]
        assert to_date["day"] == 18
        assert to_date["fixed"] + to_date["dayToDay"] == pytest.approx(
            to_date["total"], abs=0.01
        )
        assert to_date["total"] <= m["total"] + 0.01
    # The month in progress is its own "through today".
    cur = months[-1]
    assert cur["throughDay"]["total"] == cur["total"]
    assert cur["dayToDay"] == pytest.approx(snap["spend"]["flex"]["mtd"], abs=1)
    # A finished month: rent posts on day 1, so the fixed part is mostly in by
    # day 18, while day-to-day spending is still short of the full month.
    may = months[-2]
    assert may["month"] == "2030-05"
    assert 0 < may["throughDay"]["dayToDay"] < may["dayToDay"]
    assert may["throughDay"]["fixed"] >= 1850


def test_spend_split_without_excluded_categories(entries):
    snap = build_snapshot(entries, MobileConfig(), mobile_ledger.ASOF)
    assert snap["spend"]["dayToDayExclude"] == []
    for m in snap["activity"]["spendByMonth"]:
        assert m["fixed"] == 0
        assert m["dayToDay"] == m["total"]


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
    assert plan["nextPay"]["paycheck"]["net"] == 2600.0
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
    assert event["note"] == "Card payment"
    assert event["fundedBy"] is None and event["fundedByName"] is None


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
    assert set(snap) - {"leave"} == set(plain)
    for name, row in _cards(snap).items():
        assert set(row) == set(_cards(plain)[name])
    top = {c["name"]: c for c in snap["cards"]["accounts"]}
    plain_top = {c["name"]: c for c in plain["cards"]["accounts"]}
    for name in ("Summit", "Cobalt", "Ember"):
        assert set(top[name]) == set(plain_top[name])


# ---- cash exclusion ------------------------------------------------------------


def test_excluded_account_is_not_cash_but_still_net_worth(snap, entries, ledger_dir):
    groups = {g["id"]: g for g in snap["accounts"]["groups"]}
    assert "Commuter" not in {a["name"] for a in snap["cash"]["accounts"]}
    assert all(r["account"] != "Assets:Checking:Commuter" for r in groups["cash"]["accounts"])
    row = next(
        r for r in groups["other"]["accounts"] if r["account"] == "Assets:Checking:Commuter"
    )
    assert row["cashExcluded"] is True
    assert (row["name"], row["displayName"], row["value"]) == (
        "Commuter",
        "Commuter card",
        86.0,
    )
    # Same ledger without the exclusion: 86.00 more cash, the same net worth.
    doc = mobile_ledger.MOBILE_YAML.replace(
        'cash_exclude: ["Assets:Checking:Commuter"]', "cash_exclude: []"
    )
    counted = build_snapshot(
        entries,
        parse_config(yaml.safe_load(doc)),
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
    )
    assert counted["netWorth"]["value"] == snap["netWorth"]["value"]
    assert counted["cash"]["total"] == pytest.approx(snap["cash"]["total"] + 86.0)
    for key in ("afterCards", "spendable"):
        assert counted["float"][key] == pytest.approx(snap["float"][key] + 86.0)
    assert counted["plan"]["startCash"] == pytest.approx(snap["plan"]["startCash"] + 86.0)
    assert counted["netWorth"]["series"][-1]["cash"] == pytest.approx(
        snap["netWorth"]["series"][-1]["cash"] + 86, abs=1
    )
    assert snap["plan"]["startCash"] == snap["cash"]["total"]


def test_deposit_into_excluded_account_moves_no_projected_cash(snap):
    events = snap["plan"]["events"]
    i, e = next((i, e) for i, e in enumerate(events) if e["label"] == "Commuter benefit")
    assert (e["kind"], e["amount"], e["nonCashAmount"]) == ("info", 0.0, 120.0)
    assert e["account"] == "Assets:Checking:Commuter"
    assert e["note"] == "Commuter card, not counted as cash"
    assert e["balance"] == events[i - 1]["balance"]
    raw = next(u for u in snap["upcoming"] if u["note"] == "Commuter benefit load")
    assert (raw["amount"], raw["nonCashAmount"], raw["kind"]) == (0.0, 120.0, "income")
    assert all("nonCashAmount" not in u for u in snap["upcoming"] if u is not raw)


# ---- paycheck breakdown --------------------------------------------------------


def test_paycheck_carries_its_contributions(snap):
    pays = [e for e in snap["plan"]["events"] if e["label"] == "Paycheck"]
    assert [e["date"] for e in pays] == ["2030-06-28", "2030-07-13", "2030-07-28"]
    first = pays[0]["paycheck"]
    assert first["net"] == pays[0]["amount"] == 2600.0
    # The 401k leg of the same entry, and the benefit deposit that lands ten
    # days later (before the next payday) belong to this paycheck.
    assert first["contributions"] == [
        {
            "name": "401k",
            "amount": 400.0,
            "account": "Assets:Investment:Meridian:401k",
            "date": "2030-06-28",
        },
        {
            "name": "Commuter benefit",
            "amount": 120.0,
            "account": "Assets:Checking:Commuter",
            "date": "2030-07-08",
        },
    ]
    assert first["contributionsTotal"] == 520.0
    assert first["total"] == 3120.0
    assert pays[1]["paycheck"]["contributionsTotal"] == 400.0
    assert pays[1]["paycheck"]["total"] == 3000.0
    assert snap["plan"]["nextPay"]["paycheck"] == first
    assert all("paycheck" not in e for e in snap["plan"]["events"] if e not in pays)


# ---- equity --------------------------------------------------------------------


def _equity_cfg():
    return load_config_text(mobile_ledger.MOBILE_YAML).equity


def load_config_text(text):
    return parse_config(yaml.safe_load(text))


def test_two_half_grant_vests_like_the_real_one():
    # Same structure as the grant this was written for: 28 monthly tranches of
    # the first half are due, the second half is 4 months into its cliff.
    grant_a, grant_b = _equity_cfg().grants
    day = dt.date(2030, 8, 2)
    assert equity.vested_shares(grant_a, day) == 5833  # 10000 x 28/48 = 5833.33
    assert equity.vested_shares(grant_b, day) == 1145  # 5000 x 11/48 = 1145.83
    # First-half cliff: nothing the day before, a quarter of the half on it.
    assert equity.vested_shares(grant_a, dt.date(2029, 3, 9)) == 0
    assert equity.vested_shares(grant_a, dt.date(2029, 3, 10)) == 2500
    # Second-half cliff two years later, on top of the first half's 36/48.
    assert equity.vested_shares(grant_a, dt.date(2031, 3, 9)) == 7291
    assert equity.vested_shares(grant_a, dt.date(2031, 3, 10)) == 7500 + 2500
    assert equity.vested_shares(grant_a, dt.date(2032, 3, 10)) == 10000 + 5000
    assert equity.vested_shares(grant_a, dt.date(2034, 3, 10)) == 20000
    assert equity.fully_vested(grant_a) == dt.date(2034, 3, 10)
    assert equity.next_vest(grant_a, dt.date(2034, 3, 10)) is None
    # No cliff: the first tranche a month after the start.
    assert equity.vested_shares(grant_b, dt.date(2029, 9, 30)) == 0
    assert equity.vested_shares(grant_b, dt.date(2029, 10, 1)) == 104


def test_equity_section_values_the_grants(snap):
    eq = snap["equity"]
    a, b = eq["grants"]
    assert (a["vested"], a["unvested"]) == (5625, 14375)  # 27 tranches, half one
    assert (b["vested"], b["unvested"]) == (937, 4063)  # 9 x 104.17 = 937.5
    assert (eq["shares"], eq["vested"], eq["unvested"]) == (25000, 6562, 18438)
    assert eq["vestedFraction"] == 0.2625
    assert a["exerciseCostVested"] == 1125.0 and b["exerciseCostVested"] == 468.5
    assert eq["exerciseCostVested"] == 1593.5
    assert eq["exerciseCost"] == 6500.0
    # Net of strike at the common FMV: 5625 x 1.80 + 937 x 1.50.
    assert eq["vestedValue"] == 11530.5
    assert eq["totalValue"] == 43500.0
    assert eq["vestedValuePreferred"] == pytest.approx(5625 * 12.3 + 937 * 12.0)
    assert eq["totalValuePreferred"] == 306000.0
    assert a["nextVest"] == {"date": "2030-07-10", "shares": 208}
    assert eq["nextVest"] == {
        "date": "2030-07-01",
        "shares": 104,
        "grants": [{"id": "OPT-2", "shares": 104}],
    }
    assert (a["fullyVested"], b["fullyVested"]) == ("2034-03-10", "2033-09-01")
    assert eq["fullyVested"] == "2034-03-10"
    assert (eq["fmv"], eq["fmvDate"], eq["preferredPrice"]) == (2.0, "2030-05-01", 12.5)


def test_equity_stays_out_of_net_worth(snap, entries, ledger_dir):
    text = mobile_ledger.MOBILE_YAML.split("equity:")[0]
    without = build_snapshot(
        entries,
        load_config_text(text),
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
    )
    assert without["equity"] is None
    assert without["netWorth"] == snap["netWorth"]
    assert without["accounts"] == snap["accounts"]


def test_next_vest_is_a_computed_key_date(snap, entries, ledger_dir):
    vest = {"date": "2030-07-01", "label": "Options vest", "note": "OPT-2, +104 shares"}
    assert snap["equity"]["nextVest"]["shares"] == 104
    assert vest in snap["keyDates"]
    assert snap["keyDates"] == snap["plan"]["keyDates"]
    dates = [k["date"] for k in snap["keyDates"]]
    assert dates == sorted(dates)
    # Inside the horizon it is also a plan event: information only, no money.
    events = snap["plan"]["events"]
    i = next(i for i, e in enumerate(events) if e["label"] == "Options vest")
    assert events[i]["kind"] == "info" and events[i]["amount"] == 0.0
    assert events[i]["note"] == "OPT-2, +104 shares"
    assert events[i]["balance"] == events[i - 1]["balance"]

    without = build_snapshot(
        entries,
        load_config_text(mobile_ledger.MOBILE_YAML.split("equity:")[0]),
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
    )
    assert all(k["label"] != "Options vest" for k in without["keyDates"])
    assert without["keyDates"] == [k for k in snap["keyDates"] if k != vest]
    for key in ("netWorth", "cash", "float"):
        assert without[key] == snap[key]
    assert without["plan"]["low"] == snap["plan"]["low"]
    strip = lambda rows: [(e["date"], e["label"], e["amount"], e["balance"]) for e in rows]
    assert strip(without["plan"]["events"]) == strip(
        [e for e in events if e["label"] != "Options vest"]
    )


def test_vest_key_date_names_every_grant_vesting_that_day():
    section = {
        "nextVest": {
            "date": "2030-07-01",
            "shares": 1312,
            "grants": [{"id": "OPT-1", "shares": 1208}, {"id": "OPT-2", "shares": 104}],
        }
    }
    assert equity.vest_key_date(section) == {
        "date": "2030-07-01",
        "label": "Options vest",
        "note": "OPT-1 and OPT-2, +1,312 shares",
    }
    one = {"nextVest": {"date": "2030-07-01", "shares": 1, "grants": [{"id": "OPT-2", "shares": 1}]}}
    assert equity.vest_key_date(one)["note"] == "OPT-2, +1 share"
    assert equity.vest_key_date(None) is None
    assert equity.vest_key_date({"nextVest": None}) is None


@pytest.mark.parametrize(
    "grant, message",
    [
        ({"id": "g", "shares": 100, "strike": 1}, "at least one schedule"),
        (
            {
                "id": "g",
                "shares": 100,
                "strike": 1,
                "vesting": [{"shares": 90, "start": "2030-01-01", "months": 48}],
            },
            "do not add up",
        ),
        (
            {
                "id": "g",
                "shares": 100,
                "strike": 1,
                "vesting": [
                    {
                        "shares": 100,
                        "start": "2030-01-01",
                        "months": 12,
                        "cliff_months": 13,
                    }
                ],
            },
            "longer than",
        ),
    ],
)
def test_equity_config_errors(grant, message):
    with pytest.raises(MobileConfigError, match=message):
        parse_config({"equity": {"grants": [grant]}})


# ---- merchant logos ------------------------------------------------------------


def test_rows_carry_a_logo_domain_only_when_one_resolves(snap):
    rows = snap["activity"]["transactions"]

    def one(**match):
        return next(r for r in rows if all(r.get(k) == v for k, v in match.items()))

    assert one(payee="Greenleaf Market")["logoDomain"] == "greenleaf.example"
    # A registry merchant without a domain, and an unknown payee: no key at all.
    assert "logoDomain" not in one(payee="Paper Lantern Books")
    assert "logoDomain" not in one(payee="Corner Pharmacy")
    # Income takes the income account's merchant, transfers the other side's.
    assert one(rawPayee="Interest Payment")["logoDomain"] == "harborbank.example"
    assert one(rawPayee="Transfer to savings")["logoDomain"] == "harborbank.example"
    # Investment rows and pure rebates show a glyph on the web: no logo here.
    assert all("logoDomain" not in r for r in rows if r["kind"] == "investment")
    assert "logoDomain" not in one(narration="Statement credit")
    recent = {r["payee"]: r for r in snap["recent"]}
    assert recent["Blue Door Bistro"]["logoDomain"] == "bluedoor.example"
    assert "logoDomain" not in recent["Harvest Lane Co-op"]


def test_logo_url_template_needs_a_token(entries):
    resolver = logos.build_resolver({})
    bare = build_snapshot(entries, MobileConfig(), mobile_ledger.ASOF, logos=resolver)
    assert bare["logos"] is None
    with_token = build_snapshot(
        entries, MobileConfig(), mobile_ledger.ASOF, logos=resolver, logo_token="pk_test"
    )
    assert with_token["logos"] == {
        "provider": "logo.dev",
        "urlTemplate": "https://img.logo.dev/{domain}?token=pk_test&size={size}&format=png&retina=true",
    }


def test_payee_matching_follows_the_web_rules():
    r = logos.build_resolver(
        {"merchants": {"Corner Cafe": {"domain": "cafe.example", "aliases": ["Cnr Cafe"]}}}
    )
    assert r.match("Sq *Corner Cafe 10001").domain == "cafe.example"  # rail + ZIP
    assert r.match("CNR CAFE #1234").domain == "cafe.example"  # alias, terminal id
    assert r.match("Tm *Some Arena Show").name == "Ticketmaster"
    assert r.match("Public Service Des:pseg Id:123 Indn:Someone").name == "PSEG"
    # A brand must start on a word boundary, and a short one must be a whole word.
    assert r.match("Pineapple Express Diner") is None
    assert r.match("Citizen Watch Repair") is None
    # `<brand>*<detail>`: a known prefix is the brand, not a name inside the detail.
    assert r.match("Uber.Com*microsoft Th").name == "Uber"
    assert r.domain("Unknown", accounts=("Assets:Checking:Nowhere",)) is None


def test_bundled_merchants_match_the_web_defaults():
    source = (
        Path(__file__).resolve().parents[3]
        / "apps/web/lib/config/defaults/merchants.ts"
    )
    if not source.is_file():
        pytest.skip("web app sources not present")
    body = source.read_text(encoding="utf-8").split("MERCHANT_DEFAULTS")[-1]
    web = []
    for block in re.findall(r"\{(.*?)\}", body, re.S):
        name = re.search(r'name:\s*"([^"]+)"', block)
        if not name:
            continue
        domain = re.search(r'domain:\s*"([^"]+)"', block)
        aliases = re.search(r"aliases:\s*\[(.*?)\]", block, re.S)
        web.append(
            (
                name.group(1),
                domain.group(1) if domain else None,
                tuple(re.findall(r'"([^"]+)"', aliases.group(1))) if aliases else (),
            )
        )
    assert tuple(web) == logos.DEFAULT_MERCHANTS


def test_cli_reads_the_logo_token_without_printing_it(
    ledger_dir, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))
    monkeypatch.delenv(cli.LOGO_TOKEN_VAR, raising=False)
    env = tmp_path / "web.env"
    env.write_text(f'OTHER=1\n{cli.LOGO_TOKEN_VAR}="pk_from_file"\n', encoding="utf-8")
    out = tmp_path / "snapshot.json"
    assert cli.main(["--asof", "2030-06-18", "--out", str(out), "--web-env", str(env)]) == 0
    snapshot = json.loads(out.read_text(encoding="utf-8"))
    assert "token=pk_from_file&" in snapshot["logos"]["urlTemplate"]
    printed = capsys.readouterr()
    assert "pk_from_file" not in printed.out + printed.err
    # No token anywhere: domains only.
    assert cli.main(["--asof", "2030-06-18", "--out", str(out)]) == 0
    snapshot = json.loads(out.read_text(encoding="utf-8"))
    assert snapshot["logos"] is None
    assert any("logoDomain" in r for r in snapshot["activity"]["transactions"])


# ---- card events ---------------------------------------------------------------


def test_card_event_uses_the_open_statement(snap):
    events = [e for e in snap["plan"]["events"] if e["kind"] == "card"]

    def of(card):
        return [e for e in events if e["account"] == f"Liabilities:Credit:{card}"]

    driftwood = _cards(snap)["Driftwood"]
    assert (driftwood["statementId"], driftwood["statementRemaining"]) == (
        "2030-06-03",
        88.1,
    )
    billed, later = of("Driftwood")
    # The statement on its due date, then what was charged since a month on.
    assert (billed["date"], billed["amount"], billed["basis"]) == (
        "2030-06-28",
        -88.1,
        "statement",
    )
    assert billed["statementId"] == "2030-06-03"
    assert (later["date"], later["basis"]) == ("2030-07-28", "unbilled")
    assert "statementId" not in later
    assert billed["amount"] + later["amount"] == pytest.approx(-driftwood["value"])
    # Never more than is owed now (credits since the statement closed).
    cobalt = _cards(snap)["Cobalt"]
    assert cobalt["statementRemaining"] == 412.34 > cobalt["value"]
    (only,) = of("Cobalt")
    assert (only["amount"], only["basis"]) == (-cobalt["value"], "statement")
    assert only["note"] == "Card payment from Harbor"
    assert (only["fundedBy"], only["fundedByName"]) == ("Harbor", "Harbor")
    # No statement on record: the whole balance on the next due day.
    (summit,) = of("Summit")
    assert (summit["basis"], summit["amount"]) == (
        "balance",
        -_cards(snap)["Summit"]["value"],
    )
    assert "statementId" not in summit
    assert _cards(snap)["Summit"]["statementRemaining"] is None


def test_statement_payments_since_close_reduce_what_is_due(entries):
    # Cobalt's 05-01 statement (301.15) is open on 05-25, three days after the
    # monthly payment landed on the card.
    snapshot = build_snapshot(
        entries,
        MobileConfig(),
        dt.date(2030, 5, 25),
        cc_cards=mobile_ledger.cc_cards(),
        statements={
            "Liabilities:Credit:Cobalt": [
                _statement("Cobalt", "2030-05-01", "301.15", "2030-05-26")
            ]
        },
    )
    cobalt = _cards(snapshot)["Cobalt"]
    paid = sum(
        r["amount"]
        for r in snapshot["activity"]["transactions"]
        if r["kind"] == "card payment"
        and r["account"] == "Cobalt"
        and r["date"] > "2030-05-01"
    )
    assert paid > 0
    assert cobalt["statement"] == 301.15
    assert cobalt["statementRemaining"] == pytest.approx(max(301.15 - paid, 0), abs=0.01)


def test_expected_statement_dates_the_unbilled_charges(snap, entries, ledger_dir):
    cobalt = _cards(snap)["Cobalt"]
    planned = build_snapshot(
        entries,
        load_config(ledger_dir / "config" / "mobile.yaml"),
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
        expected={
            "Liabilities:Credit:Cobalt": {
                "id": "2030-07-01",
                "dueDate": "2030-07-24",
                "estimatedBalance": "150.00",
            },
            # Older than the statement on record: ignored.
            "Liabilities:Credit:Atlas": {"id": "2030-05-01", "dueDate": "2030-07-01"},
        },
    )
    events = [
        e
        for e in planned["plan"]["events"]
        if e.get("account") == "Liabilities:Credit:Cobalt"
    ]
    assert [(e["date"], e["amount"], e["basis"]) for e in events] == [
        ("2030-06-26", -cobalt["value"], "statement"),
        ("2030-07-24", -150.0, "expected"),
    ]
    assert events[1]["statementId"] == "2030-07-01"
    atlas = [
        e["basis"]
        for e in planned["plan"]["events"]
        if e.get("account") == "Liabilities:Credit:Atlas"
    ]
    assert "expected" not in atlas


# ---- payee display names ---------------------------------------------------------

Ctx = payees.RowContext


def _show(payee, narration="", **ctx):
    d = payees.display(payee, narration, Ctx(**ctx) if ctx else None)
    return d.payee, d.narration


@pytest.mark.parametrize(
    "raw, ctx, expected",
    [
        # NACHA: company and description; ids, Indn and Co Id dropped.
        (
            "C123456 Globex Corp Des:payroll Id:p0a1b2c3d4 Indn:Doe Jane Co Id:1234567890 PPD",
            {"kind": "income"},
            ("Globex Corp", "Payroll"),
        ),
        (
            "GLOBEX CORP DES:CASHREWARD ID:X1 INDN:DOE JANE CO ID:1234567890 PPD",
            {"kind": "income"},
            ("Globex Corp", "Cash reward"),
        ),
        (
            "Sample Pay Des:cashout Id:9876543210 Indn:Jane Doe Co Id:5555555555 Web",
            {"kind": "transfer"},
            ("Sample Pay", "Cash-out"),
        ),
        # A numeric description says nothing.
        (
            "Summit Card Des:4455667788 Id: Indn:Jane Doe Co Id:1111111111 PPD",
            {"kind": "transfer", "amount": -50},
            ("Summit Card", ""),
        ),
        # Zelle: the counterparty is the title, the memo fills the narration.
        (
            "Zelle Payment From Jordan Avery for Dinner; Conf# Q1w2e3r4t",
            {"kind": "transfer"},
            ("Jordan Avery", "Dinner"),
        ),
        (
            "Zelle Payment to Riley Brooks Conf# Abc123xyz",
            {"kind": "transfer"},
            ("Riley Brooks", ""),
        ),
        (
            "TD Zelle Received 123abc456def Zelle Riley Brooks",
            {"kind": "transfer"},
            ("Riley Brooks", ""),
        ),
        # Card-side payment wording: structure names it.
        ("Payment From CHK 1234 Conf#m01234567890", {"kind": "card payment"}, ("Card payment", "")),
        ("Autopay Payment - Thank You", {"kind": "card payment"}, ("Card payment", "Autopay")),
        (
            "Online/Mobile Payment Conf#m09876543210",
            {"kind": "card payment"},
            ("Card payment", ""),
        ),
        # Own-account transfer wording.
        ("Internal Transfer to Personal Savings", {"kind": "transfer"}, ("Transfer to savings", "")),
        ("ACH Deposit from Example Bank", {"kind": "transfer"}, ("Transfer from Example Bank", "")),
        (
            "ACH Online transfer to EXAMPLE BANK, N.A. ********9999",
            {"kind": "transfer"},
            ("Transfer to Example Bank", ""),
        ),
        ("ACH Withdrawal to Account", {"kind": "transfer", "amount": -5}, ("Transfer out", "")),
        (
            "Online Scheduled Payment to Acct# 1111 Confirmation# 2222222222",
            {"kind": "transfer", "amount": -90, "counterpart": "Summit Rewards"},
            ("Transfer to Summit Rewards", ""),
        ),
        (
            "Contribution to Roth IRA from SAMPLE CHECKING - 1234",
            {"kind": "investment"},
            ("Roth IRA contribution", "From Sample Checking"),
        ),
        ("Summit Card Epayment Ach PMT", {"kind": "transfer"}, ("Summit Card", "Payment")),
        # Interest wording, from the row's category.
        ("Iod Interest Paid", {"kind": "income", "category": "Interest"}, ("Interest", "")),
        ("Interest on cash balance", {"kind": "income", "category": "Interest"}, ("Interest", "")),
        # ATM: the location becomes the narration.
        (
            "Examplebank Atm 01/02 #000001234 Withdrwl Main St and First Springfield Il",
            {"kind": "transfer"},
            ("ATM withdrawal", "Main St and First Springfield IL"),
        ),
        ("Offer:corner bakery", {"kind": "income"}, ("Corner Bakery", "Card offer")),
        # Re-casing shouting text, short consonant-only words stay upper case.
        ("SAKURA RAMEN HOUSE", {"kind": "expense"}, ("Sakura Ramen House", "")),
    ],
)
def test_payee_display_families(raw, ctx, expected):
    assert _show(raw, **ctx) == expected


def test_zelle_with_stray_quotes():
    raw = 'Zelle Payment From Jordan Avery for Pasta"; Conf# Wq12er34t"'
    assert _show(raw, kind="transfer") == ("Jordan Avery", "Pasta")
    # The row's own narration beats the bank memo.
    assert _show(raw, "Pasta night, my share", kind="transfer") == (
        "Jordan Avery",
        "Pasta night, my share",
    )


@pytest.mark.parametrize(
    "payee, narration, ctx",
    [
        ("Blue Door Bistro", "Team dinner", {"kind": "expense"}),
        ("Joe's Pizza", "", {"kind": "expense"}),
        ("IKEA", "", {"kind": "expense"}),
        # Merchant names that look like bank wording stay put on expense rows.
        ("Harbor Light Payment", "", {"kind": "expense"}),
        ("Transfer Station Cafe", "", {"kind": "expense"}),
        ("Greenleaf Market", "", {}),
        ("Dividend from Total Market ETF", "", {"kind": "income", "category": "Dividend"}),
        ("", "", {"kind": "transfer"}),
        ("", "Opening balances", {"kind": "transfer"}),
    ],
)
def test_clean_and_empty_payees_pass_through(payee, narration, ctx):
    d = payees.display(payee, narration, Ctx(**ctx) if ctx else None)
    assert (d.payee, d.narration, d.changed) == (payee, narration, False)


def test_personal_labels_win_and_only_fill_an_empty_narration():
    labels = (
        payees.PayeeLabel(re.compile(r"^C\d+ Globex\b", re.I), "Globex", "Payroll"),
        payees.PayeeLabel(re.compile(r"^Zelle Payment From J Avery\b", re.I), "Jordan"),
    )
    raw = "C123456 GLOBEX PAYROLL"
    assert payees.display(raw, "", Ctx(kind="income"), labels).payee == "Globex"
    assert payees.display(raw, "", Ctx(kind="income"), labels).narration == "Payroll"
    assert payees.display(raw, "June bonus", None, labels).narration == "June bonus"
    # A label without a narration keeps the generic memo.
    d = payees.display("Zelle Payment From J Avery for Lunch; Conf# X1", "", None, labels)
    assert (d.payee, d.narration) == ("Jordan", "Lunch")
    assert d.raw == "Zelle Payment From J Avery for Lunch; Conf# X1"


def test_title_and_narration_do_not_repeat():
    labels = (payees.PayeeLabel(re.compile("^Summit CCB"), "Summit Card", "Card payment"),)
    d = payees.display("Summit CCB Payment", "Summit Card payment", None, labels)
    assert (d.payee, d.narration) == ("Summit Card", "Payment")
    d = payees.display("Summit CCB Payment", "summit card", None, labels)
    assert (d.payee, d.narration) == ("Summit Card", "")
    d = payees.display("Summit CCB Payment", "Summit Card \u2014 June", None, labels)
    assert d.narration == "June"


def test_payee_labels_config():
    cfg = load_config_text(
        'payees:\n  - { match: "^Acme\\\\b", title: "Acme", narration: "Payroll" }\n'
    )
    assert cfg.payees[0].title == "Acme" and cfg.payees[0].pattern.search("ACME PAYROLL")
    with pytest.raises(MobileConfigError, match="not a valid pattern"):
        parse_config({"payees": [{"match": "([", "title": "x"}]})
    with pytest.raises(MobileConfigError, match="missing 'title'"):
        parse_config({"payees": [{"match": "x"}]})
    with pytest.raises(MobileConfigError, match="unknown key"):
        parse_config({"payees": [{"match": "x", "title": "y", "kind": "z"}]})


def test_sample_snapshot_shows_display_names(snap):
    rows = snap["activity"]["transactions"]
    by_raw = {r["rawPayee"]: r for r in rows if "rawPayee" in r}
    zelle = next(r for k, r in by_raw.items() if k.startswith("Zelle Payment From Jordan"))
    assert (zelle["payee"], zelle["narration"]) == ("Jordan Avery", "Dinner")
    acme = next(r for k, r in by_raw.items() if k.startswith("Acme Corp Des:expense"))
    assert (acme["payee"], acme["narration"]) == ("Acme Corp", "Expense reimbursement")
    reward = next(r for k, r in by_raw.items() if k.startswith("HARBOR BANK DES:"))
    assert (reward["payee"], reward["narration"]) == ("Harbor Bank", "Cash reward")
    assert any(r["payee"] == "Card payment" for r in rows if r["kind"] == "card payment")
    assert any(r["payee"] == "ATM withdrawal" for r in rows)
    # Rows the layer leaves alone carry no rawPayee.
    assert all("rawPayee" not in r for r in rows if r["payee"] == "Greenleaf Market")


def test_payee_cleanup_changes_only_display_text(ledger_dir, entries, snap):
    cfg = load_config(ledger_dir / "config" / "mobile.yaml")
    raw = build_snapshot(
        entries,
        cfg,
        mobile_ledger.ASOF,
        cc_cards=mobile_ledger.cc_cards(),
        statements=billing.read_all(ledger_dir / "statements"),
        logos=logos.load_resolver(ledger_dir / "config" / "ui.yaml"),
        clean_payees=False,
        leave=leave.read_leave(ledger_dir),
    )
    on, off = snap["activity"]["transactions"], raw["activity"]["transactions"]
    assert any("rawPayee" in r for r in on)
    assert all("rawPayee" not in r for r in off)
    keys = ("id", "date", "kind", "category", "subcategory", "amount", "account", "accountPath")
    for a, b in zip(on, off, strict=True):
        assert [a.get(k) for k in keys] == [b.get(k) for k in keys]
        assert a.get("logoDomain") == b.get("logoDomain")
        assert a.get("rawPayee", a["payee"]) == b["payee"]

    def strip(s):
        s = json.loads(json.dumps(s))
        for r in s["activity"]["transactions"]:
            for k in ("payee", "narration", "rawPayee"):
                r.pop(k, None)
        for r in s["recent"]:
            for k in ("payee", "note", "rawPayee"):
                r.pop(k, None)
        for r in s["upcoming"]:
            for k in ("label", "note", "rawLabel"):
                r.pop(k, None)
        return s

    assert strip(snap) == strip(raw)


# ---- leave ---------------------------------------------------------------------


def test_leave_section_reads_the_newest_stub(snap):
    lv = snap["leave"]
    assert lv["unit"] == "days"
    # The corrected line for the 06-14 stub wins; the 06-28 stub is after as-of.
    assert lv["lastStub"] == {"date": "2030-06-14", "periodEnd": "2030-06-15"}
    assert lv["asOf"] == "2030-06-15"
    assert lv["pto"]["balance"] == 0.48
    assert lv["sick"]["balance"] == 0  # zero is a balance, not a missing one
    # Calendar 2030 through as-of, half days included; the 07-01 booking is not taken.
    assert lv["pto"]["usedThisYear"] == 11
    assert lv["sick"]["usedThisYear"] == 2
    assert lv["pto"]["accrualPerMonth"] == pytest.approx(0.0383 * 261 / 12, abs=1e-4)
    assert lv["pto"]["balanceCap"] == 10


def test_leave_history_converts_hours_and_skips_blank_cells(snap):
    hist = snap["leave"]["history"]
    dates = [h["date"] for h in hist]
    assert dates == sorted(dates) and len(dates) == len(set(dates))
    assert hist[0] == {"date": "2028-04-14", "pto": 0.383, "sick": 0.19}  # from hours
    assert "2028-09-15" not in dates  # PTO cell left blank on that stub
    assert dates[-1] == "2030-06-14" and hist[-1]["pto"] == 0.48
    assert "2030-06-28" not in dates


def test_leave_projection_runs_through_next_year(snap):
    lv = snap["leave"]
    proj = lv["projection"]
    assert proj[0]["date"] == "2030-06-30" and proj[-1]["date"] == "2031-12-31"
    assert len(proj) == 19  # every month end
    assert all(p["pto"] <= 10 for p in proj)
    # The tenure step: 13 a year from the 3-year anniversary.
    assert lv["pto"]["rateChange"] == {"date": "2031-04-03", "accrualPerYear": 13}
    assert lv["pto"]["capDate"] == "2031-05-16"
    by = {p["date"]: p for p in proj}
    assert by["2031-05-31"]["pto"] == 10
    # Sick lapses on Dec 31 (no carryover), resets to 5 and, frontloaded, stays.
    assert lv["sick"]["resetsOn"] == "2031-01-01" and lv["sick"]["resetTo"] == 5
    assert lv["sick"]["lapsesOnReset"] == by["2030-12-31"]["sick"]
    assert 0 < lv["sick"]["lapsesOnReset"] < 5
    assert {p["sick"] for p in proj if p["date"] >= "2031"} == {5}


def test_leave_is_left_out_without_config_or_files(entries, ledger_dir, tmp_path):
    files = leave.read_leave(ledger_dir)
    assert "leave" not in build_snapshot(entries, MobileConfig(), mobile_ledger.ASOF, leave=files)
    cfg = load_config(ledger_dir / "config" / "mobile.yaml")
    assert "leave" not in build_snapshot(entries, cfg, mobile_ledger.ASOF)
    assert leave.read_leave(tmp_path) is None
    # Every stub is after the as-of date: nothing to show yet.
    assert leave.build_leave(cfg.leave, files, dt.date(2028, 4, 10)) is None


def test_cli_writes_the_leave_section(ledger_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))
    out = tmp_path / "snapshot.json"
    assert cli.main(["--asof", "2030-06-18", "--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["leave"]["pto"]["balance"] == 0.48


def _stub(pay, pto, sick, *, end=None, unit="days", sick_accrued=0.0):
    return {
        "id": pay,
        "payDate": pay,
        "periodEnd": end or pay,
        "unit": unit,
        "policies": {
            "pto": {"balance": pto, "accrued": 0.0},
            "sick": {"balance": sick, "accrued": sick_accrued},
        },
    }


def _policies(pto=None, sick=None, hire="2020-03-02"):
    return {"hireDate": hire, "policies": {"pto": pto or {}, "sick": sick or {}}}


RATES = parse_config({"leave": {"accrual_per_weekday": {"pto": 0.05, "sick": 0.02}}}).leave


def _by_date(section):
    return {p["date"]: p for p in section["projection"]}


def test_leave_at_the_cap_pauses_accrual():
    files = leave.LeaveFiles(
        stubs=[_stub("2030-03-15", 10.0, 1.0)],
        policies=_policies(pto={"accrualPerYear": 12, "balanceCap": 10}),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 3, 20))
    assert lv["pto"]["capDate"] == "2030-03-15"  # already there
    assert {p["pto"] for p in lv["projection"]} == {10}


def test_leave_cap_reached_later_and_no_cap_at_all():
    files = leave.LeaveFiles(
        stubs=[_stub("2030-03-15", 9.0, 0.0)],
        policies=_policies(pto={"accrualPerYear": 12, "balanceCap": 10}),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 3, 20))
    # 20 weekdays at 0.05 after Fri 03-15: Mon 03-18 to Fri 04-12.
    assert lv["pto"]["capDate"] == "2030-04-12"
    uncapped = leave.LeaveFiles(stubs=[_stub("2030-03-15", 9.0, 0.0)])
    lv = leave.build_leave(RATES, uncapped, dt.date(2030, 3, 20))
    assert lv["pto"]["balanceCap"] is None and lv["pto"]["capDate"] is None
    assert lv["pto"]["rateChange"] is None
    assert lv["sick"]["resetsOn"] is None and lv["sick"]["lapsesOnReset"] is None
    # Mon 03-18 to Fri 03-29: 10 weekdays.
    assert _by_date(lv)["2030-03-31"]["pto"] == pytest.approx(9.0 + 0.05 * 10)


def test_leave_cap_beyond_the_projection_is_still_dated():
    files = leave.LeaveFiles(
        stubs=[_stub("2030-03-15", 0.0, 0.0)],
        policies=_policies(pto={"accrualPerYear": 12, "balanceCap": 40}),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 3, 20))
    assert lv["projection"][-1]["date"] == "2031-12-31"
    assert lv["projection"][-1]["pto"] < 40
    assert lv["pto"]["capDate"] > "2031-12-31"


def test_leave_rate_steps_up_at_the_tenure_anniversary():
    files = leave.LeaveFiles(
        stubs=[_stub("2030-12-31", 1.0, 0.0)],
        policies=_policies(
            pto={
                "accrualPerYear": 12,
                "accrualPerYearFrom": [{"tenureYears": 5, "days": 15}],
                "balanceCap": 99,
            }
        ),
    )
    lv = leave.build_leave(RATES, files, dt.date(2031, 1, 2))
    # Hired 2020-03-02: the 5-year step is in the past, so 15 a year is today's
    # rate and there is no step ahead.
    assert lv["pto"]["rateChange"] is None
    files = leave.LeaveFiles(
        stubs=[_stub("2030-12-31", 1.0, 0.0)],
        policies=_policies(
            pto={
                "accrualPerYear": 12,
                "accrualPerYearFrom": [{"tenureYears": 3, "days": 15}],
            },
            hire="2028-03-01",
        ),
    )
    lv = leave.build_leave(RATES, files, dt.date(2031, 1, 2))
    assert lv["pto"]["rateChange"] == {"date": "2031-03-01", "accrualPerYear": 15}
    by = _by_date(lv)
    feb = by["2031-02-28"]["pto"] - by["2031-01-31"]["pto"]  # 20 weekdays
    apr = by["2031-04-30"]["pto"] - by["2031-03-31"]["pto"]  # 22 weekdays
    assert feb == pytest.approx(20 * 0.05)
    assert apr == pytest.approx(22 * 0.05 * 15 / 12)


def test_leave_sick_resets_across_new_year():
    sick = {
        "cycle": "calendar",
        "resetTo": 5,
        "carryoverCap": 1,
        "annualAccrualCap": 5,
        "balanceCap": 8,
    }
    files = leave.LeaveFiles(
        stubs=[_stub("2030-12-15", 0.0, 3.0, sick_accrued=4.9)],
        policies=_policies(sick=sick),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 12, 20))
    by = _by_date(lv)
    # Only 0.1 of the year's 5 days was left to accrue.
    assert by["2030-12-31"]["sick"] == pytest.approx(3.1)
    assert lv["sick"]["resetsOn"] == "2031-01-01"
    assert lv["sick"]["lapsesOnReset"] == pytest.approx(2.1)  # 1 carries over
    # 1 kept + 5, then accrual starts again, up to the balance cap of 8.
    assert by["2031-01-31"]["sick"] == pytest.approx(6 + 23 * 0.02)
    assert max(p["sick"] for p in lv["projection"]) == 8
    # Frontloaded from the new year: the reset is the grant, nothing accrues.
    files = leave.LeaveFiles(
        stubs=[_stub("2030-12-15", 0.0, 3.0, sick_accrued=4.9)],
        policies=_policies(sick={**sick, "carryoverCap": 0, "frontloadedFrom": "2031-01-01"}),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 12, 20))
    assert {p["sick"] for p in lv["projection"] if p["date"] >= "2031"} == {5}
    assert lv["sick"]["lapsesOnReset"] == pytest.approx(3.1)


def test_leave_breakdown_beats_stub_accruals_for_the_year():
    sick = {
        "cycle": "calendar",
        "resetTo": 5,
        "annualAccrualCap": 5,
        "breakdownAsOf": {"date": "2030-12-10", "accrued": 5.0},
    }
    files = leave.LeaveFiles(
        stubs=[_stub("2030-12-15", 0.0, 2.0, sick_accrued=0.2)],
        policies=_policies(sick=sick),
    )
    lv = leave.build_leave(RATES, files, dt.date(2030, 12, 20))
    assert _by_date(lv)["2030-12-31"]["sick"] == 2  # the year is used up
    # A breakdown from another year is ignored.
    sick["breakdownAsOf"]["date"] = "2029-12-10"
    lv = leave.build_leave(RATES, files, dt.date(2030, 12, 20))
    # 12 weekdays left in December, 0.2 of the 5 accrued so far by the stubs.
    assert _by_date(lv)["2030-12-31"]["sick"] == pytest.approx(2 + 12 * 0.02)


def test_leave_half_days_and_hours():
    files = leave.LeaveFiles(
        stubs=[
            _stub("2030-03-15", 22.5, 4.0, unit="hours"),
            _stub("2030-03-29", 2.5, 0.5, end="2030-03-31"),
        ],
        taken=[
            {"date": "2030-03-04", "type": "pto", "days": 0.5},
            {"date": "2030-03-05", "type": "pto", "days": 1},
            {"date": "2030-03-06", "type": "sick", "days": 0.5},
            {"date": "2029-12-31", "type": "pto", "days": 1},
            {"date": "2030-04-30", "type": "pto", "days": 1},
        ],
    )
    cfg = parse_config(
        {"leave": {"accrual_per_weekday": {"pto": 0.05}, "hours_per_day": 7.5}}
    ).leave
    lv = leave.build_leave(cfg, files, dt.date(2030, 4, 2))
    assert lv["history"][0] == {"date": "2030-03-15", "pto": 3, "sick": 0.5333}
    assert lv["pto"]["balance"] == 2.5 and lv["sick"]["balance"] == 0.5
    assert lv["asOf"] == "2030-03-31"
    assert lv["pto"]["usedThisYear"] == 1.5 and lv["sick"]["usedThisYear"] == 0.5
    # No sick accrual configured: the balance holds.
    assert {p["sick"] for p in lv["projection"]} == {0.5}


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"leave": {}}, "missing 'pto'"),
        ({"leave": {"accrual_per_weekday": {"pto": 2}}}, "0 to 1"),
        ({"leave": {"accrual_per_weekday": {"pto": 0.04, "vacation": 1}}}, "unknown key"),
        ({"leave": {"accrual_per_weekday": {"pto": 0.04}, "hours_per_day": 0}}, "more than 0"),
        ({"leave": {"rate": 1}}, "unknown key"),
    ],
)
def test_leave_config_errors(doc, message):
    with pytest.raises(MobileConfigError, match=message):
        parse_config(doc)
