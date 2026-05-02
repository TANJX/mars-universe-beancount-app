# importers located in the importers directory
import os
from datetime import datetime
from titlecase import titlecase

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


class CitiCheckingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[]):
        super().__init__("Citi", card_name, existing_refs)

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "checking" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row: str, line: str):
        return datetime.strptime(row["Date"], "%m-%d-%Y").date()

    def handle_transaction(self, row, line):
        trans_desc = titlecase(row["Description"].lower())
        trans_debit = row.get("Debit", "")
        trans_credit = row.get("Credit", "")
        trans_amt = "-" + trans_debit if trans_debit else trans_credit

        postings = []

        if trans_desc.startswith("Beginning Balance as of "):
            return ([], None, None)

        postings.append(
            data.Posting(
                f"Assets:Checking:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        flag = flags.FLAG_OKAY
        other_account = "Equity:FIXME"

        if trans_desc.startswith("Zelle Payment") or trans_desc.startswith(
            "Venmo Des:cashout"
        ):
            other_account = "Assets:Receivable:Others"

        elif trans_desc.startswith("Venmo Des:payment"):
            other_account = "Liabilities:Payable:Others"

        elif trans_desc.startswith("Citi Des:cashreward"):
            other_account = "Income:Rebate:Citi"

        elif trans_desc.startswith("Gpu Ach Initial Funding"):
            other_account = "Assets:Pending-Transfer"

        elif (
            trans_desc.startswith("Ach Electronic Debit - American Expr")
            or trans_desc.startswith("Ach Electronic Debit - Robinhood")
            or trans_desc == "Citi Credit Card Bill Payment"
            or trans_desc.startswith("Citi Electronic Payment")
        ):
            other_account = "Assets:Pending-Transfer"

        else:
            flag = flags.FLAG_WARNING

        postings.append(
            data.Posting(
                other_account,
                None,
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        return (postings, trans_desc, flag)
