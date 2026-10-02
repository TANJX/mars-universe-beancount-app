from datetime import date
from pathlib import Path

import pytest
from beancount_tooling.fetch import guards
from beancount_tooling.fetch.config import load_config

FIXTURES = Path(__file__).parent / "fixtures"


# --- records ---------------------------------------------------------------


def test_split_records_keeps_quoted_newlines(fixture_text):
    records = guards.split_records(fixture_text("amex_activity.csv"))
    assert len(records) == 4  # header + 3 multi-line transactions
    assert "DEMO NOODLE BAR\nSPRINGFIELD" in records[1]


def test_split_records_crlf(fixture_text):
    records = guards.split_records(fixture_text("bofa_credit.csv"))
    assert len(records) == 4
    assert not any(r.endswith("\r") for r in records)


def test_parse_table_checking_skips_summary_and_beginning_balance(fixture_text):
    table = guards.parse_table(fixture_text("bofa_checking.csv"))
    assert table.header[0] == "Date"
    assert len(table.rows) == 3
    assert table.first_date == date(2030, 9, 3)
    assert table.last_date == date(2030, 9, 20)


def test_parse_table_bofa_credit_uses_posted_date(fixture_text):
    table = guards.parse_table(fixture_text("bofa_credit.csv"))
    assert table.header[table.date_index] == "Posted Date"
    assert [r.date.day for r in table.rows] == [2, 5, 12]


# --- guard 1 ---------------------------------------------------------------


def test_bofa_placeholder(fixture_text):
    assert guards.is_bofa_placeholder(
        fixture_text("bofa_checking_placeholder.csv"), "checking"
    )
    assert guards.is_bofa_placeholder(
        fixture_text("bofa_checking_placeholder.csv"), "credit"
    )
    assert not guards.is_bofa_placeholder(fixture_text("bofa_checking.csv"), "checking")
    assert not guards.is_bofa_placeholder(fixture_text("bofa_credit.csv"), "credit")
    # checking export without the blank separator line
    assert guards.is_bofa_placeholder("Date,Description,Amount\r\n", "checking")


# --- guard 2 ---------------------------------------------------------------


def _stage(tmp_path: Path, account_path: str, fixture: str) -> Path:
    d = tmp_path / account_path
    d.mkdir(parents=True)
    dest = d / "staged.csv"
    dest.write_bytes((FIXTURES / fixture).read_bytes())
    return dest


@pytest.mark.parametrize(
    "bank, index, fixture, expected",
    [
        ("bofa", 0, "bofa_checking.csv", 3),
        ("bofa", 1, "bofa_credit.csv", 3),
        ("amex", 0, "amex_activity.csv", 3),
    ],
)
def test_parse_with_real_importer(tmp_path, bank, index, fixture, expected):
    cfg = load_config()
    account = cfg.banks[bank].accounts[index]
    staged = _stage(tmp_path, account.path, fixture)
    result = guards.parse_with_importer(staged, account, cfg.payment_account)
    assert result.ok, result.message
    assert result.entries == expected


def test_parse_rejects_file_outside_account_dir(tmp_path):
    cfg = load_config()
    account = cfg.banks["amex"].accounts[0]
    staged = _stage(tmp_path, "credit/SomethingElse", "amex_activity.csv")
    result = guards.parse_with_importer(staged, account, cfg.payment_account)
    assert not result.ok
    assert "did not identify" in result.message


def test_parse_placeholder_checking_is_zero_rows(tmp_path):
    cfg = load_config()
    account = cfg.banks["bofa"].accounts[0]
    staged = _stage(tmp_path, account.path, "bofa_checking_placeholder.csv")
    assert not guards.parse_with_importer(staged, account, cfg.payment_account).ok
    assert guards.parse_with_importer(
        staged, account, cfg.payment_account, expect_empty=True
    ).ok


