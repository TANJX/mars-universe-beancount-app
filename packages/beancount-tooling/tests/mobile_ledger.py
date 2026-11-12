"""A small, fully synthetic ledger for the mobile snapshot tests.

``write_ledger(root)`` lays out a ledger directory the way ``$LEDGER_DIR`` looks
(journal, config/mobile.yaml, config/ui.yaml, journal/plan/cc-cards.json,
statements/billing).
Every name and number is invented and the output is deterministic. Run as a script to write one:

    uv run python tests/mobile_ledger.py <dir>
"""

from __future__ import annotations

import datetime as dt
import json
import random
import sys
from pathlib import Path

ASOF = dt.date(2030, 6, 18)
START = dt.date(2028, 4, 1)

CARDS = [
    "Summit",
    "Cobalt",
    "Meadowlark",
    "Juniper",
    "Atlas",
    "Orchard",
    "Pinnacle",
    "Driftwood",
    "Ember",
]

MOBILE_YAML = """\
accounts:
  cash_exclude: ["Assets:Checking:Commuter"]
plan:
  horizon: { until: 2030-07-31, days: 45 }
  events:
    - match: { payee_prefix: "Acme Corp" }
      label: "Paycheck"
      note: "Acme, after 401k"
      kind: pay
      merge: true
      paycheck: true
    - match: { payee_prefix: "Lakeside Auto" }
      label: "Car loan"
      note: "From Harbor"
      kind: bill
    - match: { narration_contains: "Commuter" }
      label: "Commuter benefit"
spending:
  day_to_day_exclude: [Home]
emergency_fund:
  account: "Assets:Saving:Harbor"
  target: 20000
  note: "4 months of outflow"
goals:
  - id: ira
    name: "Roth IRA 2030"
    target: 7500
    due: 2031-04-15
    measure: { type: contributions, account: "Assets:Investment:Northwind:Roth-IRA", year: 2030 }
  - id: k401
    name: "401k 2030"
    target: 12000
    due: 2030-12-31
    measure: { type: contributions, account: "Assets:Investment:Meridian:401k", year: 2030 }
  - id: bonus
    name: "Summit bonus spend"
    target: 4000
    due: 2030-09-30
    note: "60k points"
    measure:
      type: card_spend
      account: "Liabilities:Credit:Summit"
      since: 2030-05-01
      exclude_payee_contains: [fee]
      exclude_accounts: ["Expenses:Fee"]
loans:
  - account: "Liabilities:Loan:Car"
    name: "Car loan"
    original: 30000
    payment: 550.25
    payoff: 2032-06-15
key_dates:
  - { date: 2030-07-01, label: "Renters insurance renews", note: "about $180 for the year" }
  - { date: 2030-09-30, label: "Summit bonus deadline", note: "$4,000 spend" }
  - { date: 2032-06-15, label: "Car loan paid off" }
investments:
  accounts:
    - { prefix: "Assets:Investment:Meridian", name: "401k" }
    - { prefix: "Assets:Investment:Northwind", component: 3 }
display_names:
  "Liabilities:Credit:Summit": "Summit Rewards"
  "Liabilities:Credit:Cobalt": "Cobalt Cash"
  "Assets:Receivable:Acme:Expenses": "Acme expenses"
  "Assets:Gift-Card:*": "{name} gift card"
  "Assets:Transit:Suica": "Suica"
  "Assets:Checking:Commuter": "Commuter card"
payees:
  - { match: "^Acme Corp Des:expense\\\\b", title: "Acme Corp", narration: "Expense reimbursement" }
equity:
  company: "Acme Corp"
  fmv: 2.00
  fmv_date: 2030-05-01
  preferred_price: 12.50
  grants:
    - id: "OPT-1"
      type: "ISO"
      grant_date: 2028-04-02
      shares: 20000
      strike: 0.20
      expiration: 2038-03-10
      # Two halves, each a 1-year cliff then monthly; the second clock starts 2 years in.
      vesting:
        - { shares: 10000, start: 2028-03-10, months: 48, cliff_months: 12 }
        - { shares: 10000, start: 2030-03-10, months: 48, cliff_months: 12 }
    - id: "OPT-2"
      type: "ISO"
      grant_date: 2029-09-15
      shares: 5000
      strike: 0.50
      expiration: 2039-09-15
      vesting:
        - { shares: 5000, start: 2029-09-01, months: 48 }
"""

