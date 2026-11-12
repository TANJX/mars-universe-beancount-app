"""The validation behind the statement endpoints (the Flask-free functions the
endpoints delegate to)."""

import datetime
import json

import pytest
from conftest import (
    BANK,
    CARD,
    CARD_CFG,
    card,
    entries,
    plan_row,
    statement_mode,
    stmt_line,
)
from ledger_data_api import cc_statements, store
from ledger_data_api.cc_statements import ApiError

D = datetime.date
TODAY = D(2030, 6, 10)


def _body(statement_id=None, cycle_month=None, plans=None) -> dict:
    body = {
        "cardAccountPath": CARD,
        "plans": plans
        if plans is not None
        else [{"date": "2030-06-14", "account": BANK, "amount": "-650.00"}],
    }
    if statement_id is not None:
        body["statementId"] = statement_id
    if cycle_month is not None:
        body["cycleMonth"] = cycle_month
    return body


def _expected(h, **fields) -> dict:
    rec = {"id": "2030-06-20", "dueDate": "2030-07-15", "afterId": "2030-05-20"}
    rec.update(fields)
    h.write_expected({CARD: rec})
    return rec


def _plans_bytes(h) -> bytes:
    return h.plans_file.read_bytes() if h.plans_file.exists() else b""


# ---------- cc_override_save ----------


def test_override_save_rejects_unknown_statement_id(h):
    statement_mode(h)
    _expected(h)
    for bad in ("2030-05-21", "2030-06", "nope"):
        with pytest.raises(ApiError) as err:
            cc_statements.save_override(h.path, _body(statement_id=bad), TODAY)
        assert err.value.message == f"unknown statement {bad} for {CARD}"
    # A statement of another card is not a statement of this one.
    h.write_statements(
        "Dormant", [stmt_line("2030-05-11", account="Liabilities:Credit:Dormant")]
    )
    with pytest.raises(ApiError):
        cc_statements.save_override(h.path, _body(statement_id="2030-05-11"), TODAY)
    # Neither key, missing card, bad plans.
    with pytest.raises(ApiError):
        cc_statements.save_override(h.path, _body(), TODAY)
    with pytest.raises(ApiError):
        cc_statements.save_override(h.path, {"statementId": "2030-05-20"}, TODAY)
    with pytest.raises(ApiError):
        cc_statements.save_override(
            h.path, _body(statement_id="2030-05-20", plans=[{"amount": "-1"}]), TODAY
        )
    # Nothing was written.
    assert _plans_bytes(h) == b""

    # A legacy card has no statements at all: any statementId is unknown.
    h.write_statements("DemoCard", [])
    with pytest.raises(ApiError):
        cc_statements.save_override(h.path, _body(statement_id="2030-06-20"), TODAY)
    assert _plans_bytes(h) == b""


def test_override_save_accepts_closed_and_expected_ids_and_writes_no_cycle_month(h):
    statement_mode(h)
    _expected(h)

    closed = cc_statements.save_override(
        h.path, _body(statement_id="2030-05-20"), TODAY
    )
    expected = cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-06-20",
            plans=[{"date": "2030-07-10", "account": BANK, "amount": "-180.00"}],
        ),
        TODAY,
    )
    for plans, sid in ((closed, "2030-05-20"), (expected, "2030-06-20")):
        (p,) = plans
        assert (p.ccCardRef, p.ccStatementId, p.ccCycleMonth) == (CARD, sid, None)
        assert p.to_dict()["ccStatementId"] == sid

    rows = [json.loads(ln) for ln in h.plans_file.read_text().splitlines()]
    assert [r["op"] for r in rows] == ["save", "save"]
    for row in rows:
        assert row["ccCycleMonth"] is None
        assert row["ccStatementId"] in ("2030-05-20", "2030-06-20")

    out = h.grid(TODAY)
    assert entries(out, "cc-locked") == entries(out, "cc-forecast") == []
    assert card(out)["overrideTotal"] == "650.00"


