"""Robinhood investing accounts: the fetcher's cumulative CSV -> beancount entries.

Reads statements/investment/<card_name>/<Leaf>.csv (written by `just fetch`,
columns in fetch/banks/robinhood.py COLUMNS); the file stem is the ledger leaf,
so Brokerage.csv posts to Assets:Investment:<card_name>:Brokerage:{USD,<SYM>}.

Conventions (one entry per row, each with its own ref:):
- buy: <SYM> at cost {average price}, cash out, fees to Expenses:Fee.
- sell: explicit lots relieved first-in first-out from the ledger's open lots
  (Robinhood's default; its lot choice is not exposed), each `{cost} @ price`,
  proceeds to cash, Income:Trading:Stock as the plug.
- dividend -> Income:Trading:Dividend; interest -> Income:Interest:<card_name>;
  stock_lending -> Income:Trading:Stock; cc_rebate, deposit_boost and IRA match
  -> Income:Rebate:<card_name>; margin_interest -> Expenses:Fee.
- transfers: to or from another account in `account_numbers` are booked once,
  on the receiving file; anything else goes through Assets:Pending-Transfer.
  Deposits into an IRA carry `contribution:` (and `tax-year:` when it is not
  the entry's year).
- other (and anything that cannot be booked cleanly) -> `!` with Equity:FIXME.

Rows dated before `cutover` are skipped: earlier activity was booked by hand
without ref:, so importing it again would duplicate it.
"""

from __future__ import annotations

import csv
import os
from datetime import date
from decimal import Decimal

from beancount.core import amount, data, flags
from beancount.core.inventory import Inventory
from beancount.core.position import Cost, CostSpec, Position
from beangulp.importer import Importer

from beancount_tooling.importer.helper import hash_string

USD = "USD"
SHARE_EPSILON = Decimal("0.000001")
SKIPPED_TYPES = {"event_contract", "crypto"}


def _d(text: str) -> Decimal:
    return Decimal(text) if text not in ("", None) else Decimal(0)


def _usd(number: Decimal) -> amount.Amount:
    return amount.Amount(number, USD)


def _posting(account, units=None, cost=None, price=None, meta=None) -> data.Posting:
    return data.Posting(account, units, cost, price, None, meta)


