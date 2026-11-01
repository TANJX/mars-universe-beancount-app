# importers located in the importers directory
import csv
import os
import re
from beancount_tooling import merchants
from beancount_tooling.importer.helper import hash_string

from beangulp.importer import Importer
from titlecase import titlecase
from beancount.core import flags
from beancount.core import data
from beancount.core.number import D
from datetime import datetime


class GeneralImporter(Importer):
    def __init__(self, bank_name, card_name, existing_refs=[]):
        super().__init__()
        self.bank_name = bank_name
        self.card_name = card_name
        self.existing_refs = existing_refs
        # Credit importers replace this with the journal's learned map.
        self.merchant_map = {}
        # (date, payee, raw descriptor) of merchant rows no alias or rule matched.
        self.unmapped = []
        self._merchant_memo = None
        self._merchant_row = None

    def identify(self, f):
        if self.card_name not in os.path.realpath(f).split("/"):
            return False
        if not re.match(r".*\.csv$", os.path.basename(f).lower()):
            return False
        return True

    def get_trans_date(self, row: str, line: str):
        return datetime.strptime(row["Date"], "%m/%d/%Y").date()

    def get_trans_ref(self, row, line):
        return hash_string(
            line,
            prefix=self.get_trans_date(row, line).strftime("%Y%m%d"),
        )

    def account(self, filepath: str) -> data.Account:
        return ""

    def get_lines(self, f):
        return open(f).readlines()

    def handle_transaction(self, row: str, line: str):
        return ([], "", flags.FLAG_OKAY)

    # --- merchant normalization ------------------------------------------------

    def raw_descriptor(self, row) -> str:
        """The untouched bank text for the row (stored as `raw:`)."""
        return row.get("Description") or ""

    def descriptor_extras(self, row) -> dict[str, str]:
        """Other columns that can disambiguate a payee (Amex Extended Details)."""
        return {}

    def legacy_payee(self, row) -> str:
        """The payee this importer booked before normalization."""
        return titlecase(self.raw_descriptor(row).lower())

    def merchant(self, row) -> merchants.Merchant:
        """Normalized merchant for the row, memoized for the current row."""
        key = tuple(row.items())
        if self._merchant_memo is not None and self._merchant_memo[0] == key:
            return self._merchant_memo[1]
        result = merchants.normalize(
            self.raw_descriptor(row),
            self.legacy_payee(row),
            extra=self.descriptor_extras(row),
        )
        self._merchant_memo = (key, result)
        return result

    def merchant_payee(self, row) -> str:
        """Payee for a merchant row. Marks the row so `extract` adds the
        narration detail and `raw:`. Payment and transfer branches don't call
        this and keep their own payee."""
        result = self.merchant(row)
        self._merchant_row = result
        return result.payee

    def bank_merchant_payee(self, row, payee: str, amount) -> str:
        """Checking accounts: only an unclassified debit is a merchant
        (debit-card) row. Unclassified credits (payroll, interest, refunds,
        incoming transfers) keep their payee and are not reported unmapped."""
        if D(str(amount).replace("$", "").replace(",", "")) < 0:
            return self.merchant_payee(row)
        return payee

    def lookup_merchant_account(self, row, *legacy_keys: str) -> str | None:
        """Learned account for the row: canonical payee first, then the
        importer's pre-normalization payee(s) for history not yet migrated.

        A payee whose history is split between expenses and gift-card or
        reimbursable purchases is looked up by its descriptor variant first
        (`MerchantRoutes.variants`). ``None`` from the map means "known, but
        not an expense route": stop and let the importer prompt."""
        routes = self.merchant_map
        payee = self.merchant(row).payee
        if payee in getattr(routes, "mixed", ()):
            variants = routes.variants
            for key in (self.raw_descriptor(row), self.legacy_payee(row), *legacy_keys):
                if key and key in variants:
                    return variants[key]
        for key in (payee, *legacy_keys):
            if key and key in routes:
                return routes[key]
        return None

    def remember_merchant_account(self, payee: str, account: str) -> None:
        """Reuse a prompted account for the payee's later rows in this run.

        Equity:FIXME (the non-interactive fallback, or a deliberate "decide
        later") is not remembered: keyed by the canonical payee it would
        otherwise shadow the learned account of every other descriptor
        variant of the same merchant."""
        if not account or account == "Equity:FIXME":
            return
        # A payee the journal routes to gift cards or receivables (None) is
        # asked row by row: one answer does not fit its next purchase.
        if payee in self.merchant_map and self.merchant_map[payee] is None:
            return
        self.merchant_map[payee] = account

    def categorize_row(self, row, line: str = ""):
        """handle_transaction plus the Merchant it booked as payee (None for
        payments, transfers and other non-merchant rows)."""
        self._merchant_row = None
        postings, payee, flag = self.handle_transaction(row, line)
        result = self._merchant_row
        self._merchant_row = None
        if result is None or not result.is_merchant or payee != result.payee:
            result = None
        return postings, payee, flag, result

    def extract(self, f, existing_entries):
        entries = []

        lines = self.get_lines(f)
        csv_reader = csv.DictReader(lines)
        # cls()

        for i, row in enumerate(csv_reader):
            if None in row:
                del row[None]
            line = ",".join(row.values())
            trans_date = self.get_trans_date(row, line)
            trans_ref = self.get_trans_ref(row, line)

            if trans_ref in self.existing_refs:
                continue

            tags = dict()
            tags["ref"] = trans_ref

            postings, trans_desc, flag, merchant = self.categorize_row(row, line)

            if len(postings) == 0:
                continue

            # reconstruct the first posting with tags
            postings[0] = data.Posting(
                postings[0].account,
                postings[0].units,
                postings[0].cost,
                postings[0].price,
                postings[0].flag,
                tags,
            )

            meta = data.new_metadata(f, trans_ref)
            narration = None
            if merchant is not None:
                narration = merchant.detail
                raw = self.raw_descriptor(row)
                if raw and raw != trans_desc:
                    meta["raw"] = raw
                if merchant.status == merchants.STATUS_UNMAPPED:
                    self.unmapped.append((trans_date, trans_desc, raw))
            txn = data.Transaction(
                meta=meta,
                date=trans_date,
                flag=flag,
                payee=trans_desc,
                narration=narration,
                tags=set(),
                links=set(),
                postings=postings,
            )
            entries.append(txn)

        return entries
