"""Planner math for cards that have statement records, and the legacy fallback.

Base ledger (conftest): DemoCard spent 1000.00 before the 05-20 close and
200.00 after it, and paid 300.00 on 05-28. It owes 900.00 from then on.
"""

import datetime
from decimal import Decimal

from conftest import (
    BANK,
    BASE_LEDGER,
    CARD,
    CARD_CFG,
    card,
    entries,
    plan_row,
    statement_mode,
    stmt_line,
)
from ledger_data_api import cc_cycle, cc_statements
from ledger_data_api.billing import Statement
from ledger_data_api.cc_projection import project_payments
from ledger_data_api.cc_statements import card_state, statement_expected_since
from ledger_data_api.models import CCCardRecord, ExpectedStatement

D = datetime.date
TODAY = D(2030, 6, 10)
DORMANT = "Liabilities:Credit:Dormant"


def _stmt(sid="2030-05-20", balance="1000.00", due="2030-06-15", minimum=None):
    return Statement(CARD, sid, balance, due, minimum, "fetch", "")


def _rec(**kw) -> CCCardRecord:
    return CCCardRecord(
        accountPath=CARD,
        fundingAccount=BANK,
        statementCloseDay=20,
        paymentDueDay=15,
        **kw,
    )


def _project(stmts, rec, *, today=TODAY, curr="900.00", paid="300.00", expected=None):
    state = card_state(CARD, stmts, expected, rec, today)
    return project_payments(
        {CARD: rec},
        {CARD: "DemoCard"},
        today,
        {CARD: Decimal(curr)},
        {CARD: Decimal(paid)},
        states={CARD: state},
    )


def _rows(out, kind):
    return [(e["date"], e["amount"], e["ccStatementId"]) for e in entries(out, kind)]


# ---------- legacy fallback ----------


def test_legacy_fallback_with_no_statements(h):
    h.write_cc_cards(
        {
            CARD: {
                **CARD_CFG[CARD],
                "statementBalance": "1000.00",
                "lastClosedDate": "2030-05-20",
            }
        }
    )
    out = h.grid(TODAY)

    c = card(out)
    same_as_before = {
        "isConfigured": True,
        "hasMonthlyInputs": True,
        "statementBalance": "1000.00",
        "currentBalance": "900.00",
        "lastClosedDate": "2030-05-20",
        "paidThisCycle": "300.00",
        "remaining": "700.00",
        "cycleStartDate": "2030-05-20",
        "cycleEndDate": "2030-06-15",
        "cycleMonth": "2030-06",
        "statementBalanceStale": False,
    }
    assert {k: c[k] for k in same_as_before} == same_as_before
    new_keys = {
        "hasStatements": False,
        "activeStatement": None,
        "expectedStatement": None,
        "statements": [],
        "nextCloseDate": None,
        "nextDueDate": None,
        "statementExpectedSince": None,
        "lockedAmount": None,
        "lockedSource": None,
        "overrideTotal": None,
        "computedForecast": None,
    }
    assert {k: c[k] for k in new_keys} == new_keys

    locked, forecast = entries(out, "cc-locked"), entries(out, "cc-forecast")
    assert [(e["date"], e["amount"], e["ccCycleMonth"]) for e in locked] == [
        ("2030-06-15", "-700.00", "2030-06")
    ]
    assert [(e["date"], e["amount"], e["ccCycleMonth"]) for e in forecast] == [
        ("2030-07-15", "-200.00", "2030-07")
    ]
    for e in locked + forecast:
        assert e["ccStatementId"] is None
        assert e["ccStatementKind"] == "legacy"

    # The cycleMonth override save is still accepted for a legacy card.
    saved = cc_statements.save_override(
        h.path,
        {
            "cardAccountPath": CARD,
            "cycleMonth": "2030-06",
            "plans": [{"date": "2030-06-14", "account": BANK, "amount": "-650.00"}],
        },
    )
    assert [(p.ccCycleMonth, p.ccStatementId) for p in saved] == [("2030-06", None)]
    out = h.grid(TODAY)
    assert entries(out, "cc-locked") == []
    assert len(entries(out, "cc-forecast")) == 1
    (plan,) = entries(out, "plan")
    assert (plan["ccStatementId"], plan["ccStatementKind"]) == (None, "legacy")


