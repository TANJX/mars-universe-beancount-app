import os
from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase
from datetime import datetime

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class AppleImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        expense_categories=[],
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Apple", card_name, existing_refs)

        self.payment_account = payment_account
        self.expense_categories = expense_categories
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "credit" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Transaction Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount (USD)"]
        trans_merchant = titlecase(row["Merchant"].lower())
        trans_cat = row["Category"]
        flag = flags.FLAG_OKAY

        postings.append(
            data.Posting(
                f"Liabilities:Credit:{self.card_name}",
                amount.Amount(-1 * D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        if trans_cat == "Payment":
            postings.append(
                data.Posting(
                    self.payment_account,
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )

        elif float(trans_amt) < 0:
            flag = flags.FLAG_WARNING

        else:
            if trans_merchant in self.merchant_map:
                account_name = self.merchant_map[trans_merchant]
            elif trans_merchant == "Uber":
                account_name = "Expenses:Transportation:Cab"
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_merchant,
                    info=[row["Transaction Date"], trans_merchant, trans_amt],
                    categories=self.expense_categories,
                    all_accounts=self.all_accounts,
                )
                self.merchant_map[trans_merchant] = account_name

            postings.append(
                data.Posting(
                    account_name,
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )

        return (postings, trans_merchant, flag)
