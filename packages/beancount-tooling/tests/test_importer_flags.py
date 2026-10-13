"""Importer flags and second legs on synthetic rows.

The flag only answers "is this posted at the bank?": `*` posted, `!` pending.
A row the importer can't categorize keeps `*` and gets an Equity:FIXME leg.
Every emitted transaction has a second posting.
"""

import textwrap

import pytest
from beancount_tooling.importer.amex import AmexImporter, clean_payee
from beancount_tooling.importer.apple import AppleImporter
from beancount_tooling.importer.apple_saving import AppleSavingImporter
from beancount_tooling.importer.bilt import BiltImporter
from beancount_tooling.importer.bofa import BofAImporter
from beancount_tooling.importer.chase import ChaseImporter
from beancount_tooling.importer.chase_checking import ChaseCheckingImporter
from beancount_tooling.importer.citi_checking import CitiCheckingImporter
from beancount_tooling.importer.discover import DiscoverImporter
from beancount_tooling.importer.discover_saving import DiscoverSavingImporter
from beancount_tooling.importer.robinhood import RobinhoodImporter
from beancount_tooling.importer.td_checking import TDCheckingImporter
from beancount_tooling.importer.wells_fargo_checking import (
    WellsFargoCheckingImporter,
)

PAY = "Assets:Pending-Transfer"


def legs(result):
    postings, payee, flag = result
    return [p.account for p in postings], payee, flag


# --- checking / saving: unknown descriptions -----------------------------------

UNKNOWN_BANK_ROWS = [
    (
        TDCheckingImporter("DemoTD"),
        {"Description": "DEMO MERCHANT 123", "Debit": "12.34", "Credit": ""},
    ),
    (
        ChaseCheckingImporter("DemoChase"),
        {"Description": "DEMO MERCHANT 123", "Amount": "-12.34"},
    ),
    (
        RobinhoodImporter("DemoRH", type="checking"),
        {"Description": "Demo merchant 123", "Amount": "-12.34"},
    ),
    (
        RobinhoodImporter("DemoRH", type="saving"),
        {"Description": "Demo merchant 123", "Amount": "-12.34"},
    ),
    (
        CitiCheckingImporter("DemoCiti"),
        {"Description": "DEMO MERCHANT 123", "Debit": "12.34", "Credit": ""},
    ),
    (
        WellsFargoCheckingImporter("DemoWF"),
        {"Description": "DEMO MERCHANT 123", "Amount": "-12.34"},
    ),
    (
        AppleSavingImporter("DemoAppleSaving"),
        {
            "Description": "Demo merchant",
            "Amount": "12.34",
            "Transaction Type": "Debit",
        },
    ),
    (
        DiscoverSavingImporter("DemoDiscoverSaving"),
        {
            "Transaction Description": "Demo merchant",
            "Credit": "",
            "Debit": "12.34",
            "Transaction Type": "Debit",
        },
    ),
]


@pytest.mark.parametrize(
    "importer,row", UNKNOWN_BANK_ROWS, ids=lambda x: type(x).__name__
)
def test_bank_unknown_description_is_posted_with_fixme_leg(importer, row):
    accounts, _, flag = legs(importer.handle_transaction(row, ""))
    assert flag == "*"
    assert accounts[1] == "Equity:FIXME"


def test_bank_known_description_still_categorized():
    accounts, _, flag = legs(
        TDCheckingImporter("DemoTD").handle_transaction(
            {"Description": "ONLINE XFER TRANSFER TO DEMO", "Debit": "5", "Credit": ""},
            "",
        )
    )
    assert (accounts[1], flag) == (PAY, "*")


# --- Amex ------------------------------------------------------------------------

AMEX_HEADER = (
    "Date,Description,Amount,Extended Details,Appears On Your Statement As,"
    "Address,City/State,Zip Code,Country,Reference,Category\n"
)


def amex_row(desc, amt, details="", category="", status=None):
    row = {
        "Description": desc,
        "Amount": amt,
        "Extended Details": details,
        "Category": category,
        "Reference": "'900000000000000009'",
    }
    if status is not None:
        row["Status"] = status
    return row


def amex():
    return AmexImporter("DemoAmex", payment_account=PAY, merchant_map={})


@pytest.mark.parametrize(
    "desc",
    [
        "MOBILE PAYMENT - THANK YOU",
        "ONLINE PAYMENT - THANK YOU",
        "AUTOPAY PAYMENT - THANK YOU",
    ],
)
def test_amex_payment(desc):
    accounts, _, flag = legs(amex().handle_transaction(amex_row(desc, "-50.00"), ""))
    assert (accounts[1], flag) == (PAY, "*")


@pytest.mark.parametrize(
    "row,payee",
    [
        (
            amex_row(
                "DEMO TRANSIT        SPRINGFIELD",
                "-2.90",
                details="Amex Offer Credit DEMO TRANSIT SPRINGFIELD Amex Offer Credit",
                category="Transportation-Rail Services",
            ),
            "Demo Transit",
        ),
        (
            amex_row(
                "AMEX Dining Credit",
                "-10.00",
                details="DEMO DELIVERY*CAFE AMEX Dining Credit",
            ),
            "Amex Dining Credit",
        ),
        (
            amex_row("AMEX DEMO BENEFIT CREDIT", "-7.00", details="DEMO SHOP 001"),
            "Amex Demo Benefit Credit",
        ),
        (
            amex_row("YOUR CASH REWARD/REFUND IS", "-12.00"),
            "Your Cash Reward/Refund Is",
        ),
    ],
)
def test_amex_statement_credit_is_posted_rebate(row, payee):
    accounts, got_payee, flag = legs(amex().handle_transaction(row, ""))
    assert (accounts[1], flag, got_payee) == ("Income:Rebate:Amex", "*", payee)