def test_override_save_cycle_month_rejected_for_statement_mode_card(h):
    statement_mode(h)
    with pytest.raises(ApiError) as err:
        cc_statements.save_override(h.path, _body(cycle_month="2030-06"), TODAY)
    assert err.value.message == "card has statement records; statementId required"
    assert _plans_bytes(h) == b""

    # Still fine for a legacy card (no statement records).
    h.write_statements("DemoCard", [])
    (p,) = cc_statements.save_override(h.path, _body(cycle_month="2030-06"), TODAY)
    assert (p.ccCycleMonth, p.ccStatementId) == ("2030-06", None)
    # And a legacy re-save replaces the set for that month only.
    cc_statements.save_override(h.path, _body(cycle_month="2030-07"), TODAY)
    cc_statements.save_override(h.path, _body(cycle_month="2030-06", plans=[]), TODAY)
    assert [p.ccCycleMonth for p in store.list_plans(h.path)] == ["2030-07"]


def test_override_save_replaces_previous_set_for_statement(h):
    statement_mode(h)
    _expected(h)
    first = cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-05-20",
            plans=[
                {"date": "2030-06-12", "account": BANK, "amount": "-400.00"},
                {"date": "2030-06-14", "account": BANK, "amount": "-250.00"},
            ],
        ),
        TODAY,
    )
    other = cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-06-20",
            plans=[{"date": "2030-07-10", "account": BANK, "amount": "-180.00"}],
        ),
        TODAY,
    )
    # A legacy row that maps to the same statement at read time is part of
    # the set being replaced.
    h.write_plans(
        [plan_row("old", "2030-06-13", "-9.00", ccCardRef=CARD, ccCycleMonth="2030-06")]
    )
    # Keep the first plan (edited), drop the second, add one.
    cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-05-20",
            plans=[
                {
                    "id": first[0].id,
                    "date": "2030-06-12",
                    "account": BANK,
                    "amount": "-500.00",
                },
                {"date": "2030-06-15", "account": BANK, "amount": "-200.00"},
            ],
        ),
        TODAY,
    )
    plans = store.list_plans(h.path)
    for_closed = sorted(p.amount for p in plans if p.ccStatementId == "2030-05-20")
    assert for_closed == ["-200.00", "-500.00"]
    assert first[1].id not in {p.id for p in plans}
    assert "old" not in {p.id for p in plans}
    # The other statement's set is untouched.
    assert [p.id for p in plans if p.ccStatementId == "2030-06-20"] == [other[0].id]

    # "Reset": an empty set removes every override of that statement.
    cc_statements.save_override(
        h.path, _body(statement_id="2030-05-20", plans=[]), TODAY
    )
    assert [p.ccStatementId for p in store.list_plans(h.path)] == ["2030-06-20"]


def test_override_save_accepts_just_promoted_expected_id(h):
    # The dialog was opened on the expected statement; it closed meanwhile.
    statement_mode(
        h, stmt_line("2030-05-20"), stmt_line("2030-06-18", "640.00", "2030-07-13")
    )
    _expected(h)
    (p,) = cc_statements.save_override(
        h.path, _body(statement_id="2030-06-20"), D(2030, 6, 22)
    )
    assert p.ccStatementId == "2030-06-18"


def test_override_save_maps_expected_id_promoted_by_an_earlier_read(h):
    # The dialog was opened on the expected statement. It closed meanwhile
    # and a background read (cc_cards, plan_grid) already persisted the
    # promotion: Save must still land on the closed statement.
    statement_mode(
        h, stmt_line("2030-05-20"), stmt_line("2030-06-18", "640.00", "2030-07-13")
    )
    _expected(h)
    assert cc_statements.load_statement_data(h.path).promoted
    assert cc_statements.load_statement_data(h.path).promoted == {}
    (p,) = cc_statements.save_override(
        h.path, _body(statement_id="2030-06-20"), D(2030, 6, 22)
    )
    assert p.ccStatementId == "2030-06-18"
    # Any other unknown id is still rejected.
    with pytest.raises(ApiError, match="unknown statement 2030-06-21"):
        cc_statements.save_override(
            h.path, _body(statement_id="2030-06-21"), D(2030, 6, 22)
        )


