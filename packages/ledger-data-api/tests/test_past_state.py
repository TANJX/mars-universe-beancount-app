"""Plan ↔ cleared-txn matching in `annotate_past_state`."""

import datetime
from decimal import Decimal

from ledger_data_api.merge import annotate_past_state
from ledger_data_api.models import Plan

TODAY = datetime.date(2026, 11, 15)
ACCT = "Assets:Checking:Bank"


def _plan(pid: str, date: str, amount: str = "-120.00") -> Plan:
    return Plan(
        id=pid,
        date=date,
        account=ACCT,
        amount=amount,
        description="Card",
        state=None,
        transferId=None,
        createdAt="",
        updatedAt="",
    )


def test_future_plan_inside_grace_is_realized_by_early_txn():
    cleared = {("2026-11-15", ACCT): [Decimal("-120.00")]}
    status, claim = annotate_past_state([_plan("p", "2026-11-16")], cleared, TODAY)
    assert status == {"p": "realized"}
    assert claim["p"] == (("2026-11-15", ACCT), Decimal("-120.00"))


def test_future_plan_without_match_gets_no_status():
    status, claim = annotate_past_state([_plan("p", "2026-11-16")], {}, TODAY)
    assert status == {}
    assert claim == {}


def test_future_plan_beyond_grace_is_not_matched():
    cleared = {("2026-11-15", ACCT): [Decimal("-120.00")]}
    status, _ = annotate_past_state(
        [_plan("p", "2026-11-25")], cleared, TODAY, day_tolerance=3
    )
    assert status == {}


def test_past_plan_without_match_is_unrealized():
    status, _ = annotate_past_state([_plan("p", "2026-11-10")], {}, TODAY)
    assert status == {"p": "unrealized"}
