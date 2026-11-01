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
        other_account = "Equity:FIXME"

        if row["Description"].startswith("CARNEGIE MELLON  DIRECT DEP"):
            trans_desc = "Carnegie Mellon Direct Deposit"
            other_account = "Income:Salary:CMU"

        elif (
            trans_desc.startswith("Payment to Chase Card")
            or trans_desc.startswith("American Express Ach PMT")
            or trans_desc.startswith("Applecard Gsbank Payment")
        ):
            other_account = "Assets:Pending-Transfer"

        # An unclassified debit is a merchant debit-card purchase (or an
        # unknown): book it under the canonical merchant payee.
        if other_account == "Equity:FIXME":
            trans_desc = self.bank_merchant_payee(row, trans_desc, trans_amt)

        # No FLAG_WARNING for an unknown description: the flag answers "is this
        # posted at the bank?", and this export only carries posted rows. An
        # un-determined second leg is signalled by Equity:FIXME alone.

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
