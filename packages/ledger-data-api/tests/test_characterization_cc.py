"""Characterization of the cc-cards.json (legacy) cycle and projection math.

Written against the code before card statements existed and kept green after:
a card with no statement records must behave exactly like this.
"""

import datetime
from decimal import Decimal

from beancount import loader
from conftest import BANK, CARD, card, entries, plan_row
from ledger_data_api import cc_cycle
from ledger_data_api.cc_projection import project_payments
from ledger_data_api.merge import compute_active_cycles, compute_paid_this_cycle
from ledger_data_api.models import CCCardRecord

D = datetime.date
TODAY = D(2030, 6, 10)

LEGACY_CARD = {
    CARD: {
        "fundingAccount": BANK,
        "statementCloseDay": 20,
        "paymentDueDay": 15,
        "statementBalance": "1000.00",
        "lastClosedDate": "2030-05-20",
    }
}


def _rec(**kw) -> CCCardRecord:
    base = dict(  # noqa: C408
        accountPath=CARD,
        fundingAccount=BANK,
        statementCloseDay=20,
        paymentDueDay=15,
        statementBalance="1000.00",
        lastClosedDate="2030-05-20",
    )
    base.update(kw)
    return CCCardRecord(**base)


def _project(rec, curr="900.00", paid="300.00", today=TODAY):
    return project_payments(
        {CARD: rec},
        {CARD: "DemoCard"},
        today,
        {CARD: Decimal(curr)},
        {CARD: Decimal(paid)},
    )


# ---------- cc_cycle ----------


def test_next_due_date_same_month_and_rollover():
    assert cc_cycle.next_due_date(D(2030, 6, 10), 15) == D(2030, 6, 15)
    assert cc_cycle.next_due_date(D(2030, 6, 15), 15) == D(2030, 6, 15)
    assert cc_cycle.next_due_date(D(2030, 6, 16), 15) == D(2030, 7, 15)
    assert cc_cycle.next_due_date(D(2030, 12, 20), 15) == D(2031, 1, 15)


def test_resolve_day_clamps_and_last_day():
    assert cc_cycle._resolve_day(2030, 2, 31) == D(2030, 2, 28)
    assert cc_cycle._resolve_day(2030, 4, 31) == D(2030, 4, 30)
    assert cc_cycle._resolve_day(2030, 2, -1) == D(2030, 2, 28)
    assert cc_cycle._resolve_day(2030, 7, -1) == D(2030, 7, 31)
    assert cc_cycle._resolve_day(2030, 7, 0) == D(2030, 7, 1)


def test_previous_close_same_month_and_previous_month():
    assert cc_cycle.previous_close(D(2030, 5, 25), 5) == D(2030, 5, 5)
    assert cc_cycle.previous_close(D(2030, 5, 15), 20) == D(2030, 4, 20)
    assert cc_cycle.previous_close(D(2030, 1, 15), 20) == D(2029, 12, 20)
    # A close day equal to the due day is not "strictly before".
    assert cc_cycle.previous_close(D(2030, 5, 15), 15) == D(2030, 4, 15)


def test_previous_close_without_close_day_is_30_days():
    assert cc_cycle.previous_close(D(2030, 5, 15), None) == D(2030, 4, 15)
    assert cc_cycle.previous_close(D(2030, 3, 15), None) == D(2030, 2, 13)


def test_cycle_for_due_prefers_last_closed_date():
    c = cc_cycle.cycle_for_due(D(2030, 6, 15), 20, D(2030, 5, 18))
    assert (c.start, c.end, c.dueMonth) == (D(2030, 5, 18), D(2030, 6, 15), "2030-06")
    # A last-closed date on or after the due date is ignored.
    c = cc_cycle.cycle_for_due(D(2030, 6, 15), 20, D(2030, 6, 15))
    assert c.start == D(2030, 5, 20)
    c = cc_cycle.cycle_for_due(D(2030, 6, 15), 20, None)
    assert c.start == D(2030, 5, 20)


def test_active_cycle_and_next_cycle():
    active = cc_cycle.active_cycle(TODAY, 20, 15, D(2030, 5, 18))
    assert (active.start, active.end) == (D(2030, 5, 18), D(2030, 6, 15))
    following = cc_cycle.next_cycle(active, 20, 15)
    assert (following.start, following.end, following.dueMonth) == (
        D(2030, 6, 20),
        D(2030, 7, 15),
        "2030-07",
    )
    # The day after the due day the active cycle flips to the next month.
    assert cc_cycle.active_cycle(D(2030, 6, 16), 20, 15).end == D(2030, 7, 15)


def test_cycle_payment_window_caps_at_today_and_grace():
    c = cc_cycle.Cycle(D(2030, 5, 20), D(2030, 6, 15), "2030-06")
    assert cc_cycle.cycle_payment_window(c, D(2030, 6, 10)) == (
        D(2030, 5, 20),
        D(2030, 6, 10),
    )
    assert cc_cycle.cycle_payment_window(c, D(2030, 6, 30)) == (
        D(2030, 5, 20),
        D(2030, 6, 18),
    )
    assert cc_cycle.SETTLEMENT_GRACE_DAYS == 3


# ---------- cc_projection ----------


def test_project_locked_is_statement_minus_paid():
    locked = [p for p in _project(_rec()) if p.kind == "cc-locked"]
    assert len(locked) == 1
    assert locked[0].amount == "-700.00"
    assert locked[0].date == "2030-06-15"
    assert locked[0].cycleMonth == "2030-06"
    assert locked[0].fundingAccount == BANK
    assert locked[0].displayName == "DemoCard"


