"""Importer flags and second legs on synthetic rows.

The flag only answers "is this posted at the bank?": `*` posted, `!` pending.
A row the importer can't categorize keeps `*` and gets an Equity:FIXME leg.
Every emitted transaction has a second posting.
"""

import textwrap

import pytest
from beancount_tooling import merchants
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
    """With no alias or rule for the row, the importer's cleaned payee is the
    fallback: booked unchanged and reported as unmapped."""
    assert clean_payee(desc) == payee
    imp = amex()
    row = amex_row(desc, "5.00", category="Restaurant-Restaurant")
    _, got, _, merchant = imp.categorize_row(row)
    assert got == payee
    assert (merchant.payee, merchant.status) == (payee, "unmapped")


@pytest.mark.parametrize(
    "known,expected",
    [
        # canonical payee first...
        (
            {"Demo Noodle Bar": "Expenses:Restaurants", "Demo Nb": "X:Old"},
            "Expenses:Restaurants",
        ),
        # ...then the pre-normalization clean payee...
        ({"Demo Nb": "X:Old"}, "X:Old"),
        # ...then the legacy payee (fixed-width city block kept).
        ({"Demo Nb             Springfield": "X:Legacy"}, "X:Legacy"),
    ],
)
def test_amex_debit_lookup_canonical_then_legacy(known, expected):
    merchants.set_config(
        merchants.parse_config(
            {"merchants": {"Demo Noodle Bar": {"rules": ["^DEMO NB\\b"]}}}
        )
    )
    imp = AmexImporter("DemoAmex", payment_account=PAY, merchant_map=dict(known))
    row = amex_row("DEMO NB             SPRINGFIELD", "2.90")
    accounts, payee, _ = legs(imp.handle_transaction(row, ""))
    assert (accounts[1], payee) == (expected, "Demo Noodle Bar")


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


def test_amex_payment_and_credit_keep_their_payee_with_a_map(merchant_map):
    _, payee, _ = legs(
        amex().handle_transaction(amex_row("AMEX DEMO CREDIT", "-7.00"), "")
    )
    assert payee == "Amex Demo Credit"
    _, payee, _ = legs(
        amex().handle_transaction(amex_row("ONLINE PAYMENT - THANK YOU", "-50.00"), "")
    )
    assert payee == "Online Payment - Thank You"


def test_amex_extract_sets_canonical_payee_narration_and_desc(tmp_path, merchant_map):
    csv = tmp_path / "activity.csv"
    csv.write_text(
        AMEX_HEADER
        + textwrap.dedent(
            """\
            09/04/2030,AplPay DEMO MART 0099 SHELBYVILLE XX,18.50,DEMO,DEMO,,,,,'900000000000000001',Restaurant-Restaurant
            09/05/2030,DD *DOORDASH DEMO MART,22.00,DEMO,DEMO,,,,,'900000000000000002',Restaurant-Restaurant
            09/06/2030,UNKNOWN DEMO PLACE,9.00,DEMO,DEMO,,,,,'900000000000000003',Restaurant-Restaurant
            09/15/2030,ONLINE PAYMENT - THANK YOU,-50.50,,,,,,,'900000000000000004',
            """
        )
    )
    original = csv.read_text()
    imp = amex()
    entries = imp.extract(str(csv), [])
    got = [(e.payee, e.narration, e.meta.get("raw")) for e in entries]
    assert got == [
        ("Demo Mart", "Shelbyville", "AplPay DEMO MART 0099 SHELBYVILLE XX"),
        ("DoorDash", "Demo Mart", "DD *DOORDASH DEMO MART"),
        ("Unknown Demo Place", "", "UNKNOWN DEMO PLACE"),
        ("Online Payment - Thank You", None, None),
    ]
    # refs still come from the untouched row
    assert [e.postings[0].meta["ref"] for e in entries] == [
        "900000000000000001",
        "900000000000000002",
        "900000000000000003",
        "900000000000000004",
    ]
    assert imp.unmapped == [
        (entries[2].date, "Unknown Demo Place", "UNKNOWN DEMO PLACE")
    ]
    assert csv.read_text() == original