def test_voiding_the_only_statement_returns_the_card_to_legacy_mode(h):
    statement_mode(
        h,
        stmt_line("2030-05-20"),
        {"account": CARD, "id": "2030-05-20", "void": True, "source": "manual"},
    )
    h.write_plans(
        [
            plan_row(
                "p1",
                "2030-06-14",
                "-650.00",
                ccCardRef=CARD,
                ccStatementId="2030-05-20",
            )
        ]
    )
    out = h.grid(TODAY)
    c = card(out)
    assert c["hasStatements"] is False
    assert c["statementBalance"] is None
    # No typed balance either, so the legacy math projects nothing, and the
    # plan that pointed at the voided statement is a plain plan.
    assert entries(out, "cc-locked") == entries(out, "cc-forecast") == []
    (plan,) = entries(out, "plan")
    assert (plan["ccStatementId"], plan["ccStatementKind"]) == (None, "orphan")


# ---------- active statement and cycle ----------


def test_active_statement_is_newest_within_due_plus_grace():
    stmts = [_stmt("2030-04-20", due="2030-05-15"), _stmt("2030-05-20")]
    assert (
        card_state(CARD, stmts, None, _rec(), D(2030, 6, 15)).active.id == "2030-05-20"
    )
    # due + 3 days: still active. due + 4: the gap.
    assert (
        card_state(CARD, stmts, None, _rec(), D(2030, 6, 18)).active.id == "2030-05-20"
    )
    gap = card_state(CARD, stmts, None, _rec(), D(2030, 6, 19))
    assert gap.active is None and gap.active_cycle is None
    assert gap.has_statements
    # A newer closed statement takes over as soon as it exists.
    stmts.append(_stmt("2030-06-20", due="2030-07-15"))
    assert (
        card_state(CARD, stmts, None, _rec(), D(2030, 6, 21)).active.id == "2030-06-20"
    )
    # Input order does not matter.
    assert (
        card_state(CARD, list(reversed(stmts)), None, _rec(), D(2030, 6, 21)).active.id
        == "2030-06-20"
    )


def test_cycle_uses_closing_date_and_due_date(h):
    # The bank's due date (06-17) differs from the paymentDueDay hint (15).
    statement_mode(h, stmt_line("2030-05-20", due="2030-06-17"))
    state = card_state(CARD, [_stmt(due="2030-06-17")], None, _rec(), TODAY)
    assert state.active_cycle == cc_cycle.Cycle(
        D(2030, 5, 20), D(2030, 6, 17), "2030-06"
    )

    out = h.grid(TODAY)
    c = card(out)
    assert (c["cycleStartDate"], c["cycleEndDate"], c["cycleMonth"]) == (
        "2030-05-20",
        "2030-06-17",
        "2030-06",
    )
    assert c["activeStatement"]["effectiveDueDate"] == "2030-06-17"
    assert _rows(out, "cc-locked") == [("2030-06-17", "-700.00", "2030-05-20")]


def test_null_due_date_falls_back_to_payment_due_day(h):
    no_due = _stmt(due=None)
    assert cc_statements.effective_due(no_due, 15) == D(2030, 6, 15)
    assert cc_statements.effective_due(no_due, -1) == D(2030, 5, 31)
    # No usable hint: closing date + 25 days.
    assert cc_statements.effective_due(no_due, None) == D(2030, 6, 14)
    assert cc_statements.effective_due(no_due, 0) == D(2030, 6, 14)

    statement_mode(h, stmt_line("2030-05-20", due=None))
    out = h.grid(TODAY)
    c = card(out)
    assert c["activeStatement"]["dueDate"] is None
    assert c["activeStatement"]["effectiveDueDate"] == "2030-06-15"
    assert c["cycleEndDate"] == "2030-06-15"
    assert _rows(out, "cc-locked") == [("2030-06-15", "-700.00", "2030-05-20")]


