"""X Money account CSV, as written by the `xmoney` statement fetcher.

X Money has no export of its own; fetch/banks/xmoney.py builds the file from
the Activity page. Header:
    Id,Date,Time,Amount,Balance,Type,Status,Mode,Counterparty,Label,Category,Code,Description
Date is New York (YYYY-MM-DD), Amount is signed (negative leaves the account),
Id is X's transaction id and the source of `ref:`. Description is the bank
statement descriptor (ACH rows only); Counterparty is the name X displays.

Zero-amount rows (ACH prenotes) and rows that are not completed are skipped.
"""

import os
import re
from datetime import datetime

from beancount.core import amount, data, flags
from beancount.core.number import D

from beancount_tooling.importer.general_importer import GeneralImporter
from beancount_tooling.importer.helper import hash_string

COMPLETED_STATUS = "Completed"
INTEREST_TYPE = "Interest Payout"
TRANSFER_CATEGORY = "Transfer"
# Micro-deposits another bank sends, then pulls back, to verify a link.
VERIFY_CODE = re.compile(r"^ACCT\s?VERIFY$", re.IGNORECASE)
BANK_PAYEE = "X Money"


class XMoneyImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=None, type="checking"):
        super().__init__("XMoney", card_name, existing_refs or [])
        self.type = type

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or self.type not in dirs:
            return False
        return super().identify(f)

    def raw_descriptor(self, row) -> str:
        return row.get("Description") or row.get("Counterparty") or ""

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Date"], "%Y-%m-%d").date()

    def get_trans_ref(self, row, line):
        return hash_string(row["Id"], prefix=row["Date"].replace("-", ""))

    def handle_transaction(self, row, line):
        trans_amt = D(row.get("Amount") or "0")
        if (row.get("Status") or COMPLETED_STATUS) != COMPLETED_STATUS or not trans_amt:
            return ([], "", flags.FLAG_OKAY)
        trans_desc = self.legacy_payee(row)
        postings = [
            data.Posting(
                f"Assets:{self.type.title()}:{self.card_name}",
                amount.Amount(trans_amt, "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        ]
        if row.get("Type") == INTEREST_TYPE:
            other_account = f"Income:Interest:{self.card_name}"
            trans_desc = BANK_PAYEE
        elif row.get("Category") == TRANSFER_CATEGORY or VERIFY_CODE.match(
            row.get("Code") or ""
        ):
            other_account = "Assets:Pending-Transfer"
            trans_desc = row.get("Counterparty") or trans_desc
        else:
            other_account = "Equity:FIXME"
            trans_desc = self.bank_merchant_payee(row, trans_desc, trans_amt)
        postings.append(
            data.Posting(
                other_account, None, cost=None, price=None, flag=None, meta=None
            )
        )
        return (postings, trans_desc, flags.FLAG_OKAY)
