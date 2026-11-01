from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
import re

from titlecase import titlecase

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


def legacy_payee(description):
    """Payee as earlier versions derived it: drop a trailing 22-char
    city/state block when the row ends in a state code, and the AplPay prefix."""
    payee = titlecase(description.lower())
    for state in STATES:
        if description.endswith(f" {state}"):
            payee = payee[:-22]
            break
    return payee.replace("Aplpay", "").strip()


def clean_payee(description):
    """Merchant name from an Amex description.

    Amex pads the merchant name, city and state into fixed-width columns
    separated by runs of spaces ("DEMO CAFE           SPRINGFIELD         XX").
    Keep the first column only, so rows with no state code lose the city too.
    """
    payee = legacy_payee(description)
    return re.split(r"\s{2,}", payee, maxsplit=1)[0].strip()


def is_payment(description):
    """Card payments: MOBILE/ONLINE/AUTOPAY PAYMENT - THANK YOU."""
    desc = description.strip().upper()
    return desc.endswith("PAYMENT - THANK YOU") or desc.startswith("AUTOPAY PAYMENT")


def is_statement_credit(row):
    """Credits Amex funds itself (card benefits, Amex Offers, cash rewards), as
    opposed to a merchant refunding a purchase."""
    desc = " ".join(row["Description"].upper().split())
    details = " ".join((row.get("Extended Details") or "").upper().split())
    return (
        "AMEX OFFER CREDIT" in details
        or (desc.startswith("AMEX ") and desc.endswith(" CREDIT"))
        or desc.startswith("YOUR CASH REWARD")
    )


class AmexImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Amex", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def get_trans_ref(self, row, line):
        return row["Reference"][1:-1]

    def legacy_payee(self, row):
        return clean_payee(row["Description"])

    def descriptor_extras(self, row):
        return {
            key: row[key]
            for key in ("Extended Details", "Appears On Your Statement As")
            if row.get(key)
        }

    def handle_transaction(self, row, line):
        postings = []
        trans_amt = row["Amount"]
        trans_desc = clean_payee(row["Description"])
        # The activity CSV only lists posted rows. Should a status column ever
        # appear, a pending row stays `!`; nothing else changes the flag.
        flag = (
            flags.FLAG_WARNING
            if (row.get("Status") or "").strip().lower() == "pending"
            else flags.FLAG_OKAY
        )

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

        if is_payment(row["Description"]):
            account_name = self.payment_account

        elif D(trans_amt) < 0:
            if is_statement_credit(row):
                account_name = "Income:Rebate:Amex"
            else:
                # A merchant refund: same payee as the purchase.
                account_name = "Equity:FIXME"
                trans_desc = self.merchant_payee(row)

        else:
            trans_desc = self.merchant_payee(row)
            category = row["Category"]
            # Canonical payee first, then the pre-normalization payees
            # (clean, then legacy) for history not yet migrated.
            account_name = self.lookup_merchant_account(
                row, clean_payee(row["Description"]), legacy_payee(row["Description"])
            )
            if account_name is not None:
                pass
            elif "Restaurant" in category:
                account_name = "Expenses:Restaurants"
            else:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[row["Extended Details"], category, trans_amt],
                    all_accounts=self.all_accounts,
                )
                self.remember_merchant_account(trans_desc, account_name)

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