# ---------- locked amount ----------


def test_locked_is_balance_minus_payments_since_close(h):
    statement_mode(h, stmt_line("2030-05-20", minimum="40.00"))
    out = h.grid(TODAY)

    assert _rows(out, "cc-locked") == [("2030-06-15", "-700.00", "2030-05-20")]
    (locked,) = entries(out, "cc-locked")
    assert locked["ccStatementKind"] == "closed"
    assert locked["ccCycleMonth"] == "2030-06"

    c = card(out)
    facts = {
        "hasStatements": True,
        "hasMonthlyInputs": True,
        "statementBalance": "1000.00",  # legacy-named, filled from the fact
        "lastClosedDate": "2030-05-20",
        "paidThisCycle": "300.00",
        "remaining": "700.00",
        "lockedAmount": "700.00",
        "lockedSource": "balance",
        "overrideTotal": None,
        "computedForecast": "200.00",
        "statementBalanceStale": False,
        "nextCloseDate": "2030-06-20",
        "nextDueDate": "2030-07-15",
        "statementExpectedSince": None,
        "expectedStatement": None,
    }
    assert {k: c[k] for k in facts} == facts
    assert c["activeStatement"] == {
        "kind": "closed",
        "account": CARD,
        "id": "2030-05-20",
        "statementBalance": "1000.00",
        "dueDate": "2030-06-15",
        "minimumPayment": "40.00",
        "source": "fetch",
        "capturedAt": "2030-05-20T12:00:00+00:00",
        "effectiveDueDate": "2030-06-15",
    }
    assert c["statements"] == [c["activeStatement"]]


def test_card_payload_lists_at_most_12_statements_newest_first(h):
    lines = [
        stmt_line(f"20{yy}-{mm:02d}-20", due=None)
        for yy in (29, 30)
        for mm in range(1, 13)
        if (yy, mm) <= (30, 5)
    ]
    statement_mode(h, *lines)
    c = card(h.grid(TODAY))
    assert len(c["statements"]) == 12
    assert c["statements"][0]["id"] == "2030-05-20"
    assert c["statements"][-1]["id"] == "2029-06-20"
    full = cc_statements.statements_response(h.path, CARD, TODAY)
    assert len(full["statements"]) == 17
    assert full["hasStatements"] is True and full["expectedStatement"] is None


def test_minimum_only_card_locks_minimum_payment():
    rec = _rec(minimumPaymentOnly=True)
    out = _project([_stmt(minimum="40.00")], rec, paid="0")
    assert [(p.kind, p.amount, p.statementId) for p in out] == [
        ("cc-locked", "-40.00", "2030-05-20")
    ]
    # Net of payments since close; gone once the minimum is paid.
    out = _project([_stmt(minimum="40.00")], rec, paid="15.00")
    assert [(p.kind, p.amount) for p in out] == [("cc-locked", "-25.00")]
    assert _project([_stmt(minimum="40.00")], rec, paid="40.00") == []
    assert _project([_stmt(minimum="40.00")], rec, paid="300.00") == []
    # No minimum on the statement: falls back to the balance.
    out = _project([_stmt(minimum=None)], rec, paid="300.00")
    assert [(p.kind, p.amount) for p in out] == [("cc-locked", "-700.00")]
    # A card that pays in full ignores the minimum.
    out = _project([_stmt(minimum="40.00")], _rec(), paid="0")
    assert out[0].amount == "-1000.00"


def test_minimum_only_card_payload(h):
    cfg = {CARD: {**CARD_CFG[CARD], "minimumPaymentOnly": True}}
    # Minimum above what was paid since close (300.00).
    statement_mode(h, stmt_line("2030-05-20", minimum="340.00"), cfg=cfg)
    out = h.grid(TODAY)
    assert _rows(out, "cc-locked") == [("2030-06-15", "-40.00", "2030-05-20")]
    assert entries(out, "cc-forecast") == []
    c = card(out)
    assert (c["lockedAmount"], c["lockedSource"]) == ("40.00", "minimum")
    assert c["remaining"] == "700.00"
    assert c["computedForecast"] is None


