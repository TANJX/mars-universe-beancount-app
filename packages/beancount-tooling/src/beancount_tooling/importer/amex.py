from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase

from beancount_tooling.importer.helper import match_merchant_patterns
from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter

STATES = [
    "AL",
    "AK",
    "AZ",
    "AR",
    "AS",
    "CA",
    "CO",
    "CT",
    "DE",
    "DC",
    "FL",
    "GA",
    "GU",
    "HI",
    "ID",
    "IL",
    "IN",
    "IA",
    "KS",
    "KY",
    "LA",
    "ME",
    "MD",
    "MA",
    "MI",
    "MN",
    "MS",
    "MO",
    "MT",
    "NE",
    "NV",
    "NH",
    "NJ",
    "NM",
    "NY",
    "NC",
    "ND",
    "MP",
    "OH",
    "OK",
    "OR",
    "PA",
    "PR",
    "RI",
    "SC",
    "SD",
    "TN",
    "TX",
    "TT",
    "UT",
    "VT",
    "VA",
    "VI",
    "WA",
    "WV",
    "WI",
    "WY",
]


class AmexImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        merchant_patterns=[],
        all_accounts=[],
    ):
        super().__init__("Amex", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.merchant_patterns = merchant_patterns
        self.all_accounts = all_accounts

    def get_trans_ref(self, row, line):
        return row["Reference"][1:-1]

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc = titlecase(row["Description"].lower())
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

        if (
            row["Description"] == "MOBILE PAYMENT - THANK YOU"
            or row["Description"] == "ONLINE PAYMENT - THANK YOU"
            or row["Description"].startswith("AUTOPAY PAYMENT")
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

        elif float(row["Amount"]) < 0:
            if trans_desc == "Amex Dining Credit":
                postings.append(
                    data.Posting(
                        "Income:Rebate:Amex",
                        None,
                        cost=None,
                        price=None,
                        flag=None,
                        meta=None,
                    ),
                )
            else:
                flag = flags.FLAG_WARNING

        else:
            # remove last 22 characters (location)
            for state in STATES:
                if row["Description"].endswith(f" {state}"):
                    trans_desc = trans_desc[:-22]
                    break

            # remove Apple Pay
            trans_desc = trans_desc.replace("Aplpay", "")
            trans_desc = trans_desc.strip()

            category = row["Category"]

            pattern_account = match_merchant_patterns(
                self.merchant_patterns, [row["Description"], trans_desc]
            )

            # Determine the account to use
            if pattern_account:
                account_name = pattern_account
            elif trans_desc in self.merchant_map:
                account_name = self.merchant_map[trans_desc]
            elif "Restaurant" in category:
                account_name = "Expenses:Restaurants"
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[row["Extended Details"], category, trans_amt],
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
