"""The card statement billing store: reader, guards, writer, cadence helpers.

Everything here is synthetic (DemoCard, invented amounts) and lives in tmp_path.
"""

import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from beancount_tooling import billing
from beancount_tooling.billing import StatementInfo

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "billing_vectors.json").read_text()
)
CARD = "Liabilities:Credit:DemoCard"
TODAY = date(2030, 6, 18)
CAPTURED = "2030-05-21T13:00:00+00:00"


def _info(closing="2030-05-20", balance="1234.56", due="2030-06-15", minimum="40.00"):
    return billing.parse_info(closing, balance, due, minimum)


def _record(tmp_path, info=None, **kw):
    kw.setdefault("source", "fetch")
    kw.setdefault("today", TODAY)
    kw.setdefault("captured_at", CAPTURED)
    return billing.record_statement(tmp_path, CARD, info or _info(), **kw)


def _file(tmp_path, card="DemoCard"):
    return tmp_path / "billing" / "credit" / f"{card}.jsonl"


# --- reader --------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_reducer_vectors(tmp_path, vector):
    path = _file(tmp_path)
    path.parent.mkdir(parents=True)
    lines = [
        line if isinstance(line, str) else json.dumps(line) for line in vector["lines"]
    ]
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    got = [s.to_dict() for s in billing.read_statements(tmp_path, VECTORS["account"])]
    assert got == vector["expected"]


def test_read_statements_missing_file_is_empty(tmp_path):
    assert billing.read_statements(tmp_path, CARD) == []
    assert billing.read_all(tmp_path) == {}


def test_read_all_groups_by_account_and_ignores_mismatched_file_stem(tmp_path):
    other = "Liabilities:Credit:OtherCard"
    _record(tmp_path)
    _record(tmp_path, _info("2030-06-17", "10.00", None, None))
    billing.record_statement(
        tmp_path, other, _info("2030-06-01", "5.00", None, None), source="manual",
        today=TODAY,
    )  # fmt: skip
    # A line for another card inside DemoCard.jsonl belongs to no file: dropped.
    with _file(tmp_path).open("a") as f:
        f.write(
            json.dumps(
                {"account": "Liabilities:Credit:Stray", "id": "2030-06-02",
                 "statementBalance": "9.00"}
            )
            + "\n"
        )  # fmt: skip
    (_file(tmp_path).parent / "notes.txt").write_text("not a store file\n")
    got = billing.read_all(tmp_path)
    assert list(got) == [CARD, other]
    assert [s.id for s in got[CARD]] == ["2030-05-20", "2030-06-17"]
    assert [s.statementBalance for s in got[other]] == ["5.00"]


# --- writer --------------------------------------------------------------------


def test_record_appends_when_no_line_exists(tmp_path):
    info = StatementInfo(date(2030, 5, 20), Decimal("1234.5"), date(2030, 6, 15))
    result = _record(tmp_path, info)
    assert (result.status, result.statement_id, result.written) == (
        "appended",
        "2030-05-20",
        True,
    )
    text = _file(tmp_path).read_text()
    assert text == (
        '{"account": "Liabilities:Credit:DemoCard", "id": "2030-05-20", '
        '"statementBalance": "1234.50", "dueDate": "2030-06-15", '
        '"minimumPayment": null, "source": "fetch", '
        f'"capturedAt": "{CAPTURED}"}}\n'
    )
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert stmt.statementBalance == "1234.50" and stmt.minimumPayment is None


def test_record_default_captured_at_is_utc_seconds(tmp_path):
    billing.record_statement(tmp_path, CARD, _info(), source="fetch", today=TODAY)
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert stmt.capturedAt.endswith("+00:00") and "." not in stmt.capturedAt


def test_record_identical_read_is_noop(tmp_path):
    _record(tmp_path)
    before = _file(tmp_path).read_bytes()
    # Same facts written differently (1,234.56 vs 1234.560) are still the same.
    again = StatementInfo(
        date(2030, 5, 20), Decimal("1234.560"), date(2030, 6, 15), Decimal(40)
    )
    result = _record(tmp_path, again, captured_at="2030-06-01T00:00:00+00:00")
    assert (result.status, result.written) == ("unchanged", False)
    assert _file(tmp_path).read_bytes() == before


def test_record_conflict_does_not_write_and_reports_diff(tmp_path):
    _record(tmp_path, _info(balance="1200.00"))
    before = _file(tmp_path).read_bytes()
    result = _record(tmp_path, _info(balance="1234.56", due="2030-06-16"))
    assert (result.status, result.written) == ("conflict", False)
    assert "statementBalance 1200.00 on file, 1234.56 read" in result.notes
    assert "dueDate 2030-06-15 on file, 2030-06-16 read" in result.notes
    assert _file(tmp_path).read_bytes() == before