def test_zero_and_negative_statement_balance_lock_nothing():
    for balance in ("0.00", "-25.10"):
        out = _project([_stmt(balance=balance)], _rec(), curr="120.00", paid="0")
        assert [(p.kind, p.amount) for p in out] == [("cc-forecast", "-120.00")]
        out = _project(
            [_stmt(balance=balance, minimum="0.00")],
            _rec(minimumPaymentOnly=True),
            curr="0",
            paid="0",
        )
        assert out == []


# ---------- overrides and the forecast ----------


def test_override_plans_replace_locked_projection(h):
    statement_mode(h)
    h.write_plans(
        [
            plan_row(
                "p1",
                "2030-06-12",
                "-400.00",
                ccCardRef=CARD,
                ccStatementId="2030-05-20",
            ),
            plan_row(
                "p2",
                "2030-06-14",
                "-250.00",
                ccCardRef=CARD,
                ccStatementId="2030-05-20",
            ),
        ]
    )
    out = h.grid(TODAY)
    assert entries(out, "cc-locked") == []
    assert _rows(out, "cc-forecast") == [("2030-07-15", "-200.00", None)]
    plans = entries(out, "plan")
    assert [(e["id"], e["ccStatementId"], e["ccStatementKind"]) for e in plans] == [
        ("p1", "2030-05-20", "closed"),
        ("p2", "2030-05-20", "closed"),
    ]
    c = card(out)
    assert c["overrideTotal"] == "650.00"
    assert c["lockedAmount"] == "700.00"  # effective locked = overrideTotal


def test_forecast_uses_override_then_estimate_then_computed(h):
    statement_mode(h)
    # 1. Nothing typed: the computed forecast, on the predicted due date.
    out = h.grid(TODAY)
    (row,) = entries(out, "cc-forecast")
    assert (row["date"], row["amount"]) == ("2030-07-15", "-200.00")
    assert (row["ccStatementId"], row["ccStatementKind"]) == (None, "expected")
    assert row["ccCycleMonth"] == "2030-07"

    # 2. An expected statement with an estimate: the estimate, on its due date.
    h.write_expected(
        {
            CARD: {
                "id": "2030-06-21",
                "dueDate": "2030-07-16",
                "estimatedBalance": "850.00",
                "afterId": "2030-05-20",
            }
        }
    )
    out = h.grid(TODAY)
    assert _rows(out, "cc-forecast") == [("2030-07-16", "-850.00", "2030-06-21")]
    c = card(out)
    assert c["expectedStatement"]["estimatedBalance"] == "850.00"
    assert c["expectedStatement"]["kind"] == "expected"
    assert (c["nextCloseDate"], c["nextDueDate"]) == ("2030-06-21", "2030-07-16")
    assert c["computedForecast"] == "200.00"

    # 2b. Expected statement without an estimate: the computed forecast.
    h.write_expected(
        {CARD: {"id": "2030-06-21", "dueDate": "2030-07-16", "afterId": "2030-05-20"}}
    )
    assert _rows(h.grid(TODAY), "cc-forecast") == [
        ("2030-07-16", "-200.00", "2030-06-21")
    ]

    # 3. Override plans for the expected statement win over both.
    h.write_plans(
        [
            plan_row(
                "p1",
                "2030-07-10",
                "-500.00",
                ccCardRef=CARD,
                ccStatementId="2030-06-21",
            )
        ]
    )
    out = h.grid(TODAY)
    assert entries(out, "cc-forecast") == []
    assert len(entries(out, "cc-locked")) == 1  # the closed statement is untouched
    (plan,) = entries(out, "plan")
    assert (plan["ccStatementId"], plan["ccStatementKind"]) == (
        "2030-06-21",
        "expected",
    )


