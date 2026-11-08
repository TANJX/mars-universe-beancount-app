"""Capital One 360 bank account (checking / savings) CSV export.

Header (confirmed 2026-11-07, "Download Transactions" on a 360 account):
    Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance
Dates are MM/DD/YY. Amounts are unsigned and the Type column says Credit or
Debit; a returned deposit shows as a Debit with a negative amount, so the
signed amount is amount for Credit and -amount for Debit.
"""

import os
from datetime import datetime

from beancount.core import amount, data, flags
from beancount.core.number import D

from beancount_tooling.importer.general_importer import GeneralImporter

TRANSFER_PREFIXES = (
    "ACH Withdrawal",
    "ACH Deposit",
    "ACH Returned",
    "Withdrawal to",
    "Deposit from",
)


def signed_amount(row) -> str:
    value = D((row.get("Transaction Amount") or "0").replace(",", "").replace("$", ""))
    if (row.get("Transaction Type") or "").strip().lower() == "debit":
        value = -value
    return f"{value:.2f}"


class CapitalOneBankImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[], type="checking"):
        super().__init__("CapitalOne", card_name, existing_refs)
        self.type = type

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or self.type not in dirs:
            return False
        return super().identify(f)

    def raw_descriptor(self, row) -> str:
        return row.get("Transaction Description") or ""

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Transaction Date"], "%m/%d/%y").date()

    def handle_transaction(self, row, line):
        trans_amt = signed_amount(row)
        raw = self.raw_descriptor(row)
        trans_desc = self.legacy_payee(row)
        postings = [
            data.Posting(
                f"Assets:{self.type.title()}:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        ]
        if raw.startswith("Interest Paid"):
            other_account = f"Income:Interest:{self.card_name}"
        elif raw.startswith(TRANSFER_PREFIXES):
            other_account = "Assets:Pending-Transfer"
        else:
            other_account = "Equity:FIXME"
            trans_desc = self.bank_merchant_payee(row, trans_desc, trans_amt)
        postings.append(
            data.Posting(
                other_account, None, cost=None, price=None, flag=None, meta=None
            )
        )
        return (postings, trans_desc, flags.FLAG_OKAY)
