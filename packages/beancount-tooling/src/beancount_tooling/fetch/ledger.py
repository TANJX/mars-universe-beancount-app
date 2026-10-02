"""Ledger balances for the fetch shortcut.

When the balance a bank site shows equals the ledger balance for that account,
the ledger already holds every posted transaction, so the export is skipped. A
mismatch only means "download as usual", so the comparison errs on the side of
fetching: any pending or forecast entry dated today or earlier that the bank
has not posted yet just causes a normal export.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from beancount_tooling.fetch.config import AccountConfig

# statements/<type>/<name> -> ledger account, matching the importers
# (e.g. AmexImporter posts to Liabilities:Credit:<name>).
ACCOUNT_PREFIX = {
    "checking": "Assets:Checking",
    "credit": "Liabilities:Credit",
    "saving": "Assets:Saving",
}
CURRENCY = "USD"


def ledger_account(account: AccountConfig) -> str | None:
    kind, _, name = account.path.partition("/")
    prefix = ACCOUNT_PREFIX.get(kind)
    return f"{prefix}:{name}" if prefix and name else None


def expected_ledger_balance(account: AccountConfig, site_balance: Decimal) -> Decimal:
    """The ledger balance that matches what the site shows. Sites show credit
    card balances as a positive amount owed; the ledger holds a liability."""
    kind = account.path.partition("/")[0]
    return -site_balance if kind == "credit" else site_balance


class LedgerBalances:
    """Loads the journal once, on first use, and sums USD postings per account
    for every transaction dated on or before `as_of`."""

    def __init__(self, journal: Path, as_of: date):
        self.journal = journal
        self.as_of = as_of
        self._totals: dict[str, Decimal] | None = None

    def _load(self) -> dict[str, Decimal]:
        from beancount import loader
        from beancount.core import data

        entries, _errors, _ = loader.load_file(str(self.journal))
        totals: dict[str, Decimal] = {}
        for entry in entries:
            if not isinstance(entry, data.Transaction) or entry.date > self.as_of:
                continue
            for posting in entry.postings:
                units = posting.units
                if units is None or units.currency != CURRENCY:
                    continue
                totals[posting.account] = (
                    totals.get(posting.account, Decimal(0)) + units.number
                )
        return totals

    def balance(self, account_name: str) -> Decimal:
        if self._totals is None:
            self._totals = self._load()
        return self._totals.get(account_name, Decimal(0))