def test_fetch_read_does_not_reinstate_voided_statement(tmp_path):
    _record(tmp_path, _info())
    billing.void_statement(tmp_path, CARD, "2030-05-20")
    assert billing.voided_ids(tmp_path, CARD) == {"2030-05-20"}
    before = _file(tmp_path).read_bytes()
    # The site still shows the statement the owner voided: not written back.
    result = _record(tmp_path, _info())
    assert (result.status, result.written) == ("voided", False)
    assert result.notes == ("voided on file, not written",)
    assert _file(tmp_path).read_bytes() == before
    assert billing.read_statements(tmp_path, CARD) == []
    # Only the terminal prompt re-instates it.
    result = _record(tmp_path, _info(), source="manual", allow_correction=True)
    assert (result.status, result.written) == ("appended", True)
    assert billing.voided_ids(tmp_path, CARD) == set()
    assert [s.id for s in billing.read_statements(tmp_path, CARD)] == ["2030-05-20"]
    # A malformed line after a void does not lift it; other cards are apart.
    billing.void_statement(tmp_path, CARD, "2030-05-20")
    with _file(tmp_path).open("a") as f:
        f.write(
            json.dumps({"account": CARD, "id": "2030-05-20", "statementBalance": "x"})
            + "\n"
        )
    assert billing.voided_ids(tmp_path, CARD) == {"2030-05-20"}
    assert billing.voided_ids(tmp_path, "Liabilities:Credit:Other") == set()


def test_record_manual_correction_appends_and_last_line_wins(tmp_path):
    _record(tmp_path, _info(balance="1200.00"))
    result = _record(
        tmp_path, _info(balance="1234.56"), source="manual", allow_correction=True
    )
    assert (result.status, result.written) == ("corrected", True)
    assert "statementBalance 1200.00 on file, 1234.56 read" in result.notes
    assert len(_file(tmp_path).read_text().splitlines()) == 2
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert (stmt.statementBalance, stmt.source) == ("1234.56", "manual")


def test_record_dry_run_writes_nothing(tmp_path):
    result = _record(tmp_path, dry_run=True)
    assert (result.status, result.written) == ("appended", False)
    assert not (tmp_path / "billing").exists()
    _record(tmp_path, _info(balance="1200.00"))
    before = _file(tmp_path).read_bytes()
    result = _record(tmp_path, allow_correction=True, dry_run=True)
    assert (result.status, result.written) == ("corrected", False)
    assert _file(tmp_path).read_bytes() == before


def test_record_rejected_never_writes(tmp_path):
    result = _record(tmp_path, _info(closing="2030-06-19", due=None))
    assert result.status == "rejected" and not result.written
    assert result.errors == ("closing date 2030-06-19 is after today (2030-06-18)",)
    assert not (tmp_path / "billing").exists()


def test_record_adds_newline_when_file_lacks_trailing_newline(tmp_path):
    path = _file(tmp_path)
    path.parent.mkdir(parents=True)
    first = {"account": CARD, "id": "2030-04-20", "statementBalance": "50.00"}
    path.write_text(json.dumps(first))  # hand edit without a final newline
    _record(tmp_path)
    lines = path.read_text().splitlines()
    assert len(lines) == 2 and json.loads(lines[0]) == first
    assert path.read_text().endswith("\n")
    assert [s.id for s in billing.read_statements(tmp_path, CARD)] == [
        "2030-04-20",
        "2030-05-20",
    ]


def test_void_statement_hides_record_then_new_line_reinstates(tmp_path):
    _record(tmp_path)
    billing.void_statement(tmp_path, CARD, "2030-05-20", captured_at=CAPTURED)
    assert json.loads(_file(tmp_path).read_text().splitlines()[-1]) == {
        "account": CARD,
        "id": "2030-05-20",
        "void": True,
        "source": "manual",
        "capturedAt": CAPTURED,
    }
    assert billing.read_statements(tmp_path, CARD) == []
    # With no record left for the id, a manual entry is an append again.
    result = _record(
        tmp_path, _info(balance="999.00"), source="manual", allow_correction=True
    )
    assert result.status == "appended"
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert stmt.statementBalance == "999.00"
    with pytest.raises(ValueError):
        billing.void_statement(tmp_path, CARD, "May 2030")


# --- guards --------------------------------------------------------------------


def _existing(*ids):
    return [
        billing.Statement(CARD, sid, "10.00", None, None, "fetch", "") for sid in ids
    ]


def test_guard_zero_balance_ok(tmp_path):
    info = _info(balance="0.00", due=None, minimum=None)
    assert billing.check_statement(info, [], TODAY) == []
    assert _record(tmp_path, info).status == "appended"
    assert billing.read_statements(tmp_path, CARD)[0].statementBalance == "0.00"


