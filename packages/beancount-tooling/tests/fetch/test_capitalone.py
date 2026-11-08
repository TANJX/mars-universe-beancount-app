"""Capital One fetcher and importer: pure helpers only (no browser, no real site)."""

from datetime import date
from decimal import Decimal

import pytest

from beancount_tooling.fetch.banks import capitalone
from beancount_tooling.fetch.banks.base import get_fetcher
from beancount_tooling.fetch.config import AccountConfig
from beancount_tooling.importer.capital_one import CapitalOneImporter, signed_amount

HEADER = "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n"


def test_registered():
    assert get_fetcher("capitalone") is capitalone.CapitalOneFetcher


def test_account_tile_matches_whole_digit_group():
    pattern = capitalone.account_tile_name("1111")
    assert pattern.search("Quicksilver ...1111")
    assert pattern.search("Quicksilver...1111")
    assert not pattern.search("Quicksilver ...11112")
    with pytest.raises(capitalone.CapitalOneStepError, match="last4"):
        capitalone.account_tile_name(None)


def test_export_range_is_capped_at_a_year():
    account = AccountConfig(
        bank="capitalone", path="credit/Demo-QS", kind="credit", rolling="t.csv"
    )
    today = date(2026, 11, 7)
    assert capitalone.export_range(account, today) == (date(2025, 11, 8), today)


def test_signed_amount():
    assert signed_amount({"Debit": "1,234.50", "Credit": ""}) == "-1234.50"
    assert signed_amount({"Debit": "", "Credit": "20.00"}) == "20.00"


def test_importer_books_purchase_payment_and_refund(tmp_path):
    d = tmp_path / "credit" / "Demo-QS"
    d.mkdir(parents=True)
    f = d / "transactions.csv"
    f.write_text(
        HEADER
        + "2026-10-03,2026-10-04,1111,CAPITAL ONE MOBILE PYMT,Payment/Credit,,500.00\n"
        + "2026-10-02,2026-10-03,1111,SOME SHOP,Merchandise,12.34,\n"
        + "2026-10-01,2026-10-02,1111,SOME SHOP,Merchandise,,5.00\n"
    )
    imp = CapitalOneImporter(
        "Demo-QS",
        payment_account="Assets:Checking:Demo",
        merchant_map={"Some Shop": "Expenses:Shopping"},
    )
    assert imp.identify(str(f))
    entries = imp.extract(str(f), [])
    by_date = {e.date.isoformat(): e for e in entries}
    pay = by_date["2026-10-03"].postings
    assert pay[0].units.number == Decimal("500.00")
    assert pay[1].account == "Assets:Checking:Demo"
    buy = by_date["2026-10-02"].postings
    assert buy[0].units.number == Decimal("-12.34")
    refund = by_date["2026-10-01"].postings
    assert refund[1].account == "Equity:FIXME"


BANK_HEADER = "Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance\n"


def test_bank_importer_signs_and_routes(tmp_path):
    from beancount_tooling.importer.capital_one_bank import CapitalOneBankImporter

    d = tmp_path / "saving" / "Demo-360"
    d.mkdir(parents=True)
    f = d / "transactions.csv"
    f.write_text(
        BANK_HEADER
        + "1111,Interest Paid,03/31/25,Credit,0.04,0.04\n"
        + "1111,ACH Withdrawal DEMO,03/05/25,Debit,100.03,0\n"
        + "1111,ACH Returned to DEMO,02/27/25,Debit,-100,100.01\n"
    )
    imp = CapitalOneBankImporter("Demo-360", type="saving")
    assert imp.identify(str(f))
    entries = {e.date.isoformat(): e.postings for e in imp.extract(str(f), [])}
    assert entries["2025-03-31"][0].units.number == Decimal("0.04")
    assert entries["2025-03-31"][1].account == "Income:Interest:Demo-360"
    assert entries["2025-03-05"][0].units.number == Decimal("-100.03")
    assert entries["2025-03-05"][1].account == "Assets:Pending-Transfer"
    assert entries["2025-02-27"][0].units.number == Decimal("100.00")


def test_guard_dates_read_two_digit_years():
    from datetime import date as d

    from beancount_tooling.fetch.guards import _parse_date

    assert _parse_date("03/31/25") == d(2025, 3, 31)
    assert _parse_date("03/31/2025") == d(2025, 3, 31)
    assert _parse_date("2025-03-31") == d(2025, 3, 31)
