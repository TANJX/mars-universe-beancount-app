from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from datetime import datetime
import os
from beancount_tooling.importer.helper import hash_string

from beancount_tooling.importer.helper import prompt_user_select
from beancount_tooling.importer.general_importer import GeneralImporter


class RobinhoodImporter(GeneralImporter):
    def __init__(
        self,
        card_name,
        existing_refs=[],
        type="credit",
        payment_account="Assets:FIXME",
        merchant_map=dict(),
        all_accounts=[],
    ):
        super().__init__("Robinhood", card_name, existing_refs)

        self.type = type
        self.payment_account = payment_account
        self.merchant_map = merchant_map
        self.all_accounts = all_accounts

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs:
            return False
        if self.type not in dirs:
            return False
        return super().identify(f)

    def _normalize_amount(self, amount_text):
        return amount_text.replace(",", "").replace("$", "")

    def get_trans_date(self, row, line):
        return datetime.strptime(row["Date"], "%Y-%m-%d").date()

    def get_trans_ref(self, row, line):
        if self.type != "credit":
            return hash_string(
                line, prefix=self.get_trans_date(row, line).strftime("%Y%m%d")
            )

        row_copy = row.copy()
        if "Balance" in row_copy:
            del row_copy["Balance"]
        line_copy = ",".join(row_copy.values())
        return hash_string(
            line_copy, prefix=self.get_trans_date(row, line).strftime("%Y%m%d")
        )

    def raw_descriptor(self, row):
        if self.type != "credit":
            return row.get("Description") or ""
        # Pending card rows have no Description yet; the Merchant column stands in.
        return row.get("Description") or row.get("Merchant") or ""

    def descriptor_extras(self, row):
        if self.type == "credit" and row.get("Merchant"):
            return {"Merchant": row["Merchant"]}
        return {}

    def legacy_payee(self, row):
        if self.type != "credit":
            return (row.get("Description") or "").strip()
        return row.get("Merchant") or ""

    def handle_transaction(self, row, line):
        if self.type in {"checking", "saving"}:
            return self._handle_bank_transaction(row)
        return self._handle_credit_transaction(row)

    def _handle_credit_transaction(self, row):
        if row["Status"] == "Declined":
            return ([], "", flags.FLAG_OKAY)

        postings = []
        trans_amt = self._normalize_amount(row["Amount"])
        trans_desc: str = row["Merchant"]
        trans_cat: str = row["Type"]
        flag = flags.FLAG_OKAY if row["Status"] == "Posted" else flags.FLAG_WARNING

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

        expense_account = ""

        if row["Type"] == "Payment":
            expense_account = self.payment_account
            # flag = flags.FLAG_WARNING

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

    def _handle_bank_transaction(self, row):
        postings = []
        trans_desc = row["Description"].strip()
        trans_amt = self._normalize_amount(row["Amount"])

        if D(trans_amt) == 0:
            return ([], "", flags.FLAG_OKAY)

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

        desc_upper = trans_desc.upper()
        flag = flags.FLAG_OKAY
        other_account = "Equity:FIXME"

        if "DIR DEP" in desc_upper:
            other_account = "Income:Salary:Instalily"
        elif trans_desc.startswith("Inter-Entity Transfer"):
            other_account = "Assets:Pending-Transfer"
        elif "INTEREST" in desc_upper:
            other_account = "Income:Interest:Robinhood"
        elif self.type == "checking":
            # An unclassified checking debit is a debit-card purchase; savings
            # rows are never merchant rows.
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