def test_guard_negative_balance_ok(tmp_path):
    info = _info(balance="(25.10)", due=None, minimum=None)
    assert billing.check_statement(info, [], TODAY) == []
    assert billing.statement_notes(info, []) == []
    assert _record(tmp_path, info).status == "appended"
    assert billing.read_statements(tmp_path, CARD)[0].statementBalance == "-25.10"


def test_guard_null_due_date_ok():
    assert billing.check_statement(_info(due=None), [], TODAY) == []


def test_guard_closing_after_today_rejected():
    errors = billing.check_statement(_info("2030-06-19", due=None), [], TODAY)
    assert errors == ["closing date 2030-06-19 is after today (2030-06-18)"]


def test_guard_closing_equal_today_ok():
    assert billing.check_statement(_info("2030-06-18", due=None), [], TODAY) == []


@pytest.mark.parametrize("due", ["2030-05-20", "2030-05-01"])
def test_guard_due_not_after_closing_rejected(due):
    (error,) = billing.check_statement(_info(due=due), [], TODAY)
    assert "due date" in error and "not after closing date 2030-05-20" in error


def test_guard_negative_minimum_rejected():
    (error,) = billing.check_statement(_info(minimum="-1.00"), [], TODAY)
    assert error == "minimum payment is negative"
    assert billing.check_statement(_info(minimum="0.00"), [], TODAY) == []


def test_guard_non_finite_values_rejected():
    info = StatementInfo(date(2030, 5, 20), Decimal("NaN"), None, Decimal("Infinity"))
    assert billing.check_statement(info, [], TODAY) == [
        "statement balance is not a number",
        "minimum payment is not a number",
    ]
    assert billing.statement_notes(info, []) == []


def test_guard_first_statement_of_new_card_ok():
    assert billing.check_statement(_info(), [], TODAY) == []
    assert billing.statement_notes(_info(), []) == []


def test_guard_gap_of_60_days_is_note_not_failure():
    existing = _existing("2030-03-21")
    info = _info("2030-05-20")
    assert billing.check_statement(info, existing, TODAY) == []
    assert billing.statement_notes(info, existing) == [
        "cycle of 60 days since 2030-03-21"
    ]
    # A usual cycle (25 to 35 days) says nothing.
    assert billing.statement_notes(info, _existing("2030-04-20")) == []
    assert billing.statement_notes(info, _existing("2030-04-25")) == []
    assert billing.statement_notes(info, _existing("2030-04-26")) == [
        "cycle of 24 days since 2030-04-26"
    ]


def test_guard_closing_before_last_record_rejected_unless_existing_id():
    existing = _existing("2030-04-20", "2030-05-20")
    (error,) = billing.check_statement(_info("2030-05-10"), existing, TODAY)
    assert error == (
        "closing date 2030-05-10 is not after the last recorded statement 2030-05-20"
    )
    # Re-reading an older statement that is already on file is fine.
    assert billing.check_statement(_info("2030-04-20"), existing, TODAY) == []
    assert billing.check_statement(_info("2030-05-20"), existing, TODAY) == []
    # Strictly after the newest one is the normal case.
    assert billing.check_statement(_info("2030-05-21", due=None), existing, TODAY) == []


def test_guard_minimum_above_balance_is_note_only():
    info = _info(balance="30.00", minimum="40.00")
    assert billing.check_statement(info, [], TODAY) == []
    assert billing.statement_notes(info, []) == [
        "minimum payment exceeds the statement balance"
    ]
    credit = _info(balance="-5.00", minimum="1.00")  # compared with zero, not -5
    assert billing.statement_notes(credit, []) == [
        "minimum payment exceeds the statement balance"
    ]
    assert billing.statement_notes(_info(balance="40.00", minimum="40.00"), []) == []


def test_guards_ignore_age_of_last_record(tmp_path):
    info = _info("2030-06-17", due="2030-07-12")
    old = (TODAY - timedelta(days=400)).isoformat()
    assert billing.check_statement(info, _existing(old), TODAY) == []
    # Today's own distance from the statement does not matter either.
    far = TODAY + timedelta(days=4000)
    assert billing.check_statement(info, _existing(old), far) == []
    billing.record_statement(
        tmp_path, CARD, _info(old, due=None), source="manual", today=TODAY
    )
    result = _record(tmp_path, info)
    assert result.status == "appended"
    assert result.notes == (f"cycle of 399 days since {old}",)


# --- parsing -------------------------------------------------------------------