def test_expected_save_with_stale_expect_id_is_rejected(h):
    # The estimate field of a dialog opened on expected 2030-06-20, saved
    # after that statement closed: no new record for the following cycle.
    statement_mode(h, stmt_line("2030-05-20"))
    _expected(h)
    ok = cc_statements.save_expected(
        h.path,
        {"accountPath": CARD, "expectId": "2030-06-20", "estimatedBalance": "300"},
        TODAY,
    )
    assert ok.estimatedBalance == "300.00"
    h.write_statements(
        "DemoCard",
        [stmt_line("2030-05-20"), stmt_line("2030-06-18", "640.00", "2030-07-13")],
    )
    for _ in range(2):  # promoted by this request, then by an earlier one
        with pytest.raises(ApiError, match=r"2030-06-20 has closed \(2030-06-18\)"):
            cc_statements.save_expected(
                h.path,
                {
                    "accountPath": CARD,
                    "expectId": "2030-06-20",
                    "estimatedBalance": "300",
                },
                D(2030, 6, 22),
            )
        assert store.list_expected_statements(h.path) == {}
    with pytest.raises(ApiError, match="no longer current"):
        cc_statements.save_expected(
            h.path, {"accountPath": CARD, "expectId": "2030-09-09"}, D(2030, 6, 22)
        )
    assert store.list_expected_statements(h.path) == {}


def test_expected_delete_only_if_empty(h):
    statement_mode(h)
    body = {"accountPath": CARD, "onlyIfEmpty": True}
    # Created by opening the dialog, nothing entered: removed.
    cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    cc_statements.delete_expected(h.path, body, TODAY)
    assert store.list_expected_statements(h.path) == {}
    # An estimate was saved: kept, no error.
    cc_statements.save_expected(
        h.path, {"accountPath": CARD, "estimatedBalance": "50"}, TODAY
    )
    cc_statements.delete_expected(h.path, body, TODAY)
    assert store.list_expected_statements(h.path)[CARD].estimatedBalance == "50.00"
    # Override plans sit on it: kept, no error.
    cc_statements.save_expected(
        h.path, {"accountPath": CARD, "estimatedBalance": None}, TODAY
    )
    cc_statements.save_override(h.path, _body(statement_id="2030-06-20"), TODAY)
    cc_statements.delete_expected(h.path, body, TODAY)
    assert CARD in store.list_expected_statements(h.path)


def test_cc_card_save_repredicts_expected_when_a_day_hint_changes(h):
    statement_mode(h)  # close day 20, due day 15
    cc_statements.save_expected(
        h.path, {"accountPath": CARD, "estimatedBalance": "75"}, TODAY
    )
    stored = json.loads((h.plan_dir / "cc-cards.json").read_text())[CARD]

    def save(**changes):
        cc_statements.save_cc_card(h.path, {"accountPath": CARD, **stored, **changes})
        return store.list_expected_statements(h.path)[CARD]

    same = save()
    assert (same.id, same.dueDate) == ("2030-06-20", "2030-07-15")
    moved = save(paymentDueDay=5)
    assert (moved.id, moved.dueDate) == ("2030-06-20", "2030-07-05")
    assert (moved.estimatedBalance, moved.afterId) == ("75.00", "2030-05-20")
    payload = h.grid(TODAY)
    assert card(payload)["nextDueDate"] == "2030-07-05"
    # The closing-day hint does not move it: the last real close leads.
    moved = save(paymentDueDay=5, statementCloseDay=22)
    assert (moved.id, moved.dueDate) == ("2030-06-20", "2030-07-05")
    # Once a payment is planned on it, the statement no longer moves.
    cc_statements.save_override(h.path, _body(statement_id="2030-06-20"), TODAY)
    kept = save(paymentDueDay=9, statementCloseDay=25)
    assert (kept.id, kept.dueDate) == ("2030-06-20", "2030-07-05")


# ---------- cc_expected_save / cc_expected_delete ----------


def test_expected_create_predicts_id_and_due(h):
    statement_mode(h)
    saved = cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    assert (saved.id, saved.dueDate) == ("2030-06-20", "2030-07-15")
    assert (saved.afterId, saved.estimatedBalance) == ("2030-05-20", None)
    assert saved.createdAt and saved.updatedAt
    on_disk = json.loads(h.expected_file.read_text())
    assert set(on_disk[CARD]) == {"id", "dueDate", "afterId", "createdAt", "updatedAt"}
    assert cc_statements.expected_payload(saved) == {
        "kind": "expected",
        "account": CARD,
        "id": "2030-06-20",
        "dueDate": "2030-07-15",
        "estimatedBalance": None,
        "afterId": "2030-05-20",
        "createdAt": saved.createdAt,
        "updatedAt": saved.updatedAt,
    }
    # Creating again is an update: nothing changes but updatedAt.
    again = cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    assert (again.id, again.dueDate, again.createdAt) == (
        saved.id,
        saved.dueDate,
        saved.createdAt,
    )

    # Given values are used; no hints means last close + cycle, due + 25 days.
    h.expected_file.unlink()
    h.write_cc_cards({})
    saved = cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    assert (saved.id, saved.dueDate) == ("2030-06-20", "2030-07-15")
    h.expected_file.unlink()
    saved = cc_statements.save_expected(
        h.path,
        {
            "accountPath": CARD,
            "id": "2030-06-22",
            "dueDate": "2030-07-18",
            "estimatedBalance": "850",
        },
        TODAY,
    )
    assert (saved.id, saved.dueDate, saved.estimatedBalance) == (
        "2030-06-22",
        "2030-07-18",
        "850.00",
    )
    resp = cc_statements.statements_response(h.path, CARD, TODAY)
    assert resp["expectedStatement"]["id"] == "2030-06-22"
    assert [s["id"] for s in resp["statements"]] == ["2030-05-20"]