# Merchant logos, the way the web viewer's config/ui.yaml declares them.
UI_YAML = """\
merchants:
  Greenleaf Market: { domain: greenleaf.example }
  Blue Door Bistro: { domain: bluedoor.example, aliases: ["Blue Door"] }
  Skyline Air: { domain: skylineair.example }
  Pixel Stream: { domain: pixelstream.example }
  Harbor Bank: { domain: harborbank.example }
  Acme Corp: { domain: acme.example }
  Paper Lantern Books: {}
accounts:
  logos:
    "Income:Salary:Acme": "Acme Corp"
    "Assets:Checking:Harbor": "Harbor Bank"
    "Assets:Saving:Harbor": "Harbor Bank"
"""

MERCHANTS = [
    ("Greenleaf Market", "Groceries", "", 18, 140),
    ("Harvest Lane Co-op", "Groceries", "Weekly shop", 25, 110),
    ("Blue Door Bistro", "Restaurants", "", 14, 95),
    ("Sakura Ramen House", "Restaurants", "Dinner with friends", 16, 70),
    ("Metro Transit Authority", "Transportation:Public", "", 3, 3),
    ("Volt Charging Network", "Transportation:Driving", "", 9, 32),
    ("Pixel Stream", "Subscription", "Monthly plan", 16, 16),
    (
        "Northside Hardware & Garden Supply Cooperative of Greater Springfield",
        "Home:Improvement",
        "",
        12,
        180,
    ),
    ("Paper Lantern Books", "Purchases:Others", "", 9, 60),
    (
        "The Old Lighthouse Seafood Grill and Oyster Bar at Fisherman's Landing",
        "Restaurants",
        "Anniversary dinner, tasting menu for two",
        90,
        260,
    ),
    ("Skyline Air", "Travel:Flight", "Round trip to the coast", 180, 520),
    ("Cedar Ridge Cinema", "Leisure:Cinema", "", 12, 34),
    ("Corner Pharmacy", "Health", "", 6, 48),
]

TICKERS = {
    # symbol: (name, start price, monthly drift)
    "VTI": ("Total Market ETF", 210.0, 1.011),
    "VXUS": ("International ETF", 58.0, 1.006),
    "AAPL": ("Apple Inc.", 170.0, 1.014),
    "NVDA": ("NVIDIA Corp.", 95.0, 1.022),
    "TDF2060": ("Target Date 2060 Fund", 24.0, 1.008),
}


