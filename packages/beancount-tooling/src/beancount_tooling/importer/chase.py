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

        elif trans_cat == "Fees & Adjustments" and float(trans_amt) > 0:
            expense_account = "Income:Rebate:Chase"

        elif trans_desc.startswith("Payment Thank You"):
            expense_account = "Assets:Pending-Transfer"

        elif float(trans_amt) > 0:
            flag = flags.FLAG_WARNING

        else:
            if trans_desc in self.merchant_map:
                expense_account = self.merchant_map[trans_desc]
            else:
                # prompt user in the terminal to choose an account
                expense_account = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_cat, trans_amt],
                    all_accounts=self.all_accounts,
                )
                self.merchant_map[trans_desc] = expense_account

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
