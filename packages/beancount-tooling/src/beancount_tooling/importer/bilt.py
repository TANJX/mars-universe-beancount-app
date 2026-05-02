from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class BiltImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Bilt", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def get_lines(self, f):
        lines = open(f).readlines()
        lines.insert(0, "Date,Amount,x1,x2,Description\n")
        return lines

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc = titlecase(row["Description"].lower())
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

        if row["Description"] == "Bill Pay Payment":
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

        elif float(trans_amt) > 0:
            flag = flags.FLAG_WARNING

        else:
            if trans_desc in self.merchant_map:
                account_name = self.merchant_map[trans_desc]
            elif trans_desc.startswith("Lyft"):
                account_name = "Expenses:Transportation:Cab"
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[row["Date"], trans_desc, trans_amt],
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