def test_project_no_locked_row_when_paid_in_full():
    out = _project(_rec(), curr="200.00", paid="1000.00")
    assert [p.kind for p in out] == ["cc-forecast"]
    assert out[0].amount == "-200.00"
    out = _project(_rec(), curr="0", paid="1200.00")
    assert out == []


def test_project_forecast_is_current_minus_remaining():
    forecast = [p for p in _project(_rec()) if p.kind == "cc-forecast"]
    assert len(forecast) == 1
    assert forecast[0].amount == "-200.00"
    assert forecast[0].date == "2030-07-15"
    assert forecast[0].cycleMonth == "2030-07"
    # No statement balance typed: no locked row and no forecast.
    assert _project(_rec(statementBalance=None)) == []


def test_project_minimum_only_has_no_forecast():
    out = _project(_rec(minimumPaymentOnly=True))
    assert [p.kind for p in out] == ["cc-locked"]
    assert out[0].amount == "-700.00"


def test_project_skips_cards_without_due_day():
    assert _project(_rec(paymentDueDay=None)) == []


def test_project_floating_when_no_funding_account():
    out = _project(_rec(fundingAccount=None))
    assert [p.kind for p in out] == ["cc-locked", "cc-forecast"]
    assert all(p.fundingAccount is None for p in out)


# ---------- merge ----------

PAID_LEDGER = """
2030-01-01 open Assets:Checking:Acme USD
2030-01-01 open Liabilities:Credit:DemoCard USD
2030-01-01 open Expenses:Misc
2030-01-01 open Income:Rebate

2030-05-20 * "payment on the close date is outside the window"
  Liabilities:Credit:DemoCard  11.00 USD
  Assets:Checking:Acme

2030-05-28 * "payment"
  Liabilities:Credit:DemoCard  300.00 USD
  Assets:Checking:Acme

2030-06-01 * "rebate has no asset offset"
  Liabilities:Credit:DemoCard  25.00 USD
  Income:Rebate

2030-06-02 * "spend is not a payment"
  Liabilities:Credit:DemoCard  -40.00 USD
  Expenses:Misc

2030-06-05 ! "scheduled payment counts"
  Liabilities:Credit:DemoCard  50.00 USD
  Assets:Checking:Acme

2030-06-12 * "after today"
  Liabilities:Credit:DemoCard  7.00 USD
  Assets:Checking:Acme
"""


def test_compute_paid_this_cycle_counts_only_asset_offset_payments_in_window():
    loaded, errors, _ = loader.load_string(PAID_LEDGER)
    assert not errors
    records = {CARD: _rec()}
    cycles = compute_active_cycles(records, TODAY)
    assert cycles[CARD].start == D(2030, 5, 20)
    paid = compute_paid_this_cycle(records, cycles, TODAY, loaded)
    assert paid == {CARD: Decimal("350.00")}
    # No cycle (no due day): seeded with zero.
    records = {CARD: _rec(paymentDueDay=None)}
    assert compute_paid_this_cycle(records, {}, TODAY, loaded) == {CARD: Decimal(0)}


def test_grid_legacy_card_payload_and_cycle_month_suppression(h):
    h.write_cc_cards(LEGACY_CARD)
    out = h.grid(TODAY, use_statements=False)

    c = card(out)
    expected = {
        "accountPath": CARD,
        "displayName": "DemoCard",
        "isConfigured": True,
        "hasMonthlyInputs": True,
        "fundingAccount": BANK,
        "statementCloseDay": 20,
        "paymentDueDay": 15,
        "statementBalance": "1000.00",
        "currentBalance": "900.00",
        "lastClosedDate": "2030-05-20",
        "minimumPaymentOnly": None,
        "paidThisCycle": "300.00",
        "remaining": "700.00",
        "cycleStartDate": "2030-05-20",
        "cycleEndDate": "2030-06-15",
        "cycleMonth": "2030-06",
        "statementBalanceStale": False,
    }
    assert {k: c[k] for k in expected} == expected

    locked = entries(out, "cc-locked")
    assert [(e["date"], e["amount"], e["ccCycleMonth"]) for e in locked] == [
        ("2030-06-15", "-700.00", "2030-06")
    ]
    assert locked[0]["ccCardRef"] == CARD
    forecast = entries(out, "cc-forecast")
    assert [(e["date"], e["amount"], e["ccCycleMonth"]) for e in forecast] == [
        ("2030-07-15", "-200.00", "2030-07")
    ]
    assert out["floatingProjections"] == []

    # A plan tagged with the cycle month suppresses that month's projection.
    h.write_plans(
        [
            plan_row(
                "p1", "2030-06-14", "-650.00", ccCardRef=CARD, ccCycleMonth="2030-06"
            )
        ]
    )
    out = h.grid(TODAY, use_statements=False)
    assert entries(out, "cc-locked") == []
    assert len(entries(out, "cc-forecast")) == 1
    plans = entries(out, "plan")
    assert [(e["id"], e["date"], e["amount"]) for e in plans] == [
        ("p1", "2030-06-14", "-650.00")
    ]
    assert plans[0]["ccCardRef"] == CARD
    assert plans[0]["ccCycleMonth"] == "2030-06"


def test_grid_legacy_stale_statement_flag(h):
    stale = {CARD: {**LEGACY_CARD[CARD], "lastClosedDate": "2030-04-20"}}
    h.write_cc_cards(stale)
    c = card(h.grid(D(2030, 6, 25), use_statements=False))
    # Active cycle is now the one due 2030-07-15; lastClosedDate still wins as
    # the cycle start, so "stale" (last closed before the cycle start) is False.
    assert c["cycleEndDate"] == "2030-07-15"
    assert c["cycleStartDate"] == "2030-04-20"
    assert c["statementBalanceStale"] is False
