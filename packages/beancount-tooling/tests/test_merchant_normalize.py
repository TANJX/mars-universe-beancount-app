"""merchants.normalize on the synthetic map in tests/fixtures/merchants.yaml."""

import copy
from datetime import date
from pathlib import Path

import pytest
from beancount_tooling import merchants
from beancount_tooling.merchants import (
    MerchantConfigError,
    MerchantRoutes,
    learn_merchant_routes,
    load_config,
    normalize,
    parse_config,
    pick_merchant_accounts,
)

# Shipped beside extract.example.yaml.
EXAMPLE = Path(merchants.__file__).parent / "merchants.example.yaml"

# (raw descriptor, legacy payee, extra) -> (payee, detail, status, source)
CASES = [
    # guard before alias: exact non_merchant wins over an alias of the same text
    ("Demo Noodle", None, None, ("Demo Noodle", "", "non_merchant", "guard")),
    # guard pattern on the raw descriptor wins over the alias "Demo Auto Inc"
    ("Demo Auto Inc", None, None, ("Demo Auto Inc", "", "non_merchant", "guard")),
    (
        "DEMO AUTO INC DES:DEMO LOAN ID:1",
        "Demo Auto Inc Des:demo Loan Id:1",
        None,
        ("Demo Auto Inc Des:demo Loan Id:1", "", "non_merchant", "guard"),
    ),
    # ...while the product line passes the negative lookahead and hits its rule
    (
        "DEMO AUTO INC SUPERCHARGER 1234",
        "Demo Auto Inc Supercharger 1234",
        None,
        ("Demo Auto Supercharger", "", "mapped", "rule"),
    ),
    (
        "ZELLE PAYMENT TO DEMO PERSON",
        "Zelle Payment to Demo Person",
        None,
        ("Zelle Payment to Demo Person", "", "non_merchant", "guard"),
    ),
    ("AMEX DEMO CREDIT", None, None, ("AMEX DEMO CREDIT", "", "non_merchant", "guard")),
    # exact alias, with and without a details entry
    ("Demo Mart #12", None, None, ("Demo Mart", "", "mapped", "alias")),
    (
        "Demo Mart 0042 Springfield",
        None,
        None,
        ("Demo Mart", "Springfield", "mapped", "alias"),
    ),
    # alias on the importer's legacy payee when the raw text is unknown
    (
        "DEMO MART #12 XX",
        "Demo Mart #12",
        None,
        ("Demo Mart", "", "mapped", "alias"),
    ),
    # alias versus rule: "Demo Noodle Bar" is an explicit alias, so the rule is
    # never consulted; an unaliased variant falls through to the rule
    ("Demo Noodle Bar", None, None, ("Demo Noodle Bar", "", "mapped", "alias")),
    (
        "DEMO NOODLE BAR 77 SPRINGFIELD",
        "Demo Noodle Bar 77 Springfield",
        None,
        ("Demo Noodle Bar", "", "mapped", "rule"),
    ),
    # rule with a detail template over a named group; AplPay prefix stripped
    (
        "AplPay DEMO MART 0099 SHELBYVILLE XX",
        "Demo Mart 0099",
        None,
        ("Demo Mart", "Shelbyville", "mapped", "rule"),
    ),
    # priority: the delivery platform beats the store named after it
    (
        "DD *DOORDASH DEMO MART",
        "Dd *doordash Demo Mart",
        None,
        ("DoorDash", "Demo Mart", "mapped", "rule"),
    ),
    # product lines
    (
        "COSTCO GAS #0001",
        "Costco Gas #0001",
        None,
        ("Costco Gas", "Gas", "mapped", "rule"),
    ),
    ("COSTCO WHSE #0001", "Costco Whse #0001", None, ("Costco", "", "mapped", "rule")),
    (
        "UBER *EATS PENDING",
        "Uber *eats Pending",
        None,
        ("Uber Eats", "", "mapped", "rule"),
    ),
    ("UBER *ONE MEMBERSHIP", None, None, ("Uber One", "Membership", "mapped", "rule")),
    ("UBER *TRIP HELP.UBER.COM", None, None, ("Uber", "", "mapped", "rule")),
    # Robinhood refunds: the prefix becomes the narration detail
    ("Refund: Demo Mart #12", None, None, ("Demo Mart", "Refund", "mapped", "alias")),
    # (the stripped Merchant column is the canonical name, so the alias wins)
    (
        "DEMO MART 0042 SPRINGFIELD XX",
        "Refund: Demo Mart",
        None,
        ("Demo Mart", "Refund", "mapped", "alias"),
    ),
    (
        "DEMO MART 0099 SHELBYVILLE XX",
        "Refund: Demo Mart 0099",
        None,
        ("Demo Mart", "Refund: Shelbyville", "mapped", "rule"),
    ),
    # Amex: the Description is cut short, the store is only in Extended
    # Details (multi-line); the same merchant's rules render it, via alias...
    (
        "AplPay BT*DD *DOORDASAN FRANCISCO       CA",
        "Bt*dd *Doorda",
        {
            "Extended Details": "AB12CD34    8550000000\nAplPay BT*DD *DOORDASH DEMOMART\n8550000000"
        },
        ("DoorDash", "Demomart", "mapped", "alias"),
    ),
    # ...or via a rule with no detail of its own
    (
        "DD *DOORDASAN FRANCISCO       CA",
        "Dd *doordasan Francisco Ca",
        {"Extended Details": "X\nDD *DOORDASH DEMO NOODLE\nY"},
        ("DoorDash", "Demo Noodle", "mapped", "rule"),
    ),
    # no extra columns: no detail
    (
        "DD *DOORDASAN FRANCISCO       CA",
        "Dd *doordasan Francisco Ca",
        None,
        ("DoorDash", "", "mapped", "rule"),
    ),
    # Discover glues the wallet onto the descriptor
    (
        "DEMO MART 0099 SHELBYVILLE XXAPPLE PAY ENDING IN 1234",
        "Demo Mart 0099 Shelbyville Xxapple Pay Ending in 1234",
        None,
        ("Demo Mart", "Shelbyville", "mapped", "rule"),
    ),
    # ambiguous payee: never resolved from the payee alone...
    ("Apple", None, None, ("Apple", "", "unmapped", "fallback")),
    # ...but a rule hit on richer text resolves it, limited to the candidates
    (
        "APPLE.COM/BILL 000-000-0000 XX",
        "Apple",
        None,
        ("App Store", "", "mapped", "rule"),
    ),
    (
        "Apple",
        None,
        {"raw": "APPLE STORE #R001 SPRINGFIELD XX"},
        ("Apple", "Springfield", "mapped", "rule"),
    ),
    (
        "Apple",
        None,
        {"narration": "Demo Mart run"},
        ("Apple", "", "unmapped", "fallback"),
    ),
    # fallback keeps the importer's payee; Japanese names pass through untouched
    (
        "ＤＥＭＯ 喫茶",
        "Ｄｅｍｏ 喫茶",
        None,
        ("Ｄｅｍｏ 喫茶", "", "unmapped", "fallback"),
    ),
    ("東京デモ書店", None, None, ("東京デモ書店", "", "mapped", "alias")),
    ("Tokyo Demo Shoten", None, None, ("東京デモ書店", "", "mapped", "alias")),
    (
        "UNKNOWN PLACE 123",
        "Unknown Place 123",
        None,
        ("Unknown Place 123", "", "unmapped", "fallback"),
    ),
]