def test_expected_statement_past_its_due_date_is_dated_today():
    exp = ExpectedStatement(CARD, "2030-06-20", "2030-07-15", None, "2030-05-20")
    out = _project([_stmt()], _rec(), today=D(2030, 7, 20), expected=exp, paid="0")
    assert [(p.kind, p.date, p.amount, p.cycleMonth) for p in out] == [
        ("cc-forecast", "2030-07-20", "-900.00", "2030-07")
    ]


def test_gap_after_due_has_no_locked_row_only_forecast(h):
    statement_mode(h)
    gap_day = D(2030, 6, 19)  # due 06-15 + grace 3 has passed
    out = h.grid(gap_day)
    assert entries(out, "cc-locked") == []
    # The whole ledger balance is the forecast for the next statement.
    assert _rows(out, "cc-forecast") == [("2030-07-15", "-900.00", None)]
    c = card(out)
    gap = {
        "hasStatements": True,
        "activeStatement": None,
        "statementBalance": None,
        "lastClosedDate": "2030-05-20",
        "remaining": None,
        "lockedAmount": None,
        "lockedSource": None,
        "computedForecast": "900.00",
        "paidThisCycle": "0.00",
        "cycleStartDate": None,
        "cycleEndDate": None,
        "cycleMonth": None,
        "statementExpectedSince": None,
    }
    assert {k: c[k] for k in gap} == gap
    assert [s["id"] for s in c["statements"]] == ["2030-05-20"]


# ---------- "statement expected since" ----------


def test_statement_expected_since_after_predicted_close_plus_3(h):
    stmts, owed = [_stmt()], Decimal("900.00")
    at_3 = card_state(CARD, stmts, None, _rec(), D(2030, 6, 23))
    assert at_3.next_close == D(2030, 6, 20)
    assert statement_expected_since(at_3, D(2030, 6, 23), owed) is None
    at_4 = card_state(CARD, stmts, None, _rec(), D(2030, 6, 24))
    assert statement_expected_since(at_4, D(2030, 6, 24), owed) == D(2030, 6, 20)
    # An expected record moves the date the signal counts from.
    exp = ExpectedStatement(CARD, "2030-06-25", "2030-07-15", None, "2030-05-20")
    later = card_state(CARD, stmts, exp, _rec(), D(2030, 6, 28))
    assert statement_expected_since(later, D(2030, 6, 28), owed) is None
    assert statement_expected_since(later, D(2030, 6, 29), owed) == D(2030, 6, 25)
    # Legacy mode: never.
    legacy = card_state(CARD, [], None, _rec(), D(2030, 9, 1))
    assert statement_expected_since(legacy, D(2030, 9, 1), owed) is None

    statement_mode(h)
    assert card(h.grid(D(2030, 6, 23)))["statementExpectedSince"] is None
    assert card(h.grid(D(2030, 6, 24)))["statementExpectedSince"] == "2030-06-20"


def test_dormant_card_zero_balance_has_no_signal(h):
    # A card with a closing-day hint, an old 0.00 statement and no activity.
    h.write_cc_cards({DORMANT: {"statementCloseDay": 20, "paymentDueDay": 15}})
    h.write_statements(
        "Dormant", [stmt_line("2030-03-20", "0.00", None, account=DORMANT)]
    )
    today = D(2030, 8, 30)
    out = h.grid(today)
    c = card(out, DORMANT)
    assert c["hasStatements"] is True
    assert c["currentBalance"] == "0.00"
    assert c["nextCloseDate"] == "2030-04-20"
    assert c["statementExpectedSince"] is None
    assert [
        p for p in out["floatingProjections"] if p["cardAccountPath"] == DORMANT
    ] == []
    state = card_state(DORMANT, [_stmt("2030-03-20", "0.00", None)], None, None, today)
    assert statement_expected_since(state, today, Decimal(0)) is None
    assert statement_expected_since(state, today, Decimal("0.01")) == D(2030, 4, 20)


