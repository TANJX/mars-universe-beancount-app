import os
from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase
from datetime import datetime

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class DiscoverImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Discover", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "credit" not in dirs:
            return False
        return super().identify(f)

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Trans. Date"], "%m/%d/%Y").date()

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc = titlecase(row["Description"].lower())
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

        if row["Description"] == "INTERNET PAYMENT - THANK YOU":
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
            # flag = flags.FLAG_WARNING

        elif trans_desc.startswith("Mta*nyct"):
            postings.append(
                data.Posting(
                    "Expenses:Transportation:Public",
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )
            # flag = flags.FLAG_WARNING

        elif trans_cat == "Interest":
            postings.append(
                data.Posting(
                    "Expenses:Interest",
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )

        elif trans_cat == "Awards and Rebate Credits":
            postings.append(
                data.Posting(
                    "Income:Rebate:Discover",
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )

        elif float(row["Amount"]) < 0:
            flag = flags.FLAG_WARNING

        else:
            if trans_desc in self.merchant_map:
                account_name = self.merchant_map[trans_desc]
            elif "Restaurant" in trans_cat:
                account_name = "Expenses:Restaurants"
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_cat, trans_amt],
                    all_accounts=self.all_accounts,
                )
                self.merchant_map[trans_desc] = account_name

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

        return (postings, trans_desc, flag)
