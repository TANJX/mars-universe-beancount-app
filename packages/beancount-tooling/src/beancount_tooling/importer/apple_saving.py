import os
from datetime import datetime

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


class AppleSavingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[]):
        super().__init__("Apple", card_name, existing_refs)

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "saving" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Transaction Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row, line):
        trans_desc = row["Description"]
        trans_amt = row["Amount"]
        if row["Transaction Type"] == "Debit":
            trans_amt = f"-{trans_amt}"
        flag = flags.FLAG_OKAY

        postings = []

        postings.append(
            data.Posting(
                f"Assets:Saving:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        if trans_desc == "Daily Cash Deposit":
            posting_account = "Income:Rebate:Apple"

        elif trans_desc == "Interest Paid" or trans_desc == "Interest Adjustment":
            posting_account = "Income:Interest:Apple"

        elif (
            trans_desc == "ACH Transfer to TREASURY DIRECT TREAS DRCT"
            or trans_desc == "ACH Transfer from APA  TREAS 310 MISC PAY"
        ):
            posting_account = "Assets:Investment:Treasury-Bill"

        elif trans_desc.startswith("ACH Online transfer to B") or trans_desc.startswith(
            "ACH Online transfer from B"
        ):
            posting_account = "Assets:Pending-Transfer"
            # flag = flags.FLAG_WARNING
        else:
            posting_account = "Equity:FIXME"
            flag = flags.FLAG_WARNING

        postings.append(
            data.Posting(
                posting_account,
                None,
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )
        return (postings, trans_desc, flag)