def test_predict_next_close_follows_the_last_real_close():
    p = cc_cycle.predict_next_close
    # One month after the newest close, same day; the hint never overrides it.
    assert p(["2030-05-20"], 20) == D(2030, 6, 20)
    assert p(["2030-05-18"], 20) == D(2030, 6, 18)  # closed early: follows it
    assert p(["2030-05-22"], 20) == D(2030, 6, 22)  # closed late: follows it
    assert p(["2030-05-19"], None) == D(2030, 6, 19)
    assert p(["2030-05-19"], 0) == D(2030, 6, 19)  # invalid hint
    assert p(["2030-12-20", "2030-11-20"], 20) == D(2031, 1, 20)  # newest, any order
    assert p(["2030-03-20", "2030-05-19"], None) == D(2030, 6, 19)  # gap is ignored
    assert p(["2030-01-30"], None) == D(2030, 2, 28)  # clamped to the month
    # A month-end close stays month-end with a last-day hint or no hint...
    assert p(["2030-01-31"], -1) == D(2030, 2, 28)
    assert p(["2030-02-28"], 31) == D(2030, 3, 31)
    assert p(["2030-02-28"], None) == D(2030, 3, 31)
    # ...and is a fixed day when the hint says so.
    assert p(["2030-02-28"], 28) == D(2030, 3, 28)

    assert cc_cycle.first_day_after(D(2030, 5, 20), 20) == D(2030, 6, 20)
    assert cc_cycle.first_day_after(D(2030, 5, 19), 20) == D(2030, 5, 20)
    assert cc_cycle.first_day_after(D(2030, 1, 31), 31) == D(2030, 2, 28)
    assert cc_cycle.predict_due(D(2030, 5, 5), 25) == D(2030, 5, 25)
    assert cc_cycle.predict_due(D(2030, 5, 20), 15) == D(2030, 6, 15)
    assert cc_cycle.predict_due(D(2030, 5, 20), None) == D(2030, 6, 14)
    assert [cc_cycle.valid_day(d) for d in (1, 31, -1, 0, 32, True, "5", None)] == [
        True,
        True,
        True,
        False,
        False,
        False,
        False,
        False,
    ]


# ---------- legacy rows and orphans ----------


def test_legacy_row_maps_when_exactly_one_statement_due_in_month(h):
    statement_mode(h)
    h.write_plans(
        [
            plan_row(
                "old", "2030-06-14", "-650.00", ccCardRef=CARD, ccCycleMonth="2030-06"
            )
        ]
    )
    before = h.plans_file.read_bytes()
    out = h.grid(TODAY)
    # Mapped to the statement due in June, so it replaces the locked row.
    assert entries(out, "cc-locked") == []
    (plan,) = entries(out, "plan")
    assert (plan["ccStatementId"], plan["ccStatementKind"]) == ("2030-05-20", "closed")
    assert plan["ccCycleMonth"] == "2030-06"
    assert card(out)["overrideTotal"] == "650.00"
    # Read-time only: the legacy row is not rewritten.
    assert h.plans_file.read_bytes() == before

    # It can also map to the expected statement.
    h.write_expected(
        {CARD: {"id": "2030-06-20", "dueDate": "2030-07-15", "afterId": "2030-05-20"}}
    )
    h.write_plans(
        [
            plan_row(
                "old2", "2030-07-14", "-180.00", ccCardRef=CARD, ccCycleMonth="2030-07"
            )
        ]
    )
    out = h.grid(TODAY)
    assert entries(out, "cc-forecast") == []
    kinds = {
        e["id"]: (e["ccStatementId"], e["ccStatementKind"])
        for e in entries(out, "plan")
    }
    assert kinds == {
        "old": ("2030-05-20", "closed"),
        "old2": ("2030-06-20", "expected"),
    }


