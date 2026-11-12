"""One card through the whole statement lifecycle, as the planner sees it:
closed statement -> active on the card payload -> expected statement ->
override (strict foreign key) -> the real statement closes on a different
date -> promotion re-points the override -> a second reconcile is a no-op.

`MANUAL_LINE` / `FETCH_LINE` are the exact bytes the fetch command writes
(beancount-tooling tests/fetch/test_billing_lifecycle.py asserts the writer
produces these same two literals). This package must not import that one, so
the shared literals are what pins the on-disk format between them.
"""

import datetime

import pytest
from conftest import BANK, CARD, CARD_CFG, card, entries
from ledger_data_api import cc_statements, store
from ledger_data_api.cc_statements import ApiError

MANUAL_LINE = (
    '{"account": "Liabilities:Credit:DemoCard", "id": "2030-05-20", '
    '"statementBalance": "1000.00", "dueDate": "2030-06-15", '
    '"minimumPayment": "35.00", "source": "manual", '
    '"capturedAt": "2030-05-22T12:00:00+00:00"}\n'
)
FETCH_LINE = (
    '{"account": "Liabilities:Credit:DemoCard", "id": "2030-06-18", '
    '"statementBalance": "210.00", "dueDate": "2030-07-13", '
    '"minimumPayment": null, "source": "fetch", '
    '"capturedAt": "2030-06-19T12:00:00+00:00"}\n'
)


def _cc_entries(payload):
    return [
        (e["kind"], e["date"], e["amount"], e["ccStatementId"], e["ccStatementKind"])
        for e in entries(payload)
        if e.get("ccCardRef") == CARD
    ]


def test_statement_lifecycle(h):
    h.write_cc_cards(CARD_CFG)
    billing_file = h.billing_dir / "DemoCard.jsonl"
    billing_file.write_text(MANUAL_LINE)
    today = datetime.date(2030, 5, 22)

    # 1. The closed statement is the card's active statement.
    payload = h.grid(today)
    c = card(payload)
    assert c["hasStatements"] is True
    assert c["activeStatement"] == {
        "kind": "closed",
        "account": CARD,
        "id": "2030-05-20",
        "statementBalance": "1000.00",
        "dueDate": "2030-06-15",
        "minimumPayment": "35.00",
        "source": "manual",
        "capturedAt": "2030-05-22T12:00:00+00:00",
        "effectiveDueDate": "2030-06-15",
    }
    assert c["expectedStatement"] is None
    assert (c["nextCloseDate"], c["nextDueDate"]) == ("2030-06-20", "2030-07-15")
    assert (c["lockedAmount"], c["lockedSource"]) == ("1000.00", "balance")
    assert _cc_entries(payload) == [
        ("cc-locked", "2030-06-15", "-1000.00", "2030-05-20", "closed")
    ]

    # 2. Plan ahead: an expected statement, created on demand.
    exp = cc_statements.save_expected(h.path, {"accountPath": CARD}, today)
    assert (exp.id, exp.dueDate, exp.afterId) == (
        "2030-06-20",
        "2030-07-15",
        "2030-05-20",
    )

    # 3. Strict foreign key: an id that is neither closed nor expected is
    # rejected and nothing is written.
    split = [{"date": "2030-07-10", "account": BANK, "amount": "-150.00"}]
    with pytest.raises(ApiError, match="unknown statement 2030-01-01"):
        cc_statements.save_override(
            h.path,
            {"cardAccountPath": CARD, "statementId": "2030-01-01", "plans": split},
            today,
        )
    assert not h.plans_file.exists()

    (saved,) = cc_statements.save_override(
        h.path,
        {"cardAccountPath": CARD, "statementId": exp.id, "plans": split},
        today,
    )
    assert (saved.ccStatementId, saved.ccCycleMonth) == ("2030-06-20", None)
    assert _cc_entries(h.grid(today)) == [
        ("cc-locked", "2030-06-15", "-1000.00", "2030-05-20", "closed"),
        ("plan", "2030-07-10", "-150.00", "2030-06-20", "expected"),
    ]

    # 4. The real statement closes two days before the predicted date.
    with billing_file.open("a") as f:
        f.write(FETCH_LINE)
    today = datetime.date(2030, 6, 19)
    data = cc_statements.load_statement_data(h.path)
    assert data.promoted == {CARD: ("2030-06-20", "2030-06-18")}
    assert data.persisted is True
    assert data.expected == {}
    assert [(p.id, p.ccStatementId) for p in store.list_plans(h.path)] == [
        (saved.id, "2030-06-18")
    ]
    assert store.list_expected_statements(h.path) == {}

    # 5. A second reconcile changes nothing on disk.
    plans_bytes = h.plans_file.read_bytes()
    expected_bytes = h.expected_file.read_bytes()
    again = cc_statements.load_statement_data(h.path)
    assert again.promoted == {}
    assert h.plans_file.read_bytes() == plans_bytes
    assert h.expected_file.read_bytes() == expected_bytes

    # 6. The override now sits on the closed statement and replaces its
    # locked row.
    payload = h.grid(today)
    c = card(payload)
    assert c["activeStatement"]["id"] == "2030-06-18"
    assert c["activeStatement"]["source"] == "fetch"
    assert c["activeStatement"]["minimumPayment"] is None
    assert c["overrideTotal"] == "150.00"
    assert c["expectedStatement"] is None
    rows = _cc_entries(payload)
    assert ("plan", "2030-07-10", "-150.00", "2030-06-18", "closed") in rows
    assert not [r for r in rows if r[0] == "cc-locked"]

    # A save still naming the promoted expected id (a dialog left open)
    # lands on the closed statement that claimed it; other ids are unknown.
    (again,) = cc_statements.save_override(
        h.path,
        {"cardAccountPath": CARD, "statementId": "2030-06-20", "plans": split},
        today,
    )
    assert again.ccStatementId == "2030-06-18"
    with pytest.raises(ApiError, match="unknown statement 2030-06-21"):
        cc_statements.save_override(
            h.path,
            {"cardAccountPath": CARD, "statementId": "2030-06-21", "plans": split},
            today,
        )