def test_parse_money_and_parse_date():
    assert billing.parse_money("$1,234.56") == Decimal("1234.56")
    assert billing.parse_money(" 1 234.5 ") == Decimal("1234.5")
    assert billing.parse_money("0") == 0
    assert billing.parse_money("(12.00)") == Decimal("-12.00")
    assert billing.parse_money("-12.00") == Decimal("-12.00")
    assert billing.parse_money("-$12.00") == Decimal("-12.00")
    assert billing.parse_money("($1,012.00)") == Decimal("-1012.00")
    for bad in ("", "abc", "12.3.4", "NaN", "Infinity", "1e5", "--5", "$"):
        with pytest.raises(ValueError):
            billing.parse_money(bad)

    assert billing.parse_date("2030-05-20") == date(2030, 5, 20)
    assert billing.parse_date(" 5/20/2030 ") == date(2030, 5, 20)
    assert billing.parse_date("05/02/2030") == date(2030, 5, 2)
    for bad in ("", "May 20", "2030-13-40", "20300520", "13/40/2030", "5/20/30"):
        with pytest.raises(ValueError):
            billing.parse_date(bad)


def test_parse_info_optional_fields_and_named_errors():
    info = billing.parse_info("5/20/2030", "$1,234.56", "", None)
    assert info == StatementInfo(date(2030, 5, 20), Decimal("1234.56"), None, None)
    full = billing.parse_info("2030-05-20", "10", "2030-06-15", "$5.00")
    assert (full.due_date, full.minimum_payment) == (date(2030, 6, 15), Decimal("5.00"))
    for args, name in (
        (("soon", "1.00"), "closing date"),
        (("2030-05-20", "lots"), "statement balance"),
        (("2030-05-20", "1.00", "later"), "due date"),
        (("2030-05-20", "1.00", None, "some"), "minimum payment"),
    ):
        with pytest.raises(ValueError, match=name):
            billing.parse_info(*args)


# --- cadence hints -------------------------------------------------------------


def test_valid_day():
    assert all(billing.valid_day(d) for d in (-1, 1, 15, 31))
    assert not any(billing.valid_day(d) for d in (0, 32, -2, None, "5", 5.0, True))


def test_last_expected_close_month_length_clamping():
    # 31 clamps to the end of February (2030 is not a leap year).
    assert billing.last_expected_close(date(2030, 3, 1), 31) == date(2030, 2, 28)
    assert billing.last_expected_close(date(2030, 2, 28), 30) == date(2030, 2, 28)
    assert billing.last_expected_close(date(2030, 2, 27), 30) == date(2030, 1, 30)
    assert billing.last_expected_close(date(2028, 3, 1), 30) == date(2028, 2, 29)
    # January looks back into December of the previous year.
    assert billing.last_expected_close(date(2030, 1, 5), 20) == date(2029, 12, 20)
    assert billing.resolve_day(2030, 4, 31) == date(2030, 4, 30)
    assert billing.resolve_day(2030, 12, -1) == date(2030, 12, 31)


@pytest.mark.parametrize("close_day", [-1, 31])
def test_last_expected_close_last_day_cards(close_day):
    assert billing.last_expected_close(date(2030, 4, 30), close_day) == date(
        2030, 4, 30
    )
    assert billing.last_expected_close(date(2030, 4, 29), close_day) == date(
        2030, 3, 31
    )


def test_last_expected_close_on_closing_day_itself():
    assert billing.last_expected_close(date(2030, 6, 20), 20) == date(2030, 6, 20)
    assert billing.last_expected_close(date(2030, 6, 19), 20) == date(2030, 5, 20)
    assert billing.last_expected_close(date(2030, 6, 21), 20) == date(2030, 6, 20)


def test_predict_due_same_month_and_next_month():
    assert billing.predict_due(date(2030, 6, 5), 25) == date(2030, 6, 25)
    assert billing.predict_due(date(2030, 6, 20), 15) == date(2030, 7, 15)
    # Strictly after the closing date, and across the year end.
    assert billing.predict_due(date(2030, 6, 20), 20) == date(2030, 7, 20)
    assert billing.predict_due(date(2030, 12, 20), 15) == date(2031, 1, 15)
    assert billing.predict_due(date(2030, 1, 31), -1) == date(2030, 2, 28)
    assert billing.predict_due(date(2030, 6, 20), None) is None
    assert billing.predict_due(date(2030, 6, 20), 40) is None


def test_needs_manual_entry_tolerance_window():
    expected = date(2030, 6, 20)
    assert billing.needs_manual_entry([], expected)
    assert not billing.needs_manual_entry(_existing("2030-06-15"), expected)  # -5
    assert billing.needs_manual_entry(_existing("2030-06-14"), expected)  # -6
    assert not billing.needs_manual_entry(_existing("2030-06-22"), expected)  # later
    assert not billing.needs_manual_entry(
        _existing("2030-05-20", "2030-06-20"), expected
    )
    assert billing.needs_manual_entry(_existing("2030-05-20"), expected)
    assert not billing.needs_manual_entry(
        _existing("2030-05-20"), expected, tolerance_days=31
    )
