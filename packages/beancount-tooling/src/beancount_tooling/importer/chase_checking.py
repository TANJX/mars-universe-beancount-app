# importers located in the importers directory
from datetime import datetime
import os
from titlecase import titlecase

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


class ChaseCheckingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[], type="checking"):
        super().__init__("Chase", card_name, existing_refs)
        self.type = type

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs:
            return False
        if self.type not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Posting Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row: str, line: str):
        trans_desc: str = titlecase(row["Description"].lower())
        trans_amt = row["Amount"]

        postings = []

        flag = flags.FLAG_OKAY
        postings.append(
            data.Posting(
                f"Assets:{self.type.title()}:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )
        other_account = "Expenses:FIXME"

        if row["Description"].startswith("CARNEGIE MELLON  DIRECT DEP"):
            trans_desc = "Carnegie Mellon Direct Deposit"
            other_account = "Income:Salary:CMU"

        elif (
            trans_desc.startswith("Payment to Chase Card")
            or trans_desc.startswith("American Express Ach PMT")
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