def test_expected_create_rejected_in_legacy_mode(h):
    h.write_cc_cards(CARD_CFG)
    with pytest.raises(ApiError) as err:
        cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    assert err.value.message == "card has no statement records yet"
    with pytest.raises(ApiError):
        cc_statements.save_expected(h.path, {}, TODAY)
    assert not h.expected_file.exists()
    resp = cc_statements.statements_response(h.path, CARD, TODAY)
    assert resp == {
        "account": CARD,
        "hasStatements": False,
        "statements": [],
        "expectedStatement": None,
    }
    with pytest.raises(ApiError):
        cc_statements.statements_response(h.path, "", TODAY)


def test_expected_update_estimated_balance_set_and_clear(h):
    statement_mode(h)
    cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)

    def save(**fields):
        return cc_statements.save_expected(
            h.path, {"accountPath": CARD, **fields}, TODAY
        )

    assert save(estimatedBalance="1,234.5").estimatedBalance == "1234.50"
    # Key absent, or id / dueDate null: stored values are kept.
    kept = save(id=None, dueDate=None)
    assert (kept.id, kept.dueDate, kept.estimatedBalance) == (
        "2030-06-20",
        "2030-07-15",
        "1234.50",
    )
    assert save(estimatedBalance="").estimatedBalance is None
    assert "estimatedBalance" not in json.loads(h.expected_file.read_text())[CARD]
    assert save(estimatedBalance="20").estimatedBalance == "20.00"
    assert save(estimatedBalance=None).estimatedBalance is None
    # Zero or less would hide the forecast row (the way back to this
    # dialog), so it is not an estimate.
    for bad in ("abc", "NaN", "Infinity", "0", "0.00", "-20"):
        with pytest.raises(ApiError):
            save(estimatedBalance=bad)
    assert store.list_expected_statements(h.path)[CARD].estimatedBalance is None


def test_expected_id_must_be_after_newest_closed(h):
    statement_mode(h)

    def save(**fields):
        return cc_statements.save_expected(
            h.path, {"accountPath": CARD, **fields}, TODAY
        )

    for bad_id in ("2030-05-20", "2030-05-01", "2030-6-20", "soon"):
        with pytest.raises(ApiError):
            save(id=bad_id)
    # dueDate must be a date strictly after the closing date.
    for bad_due in ("2030-06-21", "2030-06-01", "later"):
        with pytest.raises(ApiError):
            save(id="2030-06-21", dueDate=bad_due)
    assert not h.expected_file.exists()
    assert save(id="2030-05-21", dueDate="2030-05-22").id == "2030-05-21"


def test_expected_id_change_repoints_plans(h):
    statement_mode(h)
    cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    (p,) = cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-06-20",
            plans=[{"date": "2030-07-10", "account": BANK, "amount": "-180.00"}],
        ),
        TODAY,
    )
    cc_statements.save_override(h.path, _body(statement_id="2030-05-20"), TODAY)

    moved = cc_statements.save_expected(
        h.path,
        {"accountPath": CARD, "id": "2030-06-23", "dueDate": "2030-07-18"},
        TODAY,
    )
    assert (moved.id, moved.dueDate, moved.afterId) == (
        "2030-06-23",
        "2030-07-18",
        "2030-05-20",
    )
    tags = {q.id: q.ccStatementId for q in store.list_plans(h.path)}
    assert tags[p.id] == "2030-06-23"
    assert sorted(tags.values()) == ["2030-05-20", "2030-06-23"]
    out = h.grid(TODAY)
    assert entries(out, "cc-forecast") == []
    kinds = {e["id"]: e["ccStatementKind"] for e in entries(out, "plan")}
    assert kinds[p.id] == "expected"


