# importers located in the importers directory
import os
from datetime import datetime
from titlecase import titlecase

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


class TDCheckingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[], type="checking"):
        super().__init__("TD", card_name, existing_refs)
        self.type = type

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs:
            return False
        if self.type not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row: str, line: str):
        return datetime.strptime(row["Date"], "%Y-%m-%d").date()

    def handle_transaction(self, row, line):
        trans_desc = titlecase(row["Description"].lower())
        trans_debit = row.get("Debit", "")
        trans_credit = row.get("Credit", "")
        trans_amt = "-" + trans_debit if trans_debit else trans_credit
        # Ensure amount has 2 decimal places
        if "." not in trans_amt:
            trans_amt = trans_amt + ".00"

        postings = []

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

        flag = flags.FLAG_OKAY
        other_account = "Equity:FIXME"
        if (
            trans_desc.startswith("Online Xfer Transfer")
            or trans_desc.startswith("Ach Electronic Debit - Robinhood")
            or trans_desc.startswith("Chase Credit CRD Epay")
            or trans_desc.startswith("Discover")
            or trans_desc.startswith("Amex Epayment")
            or trans_desc.startswith("Applecard Gsbank Payment")
        ):
            other_account = "Assets:Pending-Transfer"
        elif trans_desc.startswith("Instalily Inc"):
            other_account = "Income:Salary:Instalily"
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