def test_amex_merchant_refund_gets_fixme_leg():
    row = amex_row(
        "DEMO AIRLINE        SPRINGFIELD         XX",
        "-80.00",
        details="0000 PASSENGER TICKET DEMO AIRLINE",
        category="Travel-Airline",
    )
    accounts, payee, flag = legs(amex().handle_transaction(row, ""))
    assert (accounts[1], flag, payee) == ("Equity:FIXME", "*", "Demo Airline")


def test_amex_pending_status_column_keeps_bang():
    row = amex_row("ONLINE PAYMENT - THANK YOU", "-50.00", status="Pending")
    _, _, flag = legs(amex().handle_transaction(row, ""))
    assert flag == "!"


@pytest.mark.parametrize(
    "desc,payee",
    [
        ("DEMO TRANSIT        SPRINGFIELD", "Demo Transit"),
        ("DEMO NOODLE BAR     SPRINGFIELD         NY", "Demo Noodle Bar"),
        ("AplPay DEMO RIDE    help.example.com    CA", "Demo Ride"),
        ("DEMO MARKETPLACE", "Demo Marketplace"),
    ],
)
def test_amex_clean_payee(desc, payee):
    assert clean_payee(desc) == payee


def test_amex_debit_matches_legacy_merchant_key():
    imp = AmexImporter(
        "DemoAmex",
        payment_account=PAY,
        merchant_map={"Demo Transit        Springfield": "Expenses:Transport"},
    )
    accounts, payee, _ = legs(
        imp.handle_transaction(amex_row("DEMO TRANSIT        SPRINGFIELD", "2.90"), "")
    )
    assert (accounts[1], payee) == ("Expenses:Transport", "Demo Transit")


def test_amex_extract_every_entry_has_two_postings(tmp_path):
    csv = tmp_path / "activity.csv"
    csv.write_text(
        AMEX_HEADER
        + textwrap.dedent(
            """\
            09/04/2030,DEMO NOODLE BAR     SPRINGFIELD         NY,18.50,DEMO,DEMO,,,,,'900000000000000001',Restaurant-Restaurant
            09/05/2030,DEMO TRANSIT        SPRINGFIELD,-2.90,Amex Offer Credit DEMO TRANSIT,DEMO,,,,,'900000000000000002',Transportation-Rail Services
            09/06/2030,DEMO AIRLINE        SPRINGFIELD,-80.00,TICKET,DEMO,,,,,'900000000000000003',Travel-Airline
            09/15/2030,ONLINE PAYMENT - THANK YOU,-50.50,,,,,,,'900000000000000004',
            """
        )
    )
    entries = amex().extract(str(csv), [])
    assert len(entries) == 4
    assert all(e.flag == "*" and len(e.postings) == 2 for e in entries)


# --- BofA credit -------------------------------------------------------------------


@pytest.mark.parametrize(
    "payee",
    [
        "PAYMENT - THANK YOU",
        "PAYMENT FROM CHK 0000 CONF#ABC123",
        "BA ELECTRONIC PAYMENT",
    ],
)
def test_bofa_payment(payee):
    imp = BofAImporter("DemoBofA", payment_account=PAY)
    accounts, _, flag = legs(
        imp.handle_transaction({"Payee": payee, "Amount": "100.00"}, "")
    )
    assert (accounts[1], flag) == (PAY, "*")


def test_bofa_payment_lookalike_purchase_is_not_a_payment():
    imp = BofAImporter(
        "DemoBofA", payment_account=PAY, merchant_map={"Paymentdemo Utility": "X:Y"}
    )
    accounts, _, flag = legs(
        imp.handle_transaction({"Payee": "PAYMENTDEMO UTILITY", "Amount": "-20.00"}, "")
    )
    assert (accounts[1], flag) == ("X:Y", "*")


def test_bofa_unknown_credit_gets_fixme_leg():
    imp = BofAImporter("DemoBofA", payment_account=PAY)
    accounts, _, flag = legs(
        imp.handle_transaction({"Payee": "DEMO STORE REFUND", "Amount": "9.99"}, "")
    )
    assert (accounts[1], flag) == ("Equity:FIXME", "*")


# --- other credit cards: unknown credits ---------------------------------------------

UNKNOWN_CREDIT_ROWS = [
    (
        ChaseImporter("DemoChase", payment_account=PAY),
        {"Description": "DEMO STORE", "Category": "Shopping", "Amount": "9.99"},
    ),
    (
        BiltImporter("DemoBilt", payment_account=PAY),
        {"Description": "DEMO STORE", "Amount": "9.99"},
    ),
    (
        AppleImporter("DemoApple", payment_account=PAY),
        {"Merchant": "Demo Store", "Category": "Credit", "Amount (USD)": "-9.99"},
    ),
    (
        DiscoverImporter("DemoDiscover", payment_account=PAY),
        {"Description": "DEMO STORE", "Category": "Merchandise", "Amount": "-9.99"},
    ),
]


@pytest.mark.parametrize(
    "importer,row", UNKNOWN_CREDIT_ROWS, ids=lambda x: type(x).__name__
)
def test_credit_card_unknown_credit_is_posted_with_fixme_leg(importer, row):
    accounts, _, flag = legs(importer.handle_transaction(row, ""))
    assert flag == "*"
    assert accounts[1] == "Equity:FIXME"