def test_extract_prints_desc_under_the_header(tmp_path, merchant_map):
    from beancount.parser import printer

    csv = tmp_path / "activity.csv"
    csv.write_text(
        AMEX_HEADER
        + "09/05/2030,DD *DOORDASH DEMO MART,22.00,DEMO,DEMO,,,,,'900000000000000002',"
        "Restaurant-Restaurant\n"
    )
    text = printer.format_entry(amex().extract(str(csv), [])[0])
    lines = text.splitlines()
    assert lines[0] == '2030-09-05 * "DoorDash" "Demo Mart"'
    assert lines[1] == '  raw: "DD *DOORDASH DEMO MART"'
    assert lines[2].startswith("  Liabilities:Credit:DemoAmex")
    assert lines[3].strip() == 'ref: "900000000000000002"'


def test_handle_transaction_does_not_mutate_row(merchant_map):
    row = amex_row("DD *DOORDASH DEMO MART", "22.00", category="Restaurant")
    before = dict(row)
    amex().handle_transaction(row, "")
    assert row == before


# --- normalized payees on other importers ----------------------------------------


@pytest.mark.parametrize(
    "importer,row,payee",
    [
        (
            ChaseImporter("DemoChase", payment_account=PAY, merchant_map={}),
            {"Description": "UBER *EATS", "Category": "Food", "Amount": "-9.99"},
            "Uber Eats",
        ),
        (
            BofAImporter("DemoBofA", payment_account=PAY, merchant_map={}),
            {"Payee": "COSTCO GAS #0001 SPRINGFIELD XX", "Amount": "-30.00"},
            "Costco Gas",
        ),
        (
            BiltImporter("DemoBilt", payment_account=PAY, merchant_map={}),
            {"Description": "DD *DOORDASH DEMO MART", "Amount": "-9.99", "Date": ""},
            "DoorDash",
        ),
        (
            AppleImporter("DemoApple", payment_account=PAY, merchant_map={}),
            {
                "Transaction Date": "",
                "Merchant": "Apple",
                "Description": "APPLE.COM/BILL 000-000-0000 XX",
                "Category": "Other",
                "Amount (USD)": "2.99",
            },
            "App Store",
        ),
        (
            DiscoverImporter("DemoDiscover", payment_account=PAY, merchant_map={}),
            {"Description": "DEMO MART #12", "Category": "Merchandise", "Amount": "5"},
            "Demo Mart",
        ),
        (
            RobinhoodImporter("DemoRH", payment_account=PAY, merchant_map={}),
            {
                "Status": "Posted",
                "Type": "Purchase",
                "Amount": "$12.00",
                "Merchant": "Costco",
                "Description": "COSTCO WHSE #0001 SPRINGFIELD XX",
            },
            "Costco",
        ),
        (
            TDCheckingImporter("DemoTD"),
            {"Description": "DEMO MART #12", "Debit": "5.00", "Credit": ""},
            "Demo Mart",
        ),
        (
            ChaseCheckingImporter("DemoChase"),
            {"Description": "UBER *TRIP", "Amount": "-12.34"},
            "Uber",
        ),
    ],
    ids=lambda x: type(x).__name__ if not isinstance(x, (dict, str)) else None,
)
def test_merchant_rows_get_canonical_payee(merchant_map, importer, row, payee):
    _, got, flag = legs(importer.handle_transaction(row, ""))
    assert (got, flag) == (payee, "*")


def test_bank_transfer_rows_keep_their_payee(merchant_map):
    _, payee, _ = legs(
        TDCheckingImporter("DemoTD").handle_transaction(
            {"Description": "ONLINE XFER TRANSFER TO DEMO", "Debit": "5", "Credit": ""},
            "",
        )
    )
    assert payee == "Online Xfer Transfer to Demo"


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