@pytest.mark.parametrize("raw,legacy,extra,expected", CASES, ids=[c[0] for c in CASES])
def test_normalize(merchant_map, raw, legacy, extra, expected):
    got = normalize(raw, legacy, extra=extra)
    assert (got.payee, got.detail, got.status, got.source) == expected


def test_every_canonical_normalizes_to_itself(merchant_map):
    for canonical in merchant_map.canonicals:
        if canonical in merchant_map.ambiguous:
            continue
        got = normalize(canonical)
        assert (got.payee, got.source) == (canonical, "alias"), canonical
        assert normalize(got.payee).payee == got.payee


def test_rule_ids_and_ambiguous_flag(merchant_map):
    got = normalize("APPLE.COM/BILL", "Apple")
    assert got.ambiguous and got.rule_id == "App Store#0"
    assert not normalize("Demo Mart #12").ambiguous


def test_inputs_are_not_mutated(merchant_map):
    extra = {"raw": "APPLE STORE #R001 SPRINGFIELD XX"}
    before = copy.deepcopy(extra)
    normalize("Apple", "Apple", extra=extra)
    assert extra == before


def test_missing_file_is_an_empty_map(tmp_path):
    config = load_config(tmp_path / "merchants.yaml")
    assert config.empty
    got = normalize("DEMO MART #12", "Demo Mart #12", config=config)
    assert (got.payee, got.status) == ("Demo Mart #12", "unmapped")


def test_empty_map_by_default_in_tests():
    # conftest installs an empty map so the real ledger's map never leaks in
    assert merchants.get_config().empty


