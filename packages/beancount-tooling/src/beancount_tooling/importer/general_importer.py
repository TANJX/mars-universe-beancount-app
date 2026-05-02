# importers located in the importers directory
import csv
import os
import re
from beancount_tooling.importer.helper import hash_string

from beangulp.importer import Importer
from beancount.core import flags
from beancount.core import data
from datetime import datetime


class GeneralImporter(Importer):
    def __init__(self, bank_name, card_name, existing_refs=[]):
        super().__init__()
        self.bank_name = bank_name
        self.card_name = card_name
        self.existing_refs = existing_refs

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

            postings, trans_desc, flag = self.handle_transaction(row, line)

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
            txn = data.Transaction(
                meta=meta,
                date=trans_date,
                flag=flag,
                payee=trans_desc,
                narration=None,
                tags=set(),
                links=set(),
                postings=postings,
            )
            entries.append(txn)

        return entries
