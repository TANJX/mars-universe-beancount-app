"""RobinhoodInvestmentImporter on synthetic rows and a synthetic ledger."""

import textwrap
from datetime import date

import pytest
from beancount import loader
from beancount.parser import printer

from beancount_tooling.fetch.banks.robinhood import COLUMNS, write_rows
from beancount_tooling.importer.robinhood_investment import RobinhoodInvestmentImporter

LEDGER = """
2020-01-01 open Assets:Investment:Demo:Brokerage:USD USD
2020-01-01 open Assets:Investment:Demo:Brokerage:AAA AAA
2020-01-01 open Assets:Investment:Demo:Roth-IRA:USD USD
2020-01-01 open Assets:Investment:Demo:Roth-IRA:AAA AAA
2020-01-01 open Assets:Pending-Transfer
2020-01-01 open Income:Rebate:Demo
2020-01-01 open Income:Trading:Stock
2020-01-01 open Income:Trading:Dividend
2020-01-01 open Expenses:Fee

2026-01-05 * "buy"
  Assets:Investment:Demo:Brokerage:AAA   1.5 AAA {100.00 USD}
  Assets:Investment:Demo:Brokerage:USD  -150.00 USD

2026-02-05 * "buy"
  Assets:Investment:Demo:Brokerage:AAA   1 AAA {120.00 USD}
  Assets:Investment:Demo:Brokerage:USD  -120.00 USD
"""
NUMBERS = {"111": "Brokerage", "222": "Roth-IRA"}


def row(**values):
    r = {c: "" for c in COLUMNS}
    r.update(Account="111", Time="10:00:00", Fees="0.00", Amount="0.00", Quantity="")
    r.update(values)
    return r


@pytest.fixture
def ledger():
    entries, errors, _ = loader.load_string(textwrap.dedent(LEDGER))
    assert not errors
    return entries


def write(tmp_path, leaf, rows):
    d = tmp_path / "investment" / "Demo"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{leaf}.csv"
    path.write_text(write_rows(rows))
    return str(path)


def importer(**kw):
    kw.setdefault("cutover", date(2026, 9, 1))
    return RobinhoodInvestmentImporter("Demo", account_numbers=NUMBERS, **kw)


def text(entries):
    return "\n".join(printer.format_entry(e) for e in entries)


def check_loads(ledger_text, entries):
    full = textwrap.dedent(ledger_text) + "\n" + text(entries)
    _, errors, _ = loader.load_string(full)
    assert not errors, errors


def test_identify(tmp_path):
    path = write(tmp_path, "Brokerage", [])
    assert importer().identify(path)
    assert not importer().identify(str(tmp_path / "credit" / "Demo" / "x.csv"))
    assert importer().account(path) == "Assets:Investment:Demo:Brokerage"


def test_cutover_and_existing_refs_skip_rows(tmp_path, ledger):
    rows = [
        row(
            Id="old",
            Date="2026-08-31",
            Type="dividend",
            Amount="1.00",
            Description="Dividend from A",
        ),
        row(
            Id="new",
            Date="2026-09-01",
            Type="dividend",
            Amount="2.00",
            Description="Dividend from A",
        ),
    ]
    path = write(tmp_path, "Brokerage", rows)
    (entry,) = importer().extract(path, ledger)
    assert entry.date == date(2026, 9, 1)
    ref = entry.postings[0].meta["ref"]
    assert ref.startswith("20260901") and ref.isdigit()
    assert importer(existing_refs=[ref]).extract(path, ledger) == []
    assert importer(cutover=None).extract(path, ledger) == []  # no cutover: nothing


def test_buy_then_fifo_sell(tmp_path, ledger):
    rows = [
        row(
            Id="b",
            Date="2026-09-02",
            Type="buy",
            Symbol="AAA",
            Quantity="0.5",
            Price="130",
            Amount="-65.00",
            Description="Alpha market buy 0.5 shares at $130.00",
        ),
        row(
            Id="s",
            Date="2026-09-10",
            Type="sell",
            Symbol="AAA",
            Quantity="2.2",
            Price="140",
            Amount="307.99",
            Fees="0.01",
            Description="Alpha market sell",
        ),
    ]
    entries = importer().extract(write(tmp_path, "Brokerage", rows), ledger)
    out = text(entries)
    assert "0.5 AAA {130 USD}" in out
    # oldest lots first: 1.5 @100, then 0.7 of the 1 @120; the new lot stays open
    assert "-1.5 AAA {100.00 USD} @ 140 USD" in out
    assert "-0.7 AAA {120.00 USD} @ 140 USD" in out
    assert "Expenses:Fee" in out and "Income:Trading:Stock" in out
    check_loads(LEDGER, entries)


