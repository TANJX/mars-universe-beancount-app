"""Capital One credit card CSV export.

Header (myaccounts.capitalone.com "Download Transactions", CSV):
    Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
Dates are YYYY-MM-DD. A purchase fills Debit, a payment or refund fills
Credit; both are positive numbers. The export lists posted rows only.
"""

import os
from datetime import datetime

from beancount.core import amount, data, flags
from beancount.core.number import D

from beancount_tooling.importer.general_importer import GeneralImporter
from beancount_tooling.importer.helper import prompt_user_select

PAYMENT_PREFIXES = (
    "CAPITAL ONE MOBILE PYMT",
    "CAPITAL ONE ONLINE PYMT",
    "CAPITAL ONE AUTOPAY",
)


def signed_amount(row) -> str:
    """Liability posting amount: purchases negative, credits positive."""
    debit = (row.get("Debit") or "").replace(",", "").strip()
    credit = (row.get("Credit") or "").replace(",", "").strip()
    if debit:
        return f"-{debit}"
    return credit or "0"


class CapitalOneImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("CapitalOne", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "credit" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Transaction Date"], "%Y-%m-%d").date()

    def handle_transaction(self, row, line):
        trans_amt = signed_amount(row)
        trans_desc = self.legacy_payee(row)
        trans_cat = row.get("Category", "")
        raw = (row.get("Description") or "").upper()
        flag = flags.FLAG_OKAY

        postings = [
            data.Posting(
                f"Liabilities:Credit:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        ]

        if raw.startswith(PAYMENT_PREFIXES) or (
            trans_cat == "Payment/Credit" and "PYMT" in raw
        ):
            expense_account = self.payment_account
        elif D(trans_amt) > 0:
            # Refund or statement credit: second leg left for the reconciler.
            expense_account = "Equity:FIXME"
            trans_desc = self.merchant_payee(row)
        else:
            legacy_desc = trans_desc
            trans_desc = self.merchant_payee(row)
            expense_account = self.lookup_merchant_account(row, legacy_desc)
            if expense_account is None:
                expense_account = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_cat, trans_amt],
                    all_accounts=self.all_accounts,
                )
                self.remember_merchant_account(trans_desc, expense_account)

        postings.append(
            data.Posting(
                expense_account, None, cost=None, price=None, flag=None, meta=None
            )
        )
        return (postings, trans_desc, flag)