def test_legacy_row_with_two_candidates_or_none_keeps_due_month_join_only_for_projection_without_statement(
    h,
):
    # Two closed statements due in June: a June legacy row maps to neither.
    statement_mode(
        h,
        stmt_line("2030-05-02", "10.00", "2030-06-01"),
        stmt_line("2030-05-20", "1000.00", "2030-06-15"),
    )
    h.write_plans(
        [
            plan_row(
                "june", "2030-06-14", "-650.00", ccCardRef=CARD, ccCycleMonth="2030-06"
            ),
            plan_row(
                "july", "2030-07-14", "-180.00", ccCardRef=CARD, ccCycleMonth="2030-07"
            ),
        ]
    )
    out = h.grid(TODAY)
    kinds = {
        e["id"]: (e["ccStatementId"], e["ccStatementKind"])
        for e in entries(out, "plan")
    }
    assert kinds == {"june": (None, "legacy"), "july": (None, "legacy")}
    # The locked row has a statement record behind it: a legacy month never
    # suppresses it.
    assert _rows(out, "cc-locked") == [("2030-06-15", "-700.00", "2030-05-20")]
    # The July forecast has no statement record (no candidate for the July
    # row), so the old due-month join still suppresses it.
    assert entries(out, "cc-forecast") == []

    # Without the July row the forecast is back.
    h.write_ledger(BASE_LEDGER)
    h.plans_file.write_text("")
    h.write_plans(
        [
            plan_row(
                "june", "2030-06-14", "-650.00", ccCardRef=CARD, ccCycleMonth="2030-06"
            )
        ]
    )
    out = h.grid(TODAY)
    assert len(entries(out, "cc-forecast")) == 1
    assert len(entries(out, "cc-locked")) == 1


def test_orphan_statement_id_suppresses_nothing(h):
    statement_mode(h)
    h.write_plans(
        [
            plan_row(
                "lost",
                "2030-06-14",
                "-650.00",
                ccCardRef=CARD,
                ccStatementId="2030-01-20",
            ),
            plan_row("bare", "2030-06-13", "-1.00", ccCardRef=CARD),
        ]
    )
    out = h.grid(TODAY)
    assert _rows(out, "cc-locked") == [("2030-06-15", "-700.00", "2030-05-20")]
    assert len(entries(out, "cc-forecast")) == 1
    kinds = {
        e["id"]: (e["ccStatementId"], e["ccStatementKind"])
        for e in entries(out, "plan")
    }
    assert kinds == {"lost": (None, "orphan"), "bare": (None, "orphan")}
    assert card(out)["overrideTotal"] is None


def test_untagged_plan_has_no_statement_kind(h):
    statement_mode(h)
    h.write_plans([plan_row("rent", "2030-06-20", "-900.00")])
    (plan,) = entries(h.grid(TODAY), "plan")
    assert plan["ccCardRef"] is None
    assert (plan["ccStatementId"], plan["ccStatementKind"]) == (None, None)


# ---------- cards outside cc-cards.json, closed accounts ----------


def test_statement_card_without_config_is_floating(h):
    # An adapter fetched a statement for a card that has no cc-cards.json row.
    h.write_statements("DemoCard", [stmt_line("2030-05-20")])
    out = h.grid(TODAY)
    assert entries(out, "cc-locked") == entries(out, "cc-forecast") == []
    floating = [
        (p["kind"], p["date"], p["amount"], p["statementId"], p["statementKind"])
        for p in out["floatingProjections"]
    ]
    assert floating == [
        ("cc-locked", "2030-06-15", "-700.00", "2030-05-20", "closed"),
        # No hints: next close = last + 1 month, due = close + 25 days.
        ("cc-forecast", "2030-07-15", "-200.00", None, "expected"),
    ]
    c = card(out)
    assert c["hasStatements"] is True and c["isConfigured"] is False
    assert c["paidThisCycle"] == "300.00"


def test_statements_of_closed_or_unknown_account_are_ignored(h):
    h.write_ledger(BASE_LEDGER + "\n2030-06-01 close Liabilities:Credit:Dormant\n")
    h.write_statements("Dormant", [stmt_line("2030-05-20", account=DORMANT)])
    h.write_statements(
        "Ghost", [stmt_line("2030-05-20", account="Liabilities:Credit:Ghost")]
    )
    out = h.grid(TODAY)
    assert [c["accountPath"] for c in out["ccCards"]] == [CARD]
    assert out["floatingProjections"] == []