def test_parse_reports_importer_crash(tmp_path):
    cfg = load_config()
    account = cfg.banks["bofa"].accounts[1]
    staged = _stage(tmp_path, account.path, "bofa_credit.csv")
    staged.write_text(
        "Posted Date,Reference Number,Payee,Address,Amount\nnot-a-date,1,X,Y,1\n"
    )
    result = guards.parse_with_importer(staged, account, cfg.payment_account)
    assert not result.ok
    assert "importer failed" in result.message


# --- guard 3 ---------------------------------------------------------------

AMEX_NEXT = (
    "09/22/2030,SAMPLE GROCER,12.00,SAMPLE GROCER,SAMPLE GROCER,,,,,"
    "'900000000000000004',Merchandise & Supplies-Groceries\n"
)


def test_overlap_identical_is_ok(fixture_text):
    t = guards.parse_table(fixture_text("amex_activity.csv"))
    result = guards.check_overlap(t, t)
    assert result.ok and result.added == 0 and result.aged_out == 0


def test_overlap_new_rows_and_aged_out(fixture_text):
    text = fixture_text("amex_activity.csv")
    records = guards.split_records(text)
    # Drop the oldest transaction off the front, append a new one.
    new_text = "\n".join([records[0], *records[2:]]) + "\n" + AMEX_NEXT
    old, new = guards.parse_table(text), guards.parse_table(new_text)
    result = guards.check_overlap(old, new)
    assert result.ok, result.missing
    assert result.added == 1
    assert result.aged_out == 1
    assert result.new_range == (date(2030, 9, 9), date(2030, 9, 22))


def test_overlap_wrong_timezone_uniform_shift(fixture_text):
    text = fixture_text("bofa_credit.csv")
    shifted = (
        text.replace("09/02/2030", "09/03/2030")
        .replace("09/05/2030", "09/06/2030")
        .replace("09/12/2030", "09/13/2030")
    )
    # Old file ran a little longer so its rows fall inside the new range.
    result = guards.check_overlap(guards.parse_table(text), guards.parse_table(shifted))
    assert result.status == guards.OVERLAP_TIMEZONE
    assert result.shift_days == 1
    assert len(result.missing) == 2  # 09/05 and 09/12 fall in 09/03..09/13


def test_overlap_genuine_redate_is_missing(fixture_text):
    text = fixture_text("bofa_credit.csv")
    changed = text.replace("-4.75", "-4.80")
    result = guards.check_overlap(guards.parse_table(text), guards.parse_table(changed))
    assert result.status == guards.OVERLAP_MISSING
    assert [r.date for r in result.missing] == [date(2030, 9, 5)]


def test_overlap_mixed_offsets_is_missing(fixture_text):
    text = fixture_text("bofa_credit.csv")
    mixed = text.replace("09/05/2030", "09/06/2030").replace("09/12/2030", "09/14/2030")
    result = guards.check_overlap(guards.parse_table(text), guards.parse_table(mixed))
    assert result.status == guards.OVERLAP_MISSING


def test_overlap_duplicate_rows_counted(fixture_text):
    text = fixture_text("bofa_credit.csv")
    records = guards.split_records(text)
    doubled = "\r\n".join([*records, records[2]]) + "\r\n"
    old, new = guards.parse_table(doubled), guards.parse_table(text)
    result = guards.check_overlap(old, new)
    assert result.status == guards.OVERLAP_MISSING
    assert len(result.missing) == 1


def test_overlap_checking_range_change_ignores_beginning_balance(fixture_text):
    text = fixture_text("bofa_checking.csv")
    later = text.replace(
        '09/01/2030,Beginning balance as of 09/01/2030,,"1,000.00"',
        '09/05/2030,Beginning balance as of 09/05/2030,,"3,500.00"',
    )
    result = guards.check_overlap(guards.parse_table(later), guards.parse_table(text))
    assert result.ok