class RobinhoodInvestmentImporter(Importer):
    def __init__(
        self,
        card_name: str,
        existing_refs=(),
        cutover: date | str | None = None,
        account_numbers: dict | None = None,
    ):
        self.card_name = card_name
        self.existing_refs = set(existing_refs)
        if isinstance(cutover, str):
            cutover = date.fromisoformat(cutover)
        self.cutover = cutover
        # account number -> ledger leaf, for transfers between tracked accounts
        self.account_numbers = {str(k): v for k, v in (account_numbers or {}).items()}

    # -- beangulp -----------------------------------------------------------

    def identify(self, filepath: str) -> bool:
        parts = os.path.realpath(filepath).split(os.sep)
        return (
            filepath.lower().endswith(".csv")
            and len(parts) >= 3
            and parts[-2] == self.card_name
            and parts[-3] == "investment"
        )

    def account(self, filepath: str) -> data.Account:
        return self._root(self._leaf(filepath))

    def _leaf(self, filepath: str) -> str:
        return os.path.splitext(os.path.basename(filepath))[0]

    def _root(self, leaf: str) -> str:
        return f"Assets:Investment:{self.card_name}:{leaf}"

    @staticmethod
    def _rows(filepath: str) -> list[dict[str, str]]:
        with open(filepath, newline="") as f:
            return list(csv.DictReader(f))

    def check_file(self, filepath: str) -> list[dict[str, str]]:
        """Fetch guard 2: every row must have an id, a date and a known shape."""
        rows = self._rows(filepath)
        for row in rows:
            if not row.get("Id"):
                raise ValueError("row without Id")
            date.fromisoformat(row["Date"])
            _d(row["Amount"])
            _d(row["Quantity"])
        return rows

    @staticmethod
    def ref_for(row: dict[str, str]) -> str:
        return hash_string(row["Id"], prefix=row["Date"].replace("-", ""))

    def extract(self, filepath: str, existing_entries=None) -> list[data.Transaction]:
        leaf = self._leaf(filepath)
        root = self._root(leaf)
        lots = LotBook(existing_entries or [], root)
        rows = sorted(
            self._rows(filepath), key=lambda r: (r["Date"], r["Time"], r["Id"])
        )
        entries = []
        for index, row in enumerate(rows):
            day = date.fromisoformat(row["Date"])
            if self.cutover is None or day < self.cutover:
                continue
            ref = self.ref_for(row)
            if ref in self.existing_refs:
                continue
            built = self._build(row, day, leaf, root, lots)
            if built is None:
                continue
            flag, narration, postings, meta = built
            postings[0] = postings[0]._replace(meta={"ref": ref})
            entry_meta = data.new_metadata(filepath, index + 2)
            entry_meta.update(meta)
            entries.append(
                data.Transaction(
                    entry_meta, day, flag, None, narration, set(), set(), postings
                )
            )
        return entries

    # -- row types ----------------------------------------------------------

    def _build(self, row, day, leaf, root, lots):
        kind = row["Type"]
        cash = f"{root}:USD"
        amt = _d(row["Amount"])
        fees = _d(row["Fees"])
        text = row["Description"]
        ok = flags.FLAG_OKAY
        rebate = f"Income:Rebate:{self.card_name}"

        if kind in SKIPPED_TYPES:
            return None
        if kind == "buy":
            symbol, quantity, price = (
                row["Symbol"],
                _d(row["Quantity"]),
                _d(row["Price"]),
            )
            stock = f"{root}:{symbol}"
            postings = [
                _posting(
                    stock,
                    amount.Amount(quantity, symbol),
                    CostSpec(price, None, USD, None, None, False),
                ),
                _posting(cash, _usd(amt)),
            ]
            if fees:
                postings.append(_posting("Expenses:Fee", _usd(fees)))
            lots.add(stock, quantity, price, day)
            return ok, text, postings, {}
        if kind == "sell":
            return self._sell(row, day, root, lots)
        if kind == "dividend":
            flag = ok if not fees else flags.FLAG_WARNING
            meta = {"withholding": _usd(fees)} if fees else {}
            return (
                flag,
                text,
                [_posting(cash, _usd(amt)), _posting("Income:Trading:Dividend")],
                meta,
            )
        simple = {
            "interest": f"Income:Interest:{self.card_name}",
            "stock_lending": "Income:Trading:Stock",
            "cc_rebate": rebate,
            "deposit_boost": rebate,
            "margin_interest": "Expenses:Fee",
        }
        if kind in simple:
            return ok, text, [_posting(cash, _usd(amt)), _posting(simple[kind])], {}
        if kind in ("transfer_in", "transfer_out"):
            return self._transfer(row, day, leaf, root, rebate)
        return (
            flags.FLAG_WARNING,
            text or f"Robinhood {kind}",
            [_posting(cash, _usd(amt)), _posting("Equity:FIXME", _usd(-amt))],
            {},
        )

    def _transfer(self, row, day, leaf, root, rebate):
        amt = _d(row["Amount"])
        match = _d(row["Match"])
        other_leaf = self.account_numbers.get(row["Counterparty"])
        if row["Type"] == "transfer_out" and other_leaf:
            return None  # booked on the receiving account's file
        cash = f"{root}:USD"
        source = (
            f"{self._root(other_leaf)}:USD" if other_leaf else "Assets:Pending-Transfer"
        )
        if row["Type"] == "transfer_out":
            return (
                flags.FLAG_OKAY,
                row["Description"],
                [
                    _posting(cash, _usd(amt)),
                    _posting(source, _usd(-amt)),
                ],
                {},
            )
        postings = [_posting(cash, _usd(amt + match)), _posting(source, _usd(-amt))]
        if match:
            postings.append(_posting(rebate, _usd(-match)))
        meta = {}
        if "IRA" in leaf.upper():
            meta["contribution"] = _usd(amt)
            if row["TaxYear"] and row["TaxYear"] != str(day.year):
                meta["tax-year"] = Decimal(row["TaxYear"])
        return flags.FLAG_OKAY, row["Description"], postings, meta

    def _sell(self, row, day, root, lots):
        symbol, quantity, price = row["Symbol"], _d(row["Quantity"]), _d(row["Price"])
        stock = f"{root}:{symbol}"
        relieved, short = lots.relieve_fifo(stock, quantity)
        postings = []
        for lot_quantity, cost, show_date in relieved:
            spec = CostSpec(
                cost.number, None, USD, cost.date if show_date else None, None, False
            )
            postings.append(
                _posting(stock, amount.Amount(-lot_quantity, symbol), spec, _usd(price))
            )
        meta = {}
        flag = flags.FLAG_OKAY
        if short > 0:
            # The ledger does not hold enough shares: leave the rest for a human.
            flag = flags.FLAG_WARNING
            meta["fixme"] = f"ledger lots short by {short} {symbol}"
            postings.append(
                _posting(
                    stock,
                    amount.Amount(-short, symbol),
                    CostSpec(None, None, None, None, None, False),
                    _usd(price),
                )
            )
        postings.append(_posting(f"{root}:USD", _usd(_d(row["Amount"]))))
        fees = _d(row["Fees"])
        if fees:
            postings.append(_posting("Expenses:Fee", _usd(fees)))
        postings.append(_posting("Income:Trading:Stock"))
        return flag, row["Description"], postings, meta


class LotBook:
    """Open lots per stock account: the ledger's, then this batch's buys and sells."""

    def __init__(self, entries, root: str):
        self.inventories: dict[str, Inventory] = {}
        prefix = root + ":"
        for entry in entries:
            if not isinstance(entry, data.Transaction):
                continue
            for p in entry.postings:
                if p.account.startswith(prefix) and isinstance(p.cost, Cost):
                    self.inventories.setdefault(p.account, Inventory()).add_position(
                        Position(p.units, p.cost)
                    )

    def add(self, account: str, quantity: Decimal, price: Decimal, day: date) -> None:
        cost = Cost(price, USD, day, None)
        self.inventories.setdefault(account, Inventory()).add_position(
            Position(amount.Amount(quantity, account.rsplit(":", 1)[-1]), cost)
        )

    def relieve_fifo(self, account: str, quantity: Decimal):
        """[(quantity, cost, show_date)] oldest first, and the unmatched remainder.

        show_date is set when another open lot shares the cost number, so the
        reduction is not ambiguous for beancount."""
        inventory = self.inventories.setdefault(account, Inventory())
        open_lots = sorted(
            (pos for pos in inventory if pos.cost is not None and pos.units.number > 0),
            key=lambda pos: (pos.cost.date or date.min, pos.cost.number),
        )
        numbers = [pos.cost.number for pos in open_lots]
        remaining = quantity
        relieved = []
        for pos in open_lots:
            if remaining <= SHARE_EPSILON:
                break
            take = min(pos.units.number, remaining)
            relieved.append((take, pos.cost, numbers.count(pos.cost.number) > 1))
            inventory.add_position(
                Position(amount.Amount(-take, pos.units.currency), pos.cost)
            )
            remaining -= take
        return relieved, (remaining if remaining > SHARE_EPSILON else Decimal(0))