def test_example_config_loads_and_resolves():
    config = load_config(EXAMPLE)
    cases = {
        "DD *DOORDASH DEMO CAFE": ("DoorDash", "Demo Cafe"),
        "COSTCO GAS #0001": ("Costco Gas", ""),
        "COSTCO WHSE #0001 SPRINGFIELD XX": ("Costco", "Springfield"),
        "SQ *DEMO CAFE SPRINGFIELD XX": ("Demo Cafe", "Springfield"),
        "APPLE.COM/BILL": ("App Store", ""),
    }
    for raw, expected in cases.items():
        got = normalize(raw, config=config)
        assert (got.payee, got.detail) == expected, raw
    assert normalize("Monthly Service Fee", config=config).status == "non_merchant"


# --- validation --------------------------------------------------------------


@pytest.mark.parametrize(
    "text,message",
    [
        (
            'merchants:\n  "Demo A":\n    rules: ["(unclosed"]\n',
            "Demo A.rules[0]: bad regex",
        ),
        (
            'merchants:\n  "Demo A":\n    aliases: ["X"]\n  "Demo B":\n    aliases: ["X"]\n',
            "alias 'X' maps to both 'Demo A' and 'Demo B'",
        ),
        (
            'merchants:\n  "Demo A":\n    aliases: ["Demo B"]\n  "Demo B": {}\n',
            "alias 'Demo B' maps to both",
        ),
        (
            'merchants:\n  "Demo A": {}\n  "Demo A": {}\n',
            "duplicate key 'Demo A'",
        ),
        (
            'merchants:\n  "Demo A":\n    details: {"Nope": "x"}\n',
            "is not an alias of 'Demo A'",
        ),
        (
            'merchants:\n  "Demo A": {}\nambiguous:\n  "A":\n    candidates: ["Demo Z"]\n',
            "candidate 'Demo Z' is not a merchant",
        ),
        ('non_merchant_patterns: ["(bad"]\n', "non_merchant_patterns[0]: bad regex"),
    ],
)
def test_validation_errors_name_the_problem(tmp_path, text, message):
    path = tmp_path / "merchants.yaml"
    path.write_text(text)
    with pytest.raises(MerchantConfigError) as err:
        load_config(path)
    assert message in str(err.value)


def test_parse_config_accepts_none():
    assert parse_config(None).empty


# --- learned routing ---------------------------------------------------------


def test_pick_merchant_accounts_most_frequent_then_most_recent():
    rows = [
        (date(2026, 1, 1), "Costco", "Expenses:Groceries"),
        (date(2026, 2, 1), "Costco", "Expenses:Groceries"),
        (date(2026, 3, 1), "Costco", "Expenses:Purchases:Electronic"),  # the odd TV
        (date(2026, 1, 1), "Demo Cafe", "Expenses:Restaurants"),
        (date(2026, 5, 1), "Demo Cafe", "Expenses:Groceries"),  # tie: most recent
        (date(2026, 1, 1), None, "Expenses:Groceries"),  # narration-only
    ]
    assert pick_merchant_accounts(rows) == {
        "Costco": "Expenses:Groceries",
        "Demo Cafe": "Expenses:Groceries",
    }


def test_learn_merchant_routes_never_routes_to_a_non_expense_winner():
    d = date(2026, 1, 1)
    rows = [
        (d, "Demo Gift App", None, "Assets:Gift-Card:Demo"),
        (d, "Demo Gift App", None, "Assets:Gift-Card:Other"),
        (d, "Demo Gift App", None, "Assets:Gift-Card:Demo"),
        (d, "Demo Gift App", None, "Expenses:Home"),
        (d, "Demo Cafe", None, "Expenses:Restaurants"),
        (d, None, None, "Expenses:Groceries"),
    ]
    routes = learn_merchant_routes(rows)
    assert isinstance(routes, MerchantRoutes)
    assert dict(routes) == {"Demo Gift App": None, "Demo Cafe": "Expenses:Restaurants"}
    assert routes.mixed == {"Demo Gift App"}


def test_learn_merchant_routes_keeps_variants_of_mixed_payees():
    d = date(2026, 1, 1)
    rows = [
        (d, "Costco", "COSTCO WHSE #1", "Expenses:Groceries"),
        (d, "Costco", "COSTCO WHSE #1", "Expenses:Groceries"),
        (d, "Costco", "COSTCO WHSE #2", "Expenses:Groceries"),
        (d, "Costco", "WWW COSTCO COM", "Assets:Gift-Card:Costco"),
        (d, "Costco", "WWW COSTCO COM", "Assets:Gift-Card:Costco"),
        (d, "Demo Cafe", "DEMO CAFE 1", "Expenses:Restaurants"),
    ]
    routes = learn_merchant_routes(rows)
    assert routes["Costco"] == "Expenses:Groceries"
    assert routes.variants == {
        "COSTCO WHSE #1": "Expenses:Groceries",
        "COSTCO WHSE #2": "Expenses:Groceries",
        "WWW COSTCO COM": None,
    }