def test_prompted_fixme_does_not_shadow_other_variants(merchant_map):
    """A non-interactive prompt (Equity:FIXME) for one descriptor variant must
    not be cached under the canonical payee, or it would override the learned
    account of every other variant of the merchant."""
    imp = BofAImporter(
        "DemoBofA",
        payment_account=PAY,
        merchant_map={"Demo Mart #12": "Expenses:Groceries"},
    )
    first = {"Payee": "DEMO MART 0099 SHELBYVILLE XX", "Amount": "-5.00"}
    second = {"Payee": "DEMO MART #12", "Amount": "-5.00"}
    assert legs(imp.handle_transaction(first, ""))[0][1] == "Equity:FIXME"
    assert legs(imp.handle_transaction(second, ""))[0][1] == "Expenses:Groceries"
    assert "Demo Mart" not in imp.merchant_map


# --- learned routing with gift-card / receivable history ------------------------------


def _bofa(routes):
    return BofAImporter("DemoBofA", payment_account=PAY, merchant_map=routes)


def test_payee_mostly_bought_as_gift_cards_is_not_auto_routed(merchant_map):
    routes = merchants.MerchantRoutes({"Demo Mart": None}, mixed={"Demo Mart"})
    imp = _bofa(routes)
    row = {"Payee": "DEMO MART 0099 SHELBYVILLE XX", "Amount": "-5.00"}
    accounts, payee, _ = legs(imp.handle_transaction(row, ""))
    assert (accounts[1], payee) == ("Equity:FIXME", "Demo Mart")
    # an answer for one purchase is not reused for the next one
    imp.remember_merchant_account("Demo Mart", "Assets:Gift-Card:Demo")
    assert imp.merchant_map["Demo Mart"] is None


def test_mixed_payee_routes_by_descriptor_variant(merchant_map):
    routes = merchants.MerchantRoutes(
        {"Costco": "Expenses:Groceries"},
        variants={"WWW COSTCO COM": None, "Costco Whse #0001": "Expenses:Groceries"},
        mixed={"Costco"},
    )
    imp = _bofa(routes)
    web = {"Payee": "WWW COSTCO COM", "Amount": "-50.00"}
    store = {"Payee": "COSTCO WHSE #0001", "Amount": "-50.00"}
    new = {"Payee": "COSTCO WHSE #0002", "Amount": "-50.00"}
    assert legs(imp.handle_transaction(web, ""))[0][1] == "Equity:FIXME"
    assert legs(imp.handle_transaction(store, ""))[0][1] == "Expenses:Groceries"
    assert legs(imp.handle_transaction(new, ""))[0][1] == "Expenses:Groceries"


# --- checking: only unclassified debits are merchant rows -----------------------------


@pytest.mark.parametrize(
    "importer,row,payee",
    [
        (
            TDCheckingImporter("DemoTD"),
            {"Description": "DEMO EMPLOYER DIR DEP", "Debit": "", "Credit": "100"},
            "Demo Employer Dir Dep",
        ),
        (
            ChaseCheckingImporter("DemoChase"),
            {"Description": "DEMO MART #12", "Amount": "5.00"},
            "Demo Mart #12",
        ),
        (
            RobinhoodImporter("DemoRH", type="checking"),
            {"Description": "DEMO MART #12", "Amount": "$5.00"},
            "DEMO MART #12",
        ),
    ],
    ids=lambda x: type(x).__name__ if not isinstance(x, (dict, str)) else None,
)
def test_checking_credit_is_never_a_merchant_row(merchant_map, importer, row, payee):
    postings, got, _, merchant = importer.categorize_row(row)
    assert (got, merchant) == (payee, None)
    assert postings[1].account == "Equity:FIXME"


def test_checking_debit_is_a_merchant_row(merchant_map):
    imp = ChaseCheckingImporter("DemoChase")
    _, payee, _, merchant = imp.categorize_row(
        {"Description": "DEMO MART #12", "Amount": "-5.00"}
    )
    assert (payee, merchant.payee) == ("Demo Mart", "Demo Mart")