def test_sell_short_of_ledger_lots_is_flagged(tmp_path, ledger):
    rows = [
        row(
            Id="s",
            Date="2026-09-10",
            Type="sell",
            Symbol="AAA",
            Quantity="3",
            Price="140",
            Amount="420.00",
            Description="sell",
        )
    ]
    (entry,) = importer().extract(write(tmp_path, "Brokerage", rows), ledger)
    assert entry.flag == "!"
    assert "short by 0.5 AAA" in entry.meta["fixme"]


def test_same_cost_lots_get_dates(tmp_path):
    ledger_text = LEDGER.replace("{120.00 USD}", "{100.00 USD}").replace(
        "-120.00", "-100.00"
    )
    entries, errors, _ = loader.load_string(textwrap.dedent(ledger_text))
    assert not errors
    rows = [
        row(
            Id="s",
            Date="2026-09-10",
            Type="sell",
            Symbol="AAA",
            Quantity="2",
            Price="110",
            Amount="220.00",
            Description="sell",
        )
    ]
    out = importer().extract(write(tmp_path, "Brokerage", rows), entries)
    assert "{100.00 USD, 2026-01-05}" in text(out)
    assert "{100.00 USD, 2026-02-05}" in text(out)
    check_loads(ledger_text, out)


def test_contribution_with_match_and_tax_year(tmp_path, ledger):
    rows = [
        row(
            Id="c",
            Account="222",
            Date="2026-09-04",
            Type="transfer_in",
            Amount="160.00",
            Match="4.80",
            Counterparty="Demo Bank",
            TaxYear="2025",
            Description="Contribution to Roth IRA from Demo Bank",
        )
    ]
    (entry,) = importer().extract(write(tmp_path, "Roth-IRA", rows), ledger)
    out = text([entry])
    assert entry.meta["contribution"].number == 160
    assert entry.meta["tax-year"] == 2025
    assert "Roth-IRA:USD   164.80 USD" in out or "164.80 USD" in out
    assert "Assets:Pending-Transfer" in out and "-4.80 USD" in out
    check_loads(LEDGER, [entry])


def test_internal_transfer_booked_once_on_receiving_side(tmp_path, ledger):
    out_row = row(
        Id="t",
        Date="2026-09-05",
        Type="transfer_out",
        Amount="-100.00",
        Counterparty="222",
        Description="Transfer from individual to Roth IRA",
    )
    in_row = row(
        Id="t",
        Account="222",
        Date="2026-09-05",
        Type="transfer_in",
        Amount="100.00",
        Match="3.00",
        Counterparty="111",
        Description="Transfer to Roth IRA from individual",
    )
    assert importer().extract(write(tmp_path, "Brokerage", [out_row]), ledger) == []
    (entry,) = importer().extract(write(tmp_path, "Roth-IRA", [in_row]), ledger)
    accounts = [p.account for p in entry.postings]
    assert accounts == [
        "Assets:Investment:Demo:Roth-IRA:USD",
        "Assets:Investment:Demo:Brokerage:USD",
        "Income:Rebate:Demo",
    ]
    check_loads(LEDGER, [entry])


@pytest.mark.parametrize(
    "kind, amount, account",
    [
        ("dividend", "1.00", "Income:Trading:Dividend"),
        ("interest", "0.44", "Income:Interest:Demo"),
        ("stock_lending", "0.01", "Income:Trading:Stock"),
        ("cc_rebate", "14.77", "Income:Rebate:Demo"),
        ("deposit_boost", "0.92", "Income:Rebate:Demo"),
        ("margin_interest", "-0.14", "Expenses:Fee"),
    ],
)
def test_cash_row_types(tmp_path, ledger, kind, amount, account):
    rows = [row(Id="x", Date="2026-09-03", Type=kind, Amount=amount, Description="d")]
    (entry,) = importer().extract(write(tmp_path, "Brokerage", rows), ledger)
    assert entry.flag == "*"
    assert [p.account for p in entry.postings] == [
        "Assets:Investment:Demo:Brokerage:USD",
        account,
    ]


def test_unknown_types_are_flagged_and_skipped_types_dropped(tmp_path, ledger):
    rows = [
        row(
            Id="o",
            Date="2026-09-03",
            Type="other",
            Amount="-0.05",
            Description="ADR fee",
        ),
        row(Id="e", Date="2026-09-03", Type="event_contract", Amount="1.00"),
    ]
    (entry,) = importer().extract(write(tmp_path, "Brokerage", rows), ledger)
    assert entry.flag == "!" and entry.postings[1].account == "Equity:FIXME"


def test_check_file_counts_rows_even_before_cutover(tmp_path):
    path = write(
        tmp_path,
        "Brokerage",
        [row(Id="a", Date="2020-01-01", Type="interest", Amount="1")],
    )
    assert len(importer().check_file(path)) == 1
    bad = write(tmp_path, "Roth-IRA", [row(Id="", Date="2020-01-01", Type="interest")])
    with pytest.raises(ValueError):
        importer().check_file(bad)