AMEX_SAME_DAY = (
    "09/09/2030,SAMPLE CAFE,7.00,SAMPLE CAFE,SAMPLE CAFE,,,,,"
    "'900000000000000005',Restaurant-Restaurant\n"
)


def _amex_header(text):
    return guards.split_records(text)[0] + "\n"


def test_key_column_follows_importer():
    cfg = load_config()
    amex = cfg.banks["amex"].accounts[0]
    card = cfg.banks["bofa"].accounts[1]
    checking = cfg.banks["bofa"].accounts[0]
    assert guards.key_column_for(amex) == "Reference"
    assert guards.key_column_for(card) == "Reference Number"
    assert guards.key_column_for(checking) is None


def test_overlap_reference_key_ignores_enriched_columns(fixture_text):
    new_text = fixture_text("amex_activity.csv")
    # The older export had not filled in Category or the address yet.
    old_text = new_text.replace(",Merchandise & Supplies-Books", ",").replace(
        '"2 EXAMPLE AVE\nSPRINGFIELD XX"', ""
    )
    assert old_text != new_text
    old, new = guards.parse_table(old_text), guards.parse_table(new_text)
    assert guards.check_overlap(old, new).status == guards.OVERLAP_MISSING
    result = guards.check_overlap(old, new, key_column="Reference")
    assert result.ok and result.added == 0


def test_overlap_reference_key_still_catches_date_shift(fixture_text):
    text = fixture_text("amex_activity.csv")
    shifted = text.replace("09/09/2030", "09/10/2030").replace(
        "09/15/2030", "09/16/2030"
    )
    old, new = guards.parse_table(text), guards.parse_table(shifted)
    result = guards.check_overlap(old, new, key_column="Reference")
    assert result.status == guards.OVERLAP_TIMEZONE and result.shift_days == 1


def test_overlap_reference_key_catches_amount_change(fixture_text):
    text = fixture_text("bofa_credit.csv")
    changed = text.replace("-4.75", "-4.80")
    old, new = guards.parse_table(text), guards.parse_table(changed)
    result = guards.check_overlap(old, new, key_column="Reference Number")
    assert result.status == guards.OVERLAP_MISSING
    assert [r.date for r in result.missing] == [date(2030, 9, 5)]


def test_overlap_line_hash_importer_stays_byte_identical(fixture_text):
    text = fixture_text("bofa_checking.csv")
    table = guards.parse_table(text)
    first = table.rows[0]
    changed = text.replace(first.fields[1], first.fields[1] + " X", 1)
    result = guards.check_overlap(table, guards.parse_table(changed), key_column=None)
    assert result.status == guards.OVERLAP_MISSING


def test_overlap_rows_moved_to_archive_are_aged_out(fixture_text):
    old_text = fixture_text("amex_activity.csv")
    # Statement closed: the new period starts on the old period's last day.
    new_text = _amex_header(old_text) + AMEX_SAME_DAY + AMEX_NEXT
    old, new = guards.parse_table(old_text), guards.parse_table(new_text)
    assert guards.check_overlap(old, new, key_column="Reference").status == (
        guards.OVERLAP_MISSING
    )
    archive = guards.parse_table(old_text)
    result = guards.check_overlap(old, new, key_column="Reference", archived=[archive])
    assert result.ok, result.missing
    assert result.aged_out == 3 and result.added == 2


# --- guard 4 ---------------------------------------------------------------


def test_sanity_latest_date(fixture_text):
    text = fixture_text("bofa_credit.csv")
    t = guards.parse_table(text)
    older = guards.parse_table(text.replace("09/12/2030", "08/12/2030"))
    assert guards.check_latest_date(t, t).ok
    assert guards.check_latest_date(older, t).ok
    bad = guards.check_latest_date(t, older)
    assert not bad.ok and "before" in bad.message
    assert guards.check_latest_date(guards.Table(), t).ok
    assert not guards.check_latest_date(t, guards.Table()).ok