def test_expected_delete_rejected_while_plans_reference_it(h):
    statement_mode(h)
    cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    cc_statements.save_override(
        h.path,
        _body(
            statement_id="2030-06-20",
            plans=[{"date": "2030-07-10", "account": BANK, "amount": "-180.00"}],
        ),
        TODAY,
    )
    with pytest.raises(ApiError) as err:
        cc_statements.delete_expected(h.path, {"accountPath": CARD}, TODAY)
    assert (
        err.value.message == "expected statement has override plans; reset them first"
    )
    assert CARD in store.list_expected_statements(h.path)

    # Reset the overrides, then it can go.
    cc_statements.save_override(
        h.path, _body(statement_id="2030-06-20", plans=[]), TODAY
    )
    cc_statements.delete_expected(h.path, {"accountPath": CARD}, TODAY)
    assert store.list_expected_statements(h.path) == {}
    # Deleting a missing record is a no-op.
    cc_statements.delete_expected(h.path, {"accountPath": CARD}, TODAY)
    with pytest.raises(ApiError):
        cc_statements.delete_expected(h.path, {}, TODAY)


def test_expected_store_drops_malformed_records(h):
    h.write_expected(
        {
            CARD: {"id": "2030-06-20", "dueDate": "2030-07-15"},
            "Liabilities:Credit:A": {"dueDate": "2030-07-15"},
            "Liabilities:Credit:B": {"id": "June"},
            "Liabilities:Credit:C": "nope",
        }
    )
    assert list(store.list_expected_statements(h.path)) == [CARD]
    h.expected_file.write_text("[1, 2]")
    assert store.list_expected_statements(h.path) == {}
    assert store.statements_dir(h.path) == h.root / "statements"


# ---------- plan_save, cc_card_save, auto-clear ----------


def test_plan_save_preserves_cc_tags_when_keys_absent(h):
    h.write_plans(
        [
            plan_row(
                "new",
                "2030-06-14",
                "-650.00",
                ccCardRef=CARD,
                ccCycleMonth=None,
                ccStatementId="2030-05-20",
            ),
            plan_row(
                "old", "2030-06-14", "-650.00", ccCardRef=CARD, ccCycleMonth="2030-06"
            ),
        ]
    )

    def tags(pid):
        p = next(p for p in store.list_plans(h.path) if p.id == pid)
        return (p.ccCardRef, p.ccCycleMonth, p.ccStatementId, p.amount, p.date)

    # An inline edit / move sends no tag keys: they are kept.
    edit = {"date": "2030-06-13", "account": BANK, "amount": "-600.00"}
    cc_statements.save_plan_from_body(h.path, {"id": "new", **edit})
    cc_statements.save_plan_from_body(h.path, {"id": "old", **edit})
    assert tags("new") == (CARD, None, "2030-05-20", "-600.00", "2030-06-13")
    assert tags("old") == (CARD, "2030-06", None, "-600.00", "2030-06-13")

    # A key that is present is used as given, null included.
    cc_statements.save_plan_from_body(
        h.path, {"id": "new", **edit, "ccStatementId": "2030-06-20"}
    )
    assert tags("new")[:3] == (CARD, None, "2030-06-20")
    cc_statements.save_plan_from_body(
        h.path,
        {
            "id": "new",
            **edit,
            "ccCardRef": None,
            "ccCycleMonth": None,
            "ccStatementId": None,
        },
    )
    assert tags("new")[:3] == (None, None, None)

    # A new plan (no id, or an unknown id) has no tags unless given.
    fresh = cc_statements.save_plan_from_body(h.path, edit)
    assert fresh.id and (fresh.ccCardRef, fresh.ccCycleMonth, fresh.ccStatementId) == (
        None,
        None,
        None,
    )
    made = cc_statements.save_plan_from_body(
        h.path, {"id": "x1", **edit, "ccCardRef": CARD}
    )
    assert (made.ccCardRef, made.ccStatementId) == (CARD, None)