def _months(start: dt.date, end: dt.date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def journal_text(asof: dt.date = ASOF) -> str:
    rng = random.Random(7)
    out: list[str] = [
        'option "operating_currency" "USD"',
        'option "title" "Synthetic Mobile Ledger"',
        'option "inferred_tolerance_default" "USD:0.01"',
        "",
    ]
    opens = [
        "Assets:Checking:Harbor",
        "Assets:Checking:Tidewater",
        "Assets:Checking:Commuter",
        "Assets:Saving:Harbor",
        "Assets:Cash",
        "Assets:Gift-Card:Coffee",
        "Assets:Pending-Transfer",
        "Assets:Receivable:Roommate",
        "Assets:Receivable:Acme:Expenses",
        "Assets:Investment:Northwind:Roth-IRA:USD",
        "Assets:Investment:Northwind:Brokerage:USD",
        "Assets:Investment:Meridian:401k:USD",
        "Liabilities:Loan:Car",
        "Liabilities:Payable:Rent",
        "Income:Salary:Acme",
        "Income:Interest:Harbor",
        "Income:Trading:Dividend",
        "Income:Trading:Stock",
        "Income:Rebate:Cards",
        "Equity:Opening-Balances",
        "Expenses:Groceries",
        "Expenses:Restaurants",
        "Expenses:Transportation:Public",
        "Expenses:Transportation:Driving",
        "Expenses:Subscription",
        "Expenses:Home:Rent",
        "Expenses:Home:Utilities",
        "Expenses:Home:Improvement",
        "Expenses:Purchases:Others",
        "Expenses:Travel:Flight",
        "Expenses:Leisure:Cinema",
        "Expenses:Health",
        "Expenses:Interest",
        "Expenses:Fee",
    ]
    opens += [f"Liabilities:Credit:{c}" for c in CARDS]
    for a in opens:
        out.append(f"{START} open {a}")
    out.append(f"{START} open Assets:Transit:Suica")
    for sym, acct in (
        ("VTI", "Roth-IRA"),
        ("VXUS", "Roth-IRA"),
        ("AAPL", "Brokerage"),
        ("NVDA", "Brokerage"),
    ):
        out.append(
            f'{START} open Assets:Investment:Northwind:{acct}:{sym} {sym} "FIFO"'
        )
    out.append(f"{START} open Assets:Investment:Meridian:401k:TDF2060 TDF2060")
    for sym, (name, _, _) in TICKERS.items():
        out += [f"{START} commodity {sym}", f'  name: "{name}"']
    out += [f"{START} commodity JPY", '  name: "Japanese Yen"', ""]

    def tx(date, flag, payee, narration, legs, meta=None):
        out.append(f'{date} {flag} "{payee}" "{narration}"')
        if meta:
            out.append(f"  {meta}")
        for leg in legs:
            out.append(f"  {leg}")
        out.append("")

    tx(
        START,
        "*",
        "Opening balances",
        "",
        [
            "Assets:Checking:Harbor 5200.00 USD",
            "Assets:Checking:Tidewater 900.00 USD",
            "Assets:Checking:Commuter 86.00 USD",
            "Assets:Saving:Harbor 8000.00 USD",
            "Assets:Gift-Card:Coffee 50.00 USD",
            "Assets:Transit:Suica 5000 JPY",
            "Assets:Receivable:Roommate 120.00 USD",
            "Liabilities:Loan:Car -27500.00 USD",
            "Equity:Opening-Balances",
        ],
    )

    price = {sym: p for sym, (_, p, _) in TICKERS.items()}
    for y, m in _months(START, asof):
        first = dt.date(y, m, 1)
        if first > asof:
            break
        for sym, (_, _, drift) in TICKERS.items():
            price[sym] = round(price[sym] * drift * rng.uniform(0.97, 1.035), 2)
            out.append(f"{first} price {sym} {price[sym]} USD")
        out.append(f"{first} price JPY 0.0067 USD")
        out.append("")

        def day(d, y=y, m=m):
            return dt.date(y, m, d)

        def past(d):
            return day(d) <= asof

        if past(1):
            tx(
                day(1),
                "*",
                "Maple Court Apartments",
                f"{y}-{m:02d} rent",
                ["Expenses:Home:Rent 1850.00 USD", "Assets:Checking:Harbor"],
            )
        for d in (15, 28):
            if past(d):
                tx(
                    day(d),
                    "*",
                    "Acme Corp Payroll",
                    "",
                    [
                        "Assets:Checking:Harbor 2450.00 USD",
                        "Assets:Checking:Tidewater 150.00 USD",
                        "Assets:Investment:Meridian:401k:USD 400.00 USD",
                        "Income:Salary:Acme",
                    ],
                )
                units = round(400 / price["TDF2060"], 3)
                tx(
                    day(d),
                    "*",
                    "",
                    f"Target Date 2060 Fund buy {units} shares",
                    [
                        f"Assets:Investment:Meridian:401k:TDF2060 {units} TDF2060 {{{price['TDF2060']} USD}}",
                        "Assets:Investment:Meridian:401k:USD",
                    ],
                )
        if past(5):
            tx(
                day(5),
                "*",
                "Lakeside Auto Finance",
                "",
                [
                    "Liabilities:Loan:Car 470.25 USD",
                    "Expenses:Interest 80.00 USD",
                    "Assets:Checking:Harbor -550.25 USD",
                ],
            )
        if past(9):
            tx(
                day(9),
                "*",
                "City Power & Light",
                "Split 50/50 with roommate",
                [
                    "Expenses:Home:Utilities 46.00 USD",
                    "Assets:Receivable:Roommate 46.00 USD",
                    "Assets:Checking:Harbor -92.00 USD",
                ],
            )
        if past(12):
            tx(
                day(12),
                "*",
                "Transfer from roommate",
                "Utilities share",
                [
                    "Assets:Checking:Harbor 46.00 USD",
                    "Assets:Receivable:Roommate -46.00 USD",
                ],
            )
        if past(16):
            tx(
                day(16),
                "*",
                "Transfer to savings",
                "",
                ["Assets:Saving:Harbor 300.00 USD", "Assets:Checking:Harbor"],
            )
            tx(
                day(16),
                "*",
                "",
                "IRA Contribution",
                [
                    "Assets:Investment:Northwind:Roth-IRA:USD 500.00 USD",
                    "Assets:Checking:Harbor",
                ],
            )
        if past(17):
            units = round(350 / price["VTI"], 4)
            tx(
                day(17),
                "*",
                "",
                f"Total Market ETF market buy {units} shares",
                [
                    f"Assets:Investment:Northwind:Roth-IRA:VTI {units} VTI {{{price['VTI']} USD}}",
                    f"Assets:Investment:Northwind:Roth-IRA:USD -{round(units * price['VTI'], 2)} USD",
                ],
            )
            units = round(120 / price["VXUS"], 4)
            tx(
                day(17),
                "*",
                "",
                f"International ETF market buy {units} shares",
                [
                    f"Assets:Investment:Northwind:Roth-IRA:VXUS {units} VXUS {{{price['VXUS']} USD}}",
                    f"Assets:Investment:Northwind:Roth-IRA:USD -{round(units * price['VXUS'], 2)} USD",
                ],
            )
        if m % 3 == 0 and past(20):
            tx(
                day(20),
                "*",
                "",
                "Brokerage deposit",
                [
                    "Assets:Investment:Northwind:Brokerage:USD 400.00 USD",
                    "Assets:Checking:Tidewater",
                ],
            )
            sym = "AAPL" if m % 6 == 0 else "NVDA"
            units = round(380 / price[sym], 4)
            tx(
                day(20),
                "*",
                "",
                f"{TICKERS[sym][0]} limit buy {units} shares",
                [
                    f"Assets:Investment:Northwind:Brokerage:{sym} {units} {sym} {{{price[sym]} USD}}",
                    f"Assets:Investment:Northwind:Brokerage:USD -{round(units * price[sym], 2)} USD",
                ],
            )
            tx(
                day(20),
                "*",
                "",
                "Dividend from Total Market ETF",
                [
                    "Assets:Investment:Northwind:Roth-IRA:USD 21.40 USD",
                    "Income:Trading:Dividend",
                ],
            )
        if past(27):
            tx(
                day(27),
                "*",
                "Interest Payment",
                "",
                ["Assets:Saving:Harbor 24.10 USD", "Income:Interest:Harbor"],
            )

        # Card spending: a few purchases per card per month.
        charged = {c: 0.0 for c in CARDS}
        for i, card in enumerate(CARDS):
            for _ in range(2 if i > 5 else 3):
                payee, cat, note, lo, hi = rng.choice(MERCHANTS)
                d = rng.randint(1, 28)
                if not past(d):
                    continue
                amount = round(rng.uniform(lo, hi), 2)
                charged[card] += amount
                tx(
                    day(d),
                    "*",
                    payee,
                    note,
                    [f"Expenses:{cat} {amount:.2f} USD", f"Liabilities:Credit:{card}"],
                )
        if past(8):
            tx(
                day(8),
                "*",
                "Metro Transit Authority",
                "",
                [
                    "Expenses:Transportation:Public 3.00 USD",
                    "Assets:Checking:Tidewater",
                ],
            )
        # Pay last month's card spending in full on the 22nd, through clearing.
        if past(22) and (y, m) != (START.year, START.month):
            for card in CARDS:
                paid = prev_charged.get(card, 0.0)  # noqa: F821
                if paid <= 0:
                    continue
                tx(
                    day(22),
                    "*",
                    f"{card} Card Epayment",
                    "",
                    [
                        f"Assets:Pending-Transfer {paid:.2f} USD",
                        "Assets:Checking:Harbor",
                    ],
                )
                tx(
                    day(22),
                    "*",
                    "Payment - Thank You",
                    "",
                    [
                        f"Liabilities:Credit:{card} {paid:.2f} USD",
                        "Assets:Pending-Transfer",
                    ],
                )
        prev_charged = charged  # noqa: F841

    # One-offs close to the as-of date.
    d = asof - dt.timedelta(days=6)
    tx(
        d,
        "*",
        "Skyline Air",
        "Refund: cancelled connecting flight, original booking in March",
        ["Liabilities:Credit:Ember 640.00 USD", "Expenses:Travel:Flight -640.00 USD"],
    )
    tx(
        d,
        "*",
        "Blue Door Bistro",
        "Team dinner, reimbursed by Acme",
        ["Assets:Receivable:Acme:Expenses 212.40 USD", "Liabilities:Credit:Summit"],
    )
    # Raw bank text the snapshot shows by a display name (mobile/payees.py).
    tx(
        asof - dt.timedelta(days=5),
        "*",
        'Zelle Payment From Jordan Avery for Dinner\\"; Conf# Q7x2k9m4p\\"',
        "",
        ["Assets:Checking:Harbor 40.00 USD", "Assets:Receivable:Roommate"],
    )
    tx(
        asof - dt.timedelta(days=5),
        "*",
        "Acme Corp Des:expense Id:XR52Q7 Indn:Doe Jordan Co Id:9900000001 PPD",
        "",
        ["Assets:Checking:Harbor 212.40 USD", "Assets:Receivable:Acme:Expenses"],
    )
    tx(
        asof - dt.timedelta(days=5),
        "*",
        "HARBOR BANK DES:CASHREWARD ID:X1 INDN:DOE JORDAN CO ID:1234500000 PPD",
        "",
        ["Assets:Checking:Harbor 12.00 USD", "Income:Rebate:Cards"],
    )
    tx(
        asof - dt.timedelta(days=4),
        "*",
        "Summit Rewards",
        "Statement credit",
        ["Liabilities:Credit:Summit 15.00 USD", "Income:Rebate:Cards"],
    )
    tx(
        asof - dt.timedelta(days=3),
        "*",
        "",
        "Apple Inc. market sell 0.5 shares",
        [
            f"Assets:Investment:Northwind:Brokerage:AAPL -0.5 AAPL {{}} @ {price['AAPL']} USD",
            f"Assets:Investment:Northwind:Brokerage:USD {round(0.5 * price['AAPL'], 2)} USD",
            "Income:Trading:Stock",
        ],
    )
    tx(
        asof - dt.timedelta(days=2),
        "*",
        "Tokyo Metro",
        "Ginza to Asakusa",
        [
            "Expenses:Transportation:Public 1.41 USD",
            "Assets:Transit:Suica -210 JPY @ 0.0067 USD",
        ],
    )
    tx(
        asof - dt.timedelta(days=1),
        "*",
        "ATM Withdrawal Harbor Bank Main Street Branch 000417",
        "",
        ["Assets:Cash 80.00 USD", "Assets:Checking:Tidewater"],
    )
    tx(
        asof,
        "*",
        "Harvest Lane Co-op",
        "",
        [
            "Expenses:Groceries 31.75 USD",
            "Assets:Gift-Card:Coffee -12.00 USD",
            "Liabilities:Credit:Cobalt",
        ],
    )

    # Forecast entries after the as-of date.
    for offset in (10, 25, 40):
        d = asof + dt.timedelta(days=offset)
        tx(
            d,
            "!",
            "Acme Corp Payroll",
            "",
            [
                "Assets:Checking:Harbor 2450.00 USD",
                "Assets:Investment:Meridian:401k:USD 400.00 USD",
                "Income:Salary:Acme",
            ],
            'tid: "salary-harbor"',
        )
        tx(
            d,
            "!",
            "Acme Corp Payroll",
            "",
            ["Assets:Checking:Tidewater 150.00 USD", "Income:Salary:Acme"],
            'tid: "salary-tidewater"',
        )
    tx(
        asof + dt.timedelta(days=13),
        "!",
        "Maple Court Apartments",
        "Rent",
        ["Expenses:Home:Rent 1850.00 USD", "Assets:Checking:Harbor"],
    )
    tx(
        asof + dt.timedelta(days=17),
        "!",
        "Lakeside Auto Finance",
        "",
        [
            "Liabilities:Loan:Car 472.00 USD",
            "Expenses:Interest 78.25 USD",
            "Assets:Checking:Harbor -550.25 USD",
        ],
    )
    tx(
        asof + dt.timedelta(days=20),
        "!",
        "Benefit Card",
        "Commuter benefit load",
        ["Assets:Checking:Commuter 120.00 USD", "Income:Salary:Acme"],
    )
    return "\n".join(out) + "\n"


def cc_cards() -> dict:
    out = {}
    for i, card in enumerate(CARDS[:7]):
        out[f"Liabilities:Credit:{card}"] = {
            "fundingAccount": "Assets:Checking:Harbor"
            if i % 3
            else "Assets:Checking:Tidewater",
            "paymentDueDay": (4, 9, 14, 20, 24, 28, 31)[i],
            "statementBalance": f"{120.5 + 37.25 * i:.2f}",
        }
    return out


def statements() -> dict[str, list[dict]]:
    """Closed card statements as raw billing lines, per card. Summit and
    Pinnacle have none, so they stay on the cc-cards.json settings."""

    def line(card, sid, balance, due, minimum=None, source="fetch"):
        return {
            "account": f"Liabilities:Credit:{card}",
            "id": sid,
            "statementBalance": balance,
            "dueDate": due,
            "minimumPayment": minimum,
            "source": source,
            "capturedAt": f"{sid}T13:00:00+00:00",
        }

    def void(card, sid):
        return {
            "account": f"Liabilities:Credit:{card}",
            "id": sid,
            "void": True,
            "source": "manual",
            "capturedAt": f"{sid}T14:00:00+00:00",
        }

    return {
        # Open statement: due 06-26, where the settings alone would say 07-09.
        "Cobalt": [
            line("Cobalt", "2030-05-01", "301.15", "2030-05-26", "25.00"),
            line("Cobalt", "2030-06-01", "412.34", "2030-06-26", "25.00"),
        ],
        # The only statement was voided: back to the settings.
        "Meadowlark": [
            line("Meadowlark", "2030-06-02", "77.70", "2030-06-27"),
            void("Meadowlark", "2030-06-02"),
        ],
        # Due date already passed: the next due day, no statement amount.
        "Juniper": [line("Juniper", "2030-05-18", "64.20", "2030-06-12")],
        # No due date on record: predicted from paymentDueDay (24).
        "Atlas": [line("Atlas", "2030-05-28", "219.05", None, source="manual")],
        # Closes after the as-of date: not known yet.
        "Orchard": [line("Orchard", "2030-06-25", "999.99", "2030-07-20")],
        # A card with a statement on record but no planner settings.
        "Driftwood": [line("Driftwood", "2030-06-03", "88.10", "2030-06-28")],
    }


def write_ledger(root: Path) -> Path:
    """Write the synthetic ledger under ``root`` and return ``root``."""
    (root / "journal" / "plan").mkdir(parents=True, exist_ok=True)
    (root / "config").mkdir(parents=True, exist_ok=True)
    (root / "journal" / "journal.beancount").write_text(
        journal_text(), encoding="utf-8"
    )
    (root / "journal" / "plan" / "cc-cards.json").write_text(
        json.dumps(cc_cards(), indent=2), encoding="utf-8"
    )
    (root / "config" / "mobile.yaml").write_text(MOBILE_YAML, encoding="utf-8")
    (root / "config" / "ui.yaml").write_text(UI_YAML, encoding="utf-8")
    billing = root / "statements" / "billing" / "credit"
    billing.mkdir(parents=True, exist_ok=True)
    for card, lines in statements().items():
        (billing / f"{card}.jsonl").write_text(
            "".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8"
        )
    return root


if __name__ == "__main__":
    print(write_ledger(Path(sys.argv[1])))
