import re

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from titlecase import titlecase
from datetime import datetime

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class BofAImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("BofA", card_name, existing_refs)

        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Posted Date"], "%m/%d/%Y").date()

    def get_trans_ref(self, row, line):
        return row["Reference Number"]

    def raw_descriptor(self, row):
        return row.get("Payee") or ""

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

        # Card payments credit the card: "PAYMENT - THANK YOU",
        # "PAYMENT FROM CHK <n> CONF#<n>", "BA ELECTRONIC PAYMENT". The word
        # boundary and sign keep a biller such as "PAYMENTUS ..." a purchase.
        is_payment = D(trans_amt) > 0 and (
            re.match(r"PAYMENT\b", row["Payee"].strip().upper())
            or trans_desc == "Ba Electronic Payment"
        )
        if is_payment:
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

        elif D(trans_amt) > 0:
            # A refund or statement credit. The export only lists posted rows,
            # so it stays `*`; the reconciler resolves the Equity:FIXME leg.
            trans_desc = self.merchant_payee(row)
            postings.append(
                data.Posting(
                    "Equity:FIXME",
                    None,
                    cost=None,
                    price=None,
                    flag=None,
                    meta=None,
                ),
            )

        else:
            legacy_desc = trans_desc
            trans_desc = self.merchant_payee(row)
            account_name = self.lookup_merchant_account(row, legacy_desc)
            if account_name is None:
                # prompt user in the terminal to choose an account
                account_name = prompt_user_select(
                    trans_desc,
                    info=[trans_desc, trans_amt],
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