def test_cc_card_save_keeps_stored_statement_balance_in_statement_mode(h):
    h.write_cc_cards(
        {
            CARD: {
                **CARD_CFG[CARD],
                "statementBalance": "111.00",
                "lastClosedDate": "2030-04-20",
            }
        }
    )
    h.write_statements("DemoCard", [stmt_line("2030-05-20")])
    body = {
        "accountPath": CARD,
        "fundingAccount": "Assets:Checking:Other",
        "statementCloseDay": 21,
        "paymentDueDay": 16,
        "minimumPaymentOnly": True,
        "statementBalance": "999.99",
        "lastClosedDate": "2030-06-01",
    }
    cc_statements.save_cc_card(h.path, body)
    rec = store.list_cc_card_records(h.path)[CARD]
    assert (rec.statementBalance, rec.lastClosedDate) == ("111.00", "2030-04-20")
    assert (rec.fundingAccount, rec.statementCloseDay, rec.paymentDueDay) == (
        "Assets:Checking:Other",
        21,
        16,
    )
    assert rec.minimumPaymentOnly is True

    # Legacy mode (no statements): the typed values are saved as before.
    h.write_statements("DemoCard", [])
    cc_statements.save_cc_card(h.path, body)
    rec = store.list_cc_card_records(h.path)[CARD]
    assert (rec.statementBalance, rec.lastClosedDate) == ("999.99", "2030-06-01")

    # Statement mode, no stored record: nothing typed is kept.
    h.write_cc_cards({})
    h.write_statements("DemoCard", [stmt_line("2030-05-20")])
    cc_statements.save_cc_card(h.path, body)
    rec = store.list_cc_card_records(h.path)[CARD]
    assert (rec.statementBalance, rec.lastClosedDate) == (None, None)
    with pytest.raises(ApiError):
        cc_statements.save_cc_card(h.path, {})


def test_auto_clear_pending_keeps_statement_id(h, monkeypatch):
    statement_mode(h)
    # Matches the cleared 300.00 payment of 05-28 on the bank side.
    h.write_plans(
        [
            plan_row(
                "paid",
                "2030-05-28",
                "-300.00",
                state="pending",
                ccCardRef=CARD,
                ccStatementId="2030-05-20",
            )
        ]
    )
    before = h.plans_file.read_bytes()

    # Read-only mount: the grid still renders, the plan shows as cleared.
    def read_only(*a, **k):
        raise PermissionError("read-only file system")

    monkeypatch.setattr(store, "save_plan", read_only)
    out = h.grid(TODAY)
    assert out["pendingCount"] == 0
    assert h.plans_file.read_bytes() == before
    monkeypatch.undo()

    h.grid(TODAY)
    (p,) = store.list_plans(h.path)
    assert p.state is None
    assert (p.ccCardRef, p.ccStatementId, p.ccCycleMonth) == (CARD, "2030-05-20", None)
    # Idempotent: a second pass appends nothing.
    after = h.plans_file.read_bytes()
    assert after != before
    h.grid(TODAY)
    assert h.plans_file.read_bytes() == after


def test_stranded_legacy_row_is_adopted_by_the_expected_statement(h):
    # A next-cycle override saved before the card had statement records
    # (ccCycleMonth 2030-07). Once statements exist a cycle-month save is
    # refused, so the web creates the expected statement instead: the row
    # then maps to it and can be edited or reset through the statement.
    statement_mode(h)
    h.write_plans(
        [
            plan_row(
                "old", "2030-07-15", "-50.00", ccCardRef=CARD, ccCycleMonth="2030-07"
            )
        ]
    )

    def row(payload):
        return next(e for e in entries(payload) if e["id"] == "old")

    before = row(h.grid(TODAY))
    assert (before["ccStatementId"], before["ccStatementKind"]) == (None, "legacy")
    assert card(h.grid(TODAY))["nextDueDate"] == "2030-07-15"
    with pytest.raises(ApiError, match="statementId required"):
        cc_statements.save_override(h.path, _body(cycle_month="2030-07"), TODAY)

    exp = cc_statements.save_expected(h.path, {"accountPath": CARD}, TODAY)
    after = row(h.grid(TODAY))
    assert (after["ccStatementId"], after["ccStatementKind"]) == (exp.id, "expected")
    # Reset to projection through the statement removes the legacy row.
    cc_statements.save_override(h.path, _body(statement_id=exp.id, plans=[]), TODAY)
    assert [p.id for p in store.list_plans(h.path)] == []
