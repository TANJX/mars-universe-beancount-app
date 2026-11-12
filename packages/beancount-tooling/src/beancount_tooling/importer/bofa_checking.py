# importers located in the importers directory
import os
import re

from titlecase import titlecase

from beancount.core.number import D
from beancount.core import amount
from beancount.core import flags
from beancount.core import data
from beancount_tooling.importer.general_importer import GeneralImporter


# BofA exports a Zelle memo in quotes it does not escape, inside a field that is
# itself quoted:
#     "Zelle payment from A NAME for "dinner"; Conf# abc123"
# The csv module ends the quoted field at the memo's opening quote and keeps the
# rest as typed, so the description arrives as
#     Zelle payment from A NAME for dinner"; Conf# abc123"
# with two stray quotes. The parsed row feeds the `ref:` hash, so the row is left
# as parsed (re-parsing it would re-stamp every such row) and only the payee is
# repaired, to the form BofA itself uses for a one-word memo: `for dinner; Conf# ...`.
_STRAY_MEMO_QUOTES = re.compile(r'^(?P<head>[^"]*)"(?P<conf>; Conf# [^"]*)"$')


def strip_memo_quotes(description: str) -> str:
    """Drops the two stray quotes a quoted Zelle memo leaves in a description."""
    m = _STRAY_MEMO_QUOTES.match(description)
    return m["head"] + m["conf"] if m else description


class BofACheckingImporter(GeneralImporter):
    def __init__(self, card_name, existing_refs=[]):
        super().__init__("BofA", card_name, existing_refs)

    def identify(self, f):
        dirs = os.path.realpath(f).split("/")
        if self.card_name not in dirs or "checking" not in dirs:
            return False
        return super().identify(f)

    def get_lines(self, f):
        lines = open(f).readlines()
        # When BofA has no posted transactions for the requested range it returns a
        # one-line placeholder ("The time period you have requested to download has
        # no posted transactions.") instead of an empty table. That file has no blank
        # separator line, and letting the ValueError escape aborts the entire extract
        # run, including every other bank.
        if "\n" not in lines:
            print(f"[BofA] no transaction table in {f}; treating as no transactions")
            return []
        split_index = lines.index("\n")
        return lines[split_index + 1 :]

    def handle_transaction(self, row, line):
        trans_desc = strip_memo_quotes(titlecase(row["Description"].lower()))
        trans_amt = row["Amount"]

        postings = []

        if trans_desc.startswith("Beginning Balance as of "):
            return ([], None, None)

        postings.append(
            data.Posting(
                f"Assets:Checking:{self.card_name}",
                amount.Amount(D(trans_amt), "USD"),
                cost=None,
                price=None,
                flag=None,
                meta=None,
            )
        )

        flag = flags.FLAG_OKAY
        other_account = "Equity:FIXME"

        if trans_desc.startswith("Zelle Payment") or trans_desc.startswith(
            "Venmo Des:cashout"
        ):
            other_account = "Assets:Receivable:Others"

        elif trans_desc.startswith("Venmo Des:payment"):
            other_account = "Liabilities:Payable:Others"

        elif trans_desc.startswith("Bank of America Des:cashreward"):
            other_account = "Income:Rebate:BofA"

        elif trans_desc.startswith("Instalily Inc Des"):
            # trans_desc = "Carnegie Mellon Direct Deposit"
            other_account = "Income:Salary:Instalily"

        elif trans_desc.startswith("E-Zpass Rebill"):
            other_account = "Expenses:Transportation:Driving"
            trans_desc = self.merchant_payee(row)

        elif (
            trans_desc.startswith("American Express Des:ach")
            or row["Description"].startswith("WELLS FARGO CARD")
            or trans_desc == "Bank of America Credit Card Bill Payment"
            or trans_desc.startswith("Applecard Gsbank Des")
            or trans_desc.startswith("Apple Gs Savings Des")
            or trans_desc.startswith("Discover Des")
            or trans_desc.startswith("Discover Bank Des")
            or trans_desc.startswith("Chase Credit CRD Des")
            or trans_desc.startswith("Robinhood Des")
            or trans_desc.startswith("Deserve Inc Des:payment")
            or trans_desc.startswith("Ba Electronic Payment")
            or trans_desc.startswith("Robinhood Card Des")
            or trans_desc.startswith("Astra*future")
        ):
            other_account = "Assets:Pending-Transfer"

        # An unclassified debit is a merchant debit-card purchase (or an
        # unknown): book it under the canonical merchant payee.
        if other_account == "Equity:FIXME":
            trans_desc = self.bank_merchant_payee(row, trans_desc, trans_amt)

        # No `else` clause setting FLAG_WARNING here on purpose: the flag answers
        # "is this posted at the bank?", and BofA's stmt.csv only exports posted rows.
        # An un-determined second leg is signalled by Equity:FIXME alone.

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
