from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase
from datetime import datetime

from beancount_tooling.importer.helper import match_merchant_patterns
from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class BofAImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        merchant_patterns=[],
        all_accounts=[],
    ):
        super().__init__("BofA", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.merchant_patterns = merchant_patterns
        self.all_accounts = all_accounts

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Posted Date"], "%m/%d/%Y").date()

    def get_trans_ref(self, row, line):
        return row["Reference Number"]

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc = titlecase(row["Payee"].lower())
        flag = flags.FLAG_OKAY

        postings.append(
            data.Posting(
                f"Liabilities:Credit:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),  # BofA already has negative amount
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        if (
            row["Payee"] == "PAYMENT - THANK YOU"
            or trans_desc == "Ba Electronic Payment"
        ):
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

        elif float(trans_amt) > 0:
            flag = flags.FLAG_WARNING

        else:
            pattern_account = match_merchant_patterns(
                self.merchant_patterns, [row["Payee"], trans_desc]
            )
            if pattern_account:
                account_name = pattern_account
            elif trans_desc in self.merchant_map:
                account_name = self.merchant_map[trans_desc]
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_amt],
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
