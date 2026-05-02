# importers located in the importers directory
import os
from datetime import datetime
from titlecase import titlecase

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


class WellsFargoCheckingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[]):
        super().__init__("Wells-Fargo", card_name, existing_refs)

    def get_lines(self, f):
        lines = open(f).readlines()
        lines.insert(0, "Date,Amount,x1,x2,Description\n")
        return lines

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "checking" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row: str, line: str):
        return datetime.strptime(row["Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row, line):
        trans_desc = titlecase(row["Description"].lower())
        trans_amt = row.get("Amount", "")

        postings = []

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

        elif trans_desc.startswith("Instalily Inc Pay"):
            other_account = "Income:Salary:Instalily"

        elif (
            trans_desc.startswith("American Express Ach PMT")
            or trans_desc.startswith("Discover E-Payment")
            or trans_desc.startswith("Chase Credit CRD")
            or trans_desc.startswith("Applecard Gsbank Payment")
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
