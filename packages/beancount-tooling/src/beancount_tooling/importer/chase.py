from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase
from datetime import datetime

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class ChaseImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Chase", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Transaction Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc: str = titlecase(row["Description"].lower())
        trans_cat: str = row["Category"]
        flag = flags.FLAG_OKAY

        postings.append(
            data.Posting(
                f"Liabilities:Credit:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),  # chase already has negative amount
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        expense_account = ""

        if row["Description"] == "Payment Thank You-Mobile":
            expense_account = self.payment_account
            # flag = flags.FLAG_WARNING

        elif trans_desc.startswith("Lyft"):
            expense_account = "Expenses:Transportation:Cab"
            trans_desc = self.merchant_payee(row)

        elif trans_cat == "Fees & Adjustments" and float(trans_amt) > 0:
            expense_account = "Income:Rebate:Chase"

        elif trans_desc.startswith("Payment Thank You"):
            expense_account = "Assets:Pending-Transfer"

        elif D(trans_amt) > 0:
            # Unrecognized refund or credit: posted (the export only lists
            # posted rows), second leg left for the reconciler.
            expense_account = "Equity:FIXME"
            trans_desc = self.merchant_payee(row)

        else:
            legacy_desc = trans_desc
            trans_desc = self.merchant_payee(row)
            expense_account = self.lookup_merchant_account(row, legacy_desc)
            if expense_account is None:
                # prompt user in the terminal to choose an account
                expense_account = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_cat, trans_amt],
                    all_accounts=self.all_accounts,
                )
                self.remember_merchant_account(trans_desc, expense_account)

        postings.append(
            data.Posting(
                expense_account,
                None,
                cost=None,
                price=None,
                flag=None,
                meta=None,
            ),
        )

        return (postings, trans_desc, flag)
