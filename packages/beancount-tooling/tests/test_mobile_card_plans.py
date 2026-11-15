"""Card payments in the mobile snapshot follow the planner's override plans."""

import datetime as dt
from decimal import Decimal

from beancount.core import data
from beancount.core.amount import Amount

from beancount_tooling.mobile.snapshot import (
    _card_events,
    _index_card_plans,
    _Ledger,
)

ASOF = dt.date(2030, 6, 15)
CARD = "Liabilities:Credit:Summit"
HARBOR = "Assets:Checking:Harbor"
TIDE = "Assets:Checking:Tidewater"


def _txn(date, flag, account, amount, **meta):
    return data.Transaction(
        meta={"filename": "x", "lineno": 1, **meta},
        date=date,
        flag=flag,
        payee="Payment",
        narration="",
        tags=frozenset(),
        links=frozenset(),
        postings=[
            data.Posting(account, Amount(Decimal(amount), "USD"), None, None, None, None),
            data.Posting(
                "Assets:Pending-Transfer",
                Amount(-Decimal(amount), "USD"),
                None,
                None,
                None,
                None,
            ),
        ],
    )


def _plan(pid, date, account, amount, sid="2030-05-20"):
    return {
        "id": pid,
        "date": date,
        "account": account,
        "amount": amount,
        "ccCardRef": CARD,
        "ccStatementId": sid,
    }


def _card(remaining=500.0):
    return {
        "account": CARD,
        "displayName": "Summit",
        "value": 900.0,
        "due": "2030-06-20",
        "statementId": "2030-05-20",
        "statementRemaining": remaining,
        "fundedBy": "Harbor",
        "fundedByName": "Harbor",
    }


def _events(plans, entries=(), remaining=500.0):
    led = _Ledger(list(entries), ASOF)
    idx = _index_card_plans(led, plans)
    return _card_events(_card(remaining), ASOF, "2030-12-31", None, idx, None, HARBOR)


def test_statement_follows_plan_bank():
    ev = _events([_plan("a", "2030-06-19", TIDE, "-500.00")])
    stmt = [e for e in ev if e["basis"] == "statement"]
    assert [(e["date"], e["fundedBy"], e["amount"]) for e in stmt] == [
        ("2030-06-19", "Tidewater", -500.0)
    ]


def test_two_banks_pay_one_statement():
    ev = _events(
        [
            _plan("a", "2030-06-18", TIDE, "-300.00"),
            _plan("b", "2030-06-19", HARBOR, "-200.00"),
        ]
    )
    stmt = [(e["fundedBy"], e["amount"]) for e in ev if e["basis"] == "statement"]
    assert stmt == [("Tidewater", -300.0), ("Harbor", -200.0)]


def test_uncovered_part_is_not_paid_and_unbilled_uses_default():
    ev = _events([_plan("a", "2030-06-19", TIDE, "-450.00")])
    assert [(e["basis"], e["fundedBy"], e["amount"]) for e in ev] == [
        ("statement", "Tidewater", -450.0),
        ("unbilled", "Harbor", -400.0),
    ]


def test_bank_pending_payment_marks_plan_paid():
    pending = _txn(dt.date(2030, 6, 14), "!", TIDE, "-300.00", pending="p1")
    led = _Ledger([pending], ASOF)
    idx = _index_card_plans(
        led,
        [
            _plan("a", "2030-06-16", TIDE, "-300.00"),
            _plan("b", "2030-06-19", HARBOR, "-200.00"),
        ],
    )
    assert [p["paid"] for p in idx[CARD]] == [True, False]
    # The open statement already had the paid plan taken off (500 - 300).
    ev = _card_events(_card(200.0), ASOF, "2030-12-31", None, idx, None, HARBOR)
    stmt = [(e["fundedBy"], e["amount"]) for e in ev if e["basis"] == "statement"]
    assert stmt == [("Harbor", -200.0)]


def test_forecast_row_does_not_pay_a_plan():
    forecast = _txn(dt.date(2030, 6, 14), "!", TIDE, "-300.00")
    led = _Ledger([forecast], ASOF)
    idx = _index_card_plans(led, [_plan("a", "2030-06-16", TIDE, "-300.00")])
    assert idx[CARD][0]["paid"] is False
