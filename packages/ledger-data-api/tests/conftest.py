"""Shared harness: a synthetic ledger under tmp_path, loaded through Fava.

Layout mirrors a real ledger dir (invented names and amounts only):
    <tmp>/journal/journal.beancount
    <tmp>/journal/plan/{plans.jsonl,cc-cards.json,cc-expected.json}
    <tmp>/statements/billing/credit/<Card>.jsonl
"""

import datetime
import json
from collections import namedtuple
from pathlib import Path

import pytest

CARD = "Liabilities:Credit:DemoCard"
BANK = "Assets:Checking:Acme"

BASE_LEDGER = """
2030-01-01 open Assets:Checking:Acme USD
2030-01-01 open Assets:Checking:Other USD
2030-01-01 open Liabilities:Credit:DemoCard USD
2030-01-01 open Liabilities:Credit:Dormant USD
2030-01-01 open Expenses:Misc
2030-01-01 open Income:Rebate
2030-01-01 open Equity:Opening

2030-01-01 * "Opening"
  Assets:Checking:Acme   5000.00 USD
  Assets:Checking:Other  1000.00 USD
  Equity:Opening

2030-05-10 * "Shop" "before close"
  Liabilities:Credit:DemoCard  -1000.00 USD
  Expenses:Misc

2030-05-25 * "Shop" "after close"
  Liabilities:Credit:DemoCard  -200.00 USD
  Expenses:Misc

2030-05-28 * "Card payment"
  Liabilities:Credit:DemoCard  300.00 USD
  Assets:Checking:Acme
"""


def stmt_line(
    sid,
    balance="1000.00",
    due="2030-06-15",
    minimum=None,
    account=CARD,
    source="fetch",
):
    return {
        "account": account,
        "id": sid,
        "statementBalance": balance,
        "dueDate": due,
        "minimumPayment": minimum,
        "source": source,
        "capturedAt": f"{sid}T12:00:00+00:00",
    }


class Harness:
    def __init__(self, root: Path):
        self.root = root
        self.journal = root / "journal" / "journal.beancount"
        self.plan_dir = root / "journal" / "plan"
        self.billing_dir = root / "statements" / "billing" / "credit"
        self.plan_dir.mkdir(parents=True)
        self.billing_dir.mkdir(parents=True)
        self.write_ledger(BASE_LEDGER)

    @property
    def path(self) -> str:
        return str(self.journal)

    @property
    def plans_file(self) -> Path:
        return self.plan_dir / "plans.jsonl"

    @property
    def expected_file(self) -> Path:
        return self.plan_dir / "cc-expected.json"

    def write_ledger(self, text: str) -> None:
        self.journal.write_text(text)

    def write_cc_cards(self, records: dict) -> None:
        (self.plan_dir / "cc-cards.json").write_text(json.dumps(records))

    def write_expected(self, records: dict) -> None:
        self.expected_file.write_text(json.dumps(records))

    def write_statements(self, card_name: str, lines: list) -> None:
        body = "".join(
            (ln if isinstance(ln, str) else json.dumps(ln)) + "\n" for ln in lines
        )
        (self.billing_dir / f"{card_name}.jsonl").write_text(body)

    def write_plans(self, plans: list[dict]) -> None:
        with self.plans_file.open("a") as f:
            for p in plans:
                f.write(json.dumps({"op": "save", **p}) + "\n")

    def grid(self, today: datetime.date, *, use_statements: bool = True, **kw) -> dict:
        """What the plan_grid endpoint does, minus Flask."""
        from beanquery.query import run_query
        from fava.core import FavaLedger
        from fava.core.conversion import conversion_from_str
        from ledger_data_api import store
        from ledger_data_api.merge import build_grid_response

        led = FavaLedger(self.path)
        filtered = led.get_filtered()

        def exec_query(query):
            rtypes, rrows = run_query(filtered.entries, led.options, query)
            row = namedtuple("ResultRow", [c.name for c in rtypes])
            return [(t.name, t.datatype) for t in rtypes], [row(*r) for r in rrows]

        # Rows normally stop at the last plan; widen so projections are visible.
        kw.setdefault("end_date", today + datetime.timedelta(days=90))
        plans = store.list_plans(self.path)
        extra = {}
        if use_statements:
            from ledger_data_api import cc_statements

            # Like plan_grid: one snapshot, never a plan list read earlier.
            data = cc_statements.load_statement_data(self.path)
            plans = data.plans
            extra = {"statements": data.statements, "expected": data.expected}
        return build_grid_response(
            ledger=led,
            filtered=filtered,
            conversion=conversion_from_str("at_cost"),
            fava_options=led.fava_options,
            exec_query=exec_query,
            excluded_accounts=set(),
            plans=plans,
            transfers=store.list_transfers(self.path),
            cc_records=store.list_cc_card_records(self.path),
            settings=store.get_plan_settings(self.path),
            today=today,
            ledger_file_path=self.path,
            **extra,
            **kw,
        )


@pytest.fixture
def h(tmp_path) -> Harness:
    return Harness(tmp_path)


def plan_row(pid, date, amount, **tags) -> dict:
    return {
        "id": pid,
        "date": date,
        "account": BANK,
        "amount": amount,
        "description": "DemoCard",
        "state": None,
        "transferId": None,
        "createdAt": "2030-06-01T00:00:00+00:00",
        "updatedAt": "2030-06-01T00:00:00+00:00",
        **tags,
    }


def card(payload: dict, account: str = CARD) -> dict:
    return next(c for c in payload["ccCards"] if c["accountPath"] == account)


def entries(payload: dict, kind: str | None = None, account: str = BANK) -> list[dict]:
    """Grid entries on one bank column, each with its row date attached."""
    out = []
    for row in payload["rows"]:
        for ent in row["entries"].get(account, []):
            if kind is None or ent["kind"] == kind:
                out.append({**ent, "date": row["date"]})
    return out


CARD_CFG = {
    CARD: {"fundingAccount": BANK, "statementCloseDay": 20, "paymentDueDay": 15}
}
"""cc-cards.json for a statement-mode card: config only, no typed balance."""


def statement_mode(h: Harness, *lines, cfg: dict | None = None) -> None:
    """Config + closed statements for DemoCard (default: one, closed 05-20)."""
    h.write_cc_cards(CARD_CFG if cfg is None else cfg)
    h.write_statements("DemoCard", list(lines) or [stmt_line("2030-05-20")])
