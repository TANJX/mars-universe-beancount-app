"""Pending checking rows: site parsing, the snapshot, the runner, extract."""

from datetime import date
from decimal import Decimal

from beancount import loader
from beancount_tooling import pending
from beancount_tooling.fetch import runner
from beancount_tooling.fetch.banks import bofa, td
from beancount_tooling.fetch.config import load_config
from beancount_tooling.pending import PendingRow

from .test_login_and_runner import BalanceFetcher, _fx

# --- site parsing ------------------------------------------------------------


def test_td_pending_cells():
    row = td.parse_pending_cells(
        ["10/8/2030", "DIRECTDEP", "DEMO EMPLOYER", "$652.02", "Pending", "Collapse"]
    )
    assert row == PendingRow(date(2030, 10, 8), "DEMO EMPLOYER", Decimal("652.02"))
    posted = ["10/6/2030", "DEBIT", "DEMO CARD PMT", "-$10.00", "$60.88", "Collapse"]
    assert td.parse_pending_cells(posted) is None
    assert td.parse_pending_cells(["PENDING TRANSACTIONS"]) is None


def test_bofa_pending_cells_and_dates():
    today = date(2030, 10, 8)
    row = bofa.parse_pending_cells(
        [
            "Processing",
            "ACH HOLD DEMO BROKER Funds ON 10/07",
            "Debit",
            "-$320.00",
            "$1,071.73",
            "",
        ],
        today,
    )
    assert row == PendingRow(
        date(2030, 10, 7), "ACH HOLD DEMO BROKER Funds ON 10/07", Decimal("-320.00")
    )
    zelle = bofa.parse_pending_cells(
        [
            "Processing",
            "Zelle Transfer CONF# X1; DEMO PERSON",
            "Debit",
            "-$27.76",
            "$1.00",
            "",
        ],
        today,
    )
    assert zelle.date == today and zelle.amount == Decimal("-27.76")
    posted = ["10/02/2030", "DEMO DES:Payment", "Other Payment", "-$5.00", "$1.00", ""]
    assert bofa.parse_pending_cells(posted, today) is None
    # A hold dated after today belongs to last year (January run, December hold).
    assert bofa.pending_date("HOLD ON 12/30", date(2031, 1, 2)) == date(2030, 12, 30)


def test_ids_ignore_date_and_number_duplicates():
    a = PendingRow(date(2030, 1, 1), "Zelle  to DEMO", Decimal(-5))
    b = PendingRow(date(2030, 1, 2), "Zelle to DEMO", Decimal("-5.00"))
    c = PendingRow(date(2030, 1, 2), "Other", Decimal("-5.00"))
    ids = [r.id for r in pending.with_ids([a, b, c])]
    assert ids[1] == ids[0] + "-2"
    assert ids[2] != ids[0]
    assert pending.with_ids([b])[0].id == ids[0]


def test_snapshot_round_trip(tmp_path):
    path = pending.snapshot_path(tmp_path, "checking/Demo")
    assert path == tmp_path / "pending/checking/Demo.csv"
    rows = [PendingRow(date(2030, 1, 1), 'Say "hi", ok', Decimal("-1.50"))]
    pending.write_snapshot(path, rows)
    back = pending.read_snapshot(path)
    assert back == pending.with_ids(rows)
    pending.write_snapshot(path, [])
    assert pending.read_snapshot(path) == []


# --- runner ------------------------------------------------------------------


class PendingFetcher(BalanceFetcher):
    balance_includes_pending = True

    def __init__(self, files, site, rows):
        super().__init__(files, site)
        self.rows = rows  # account.path -> list of PendingRow, or an Exception

    def read_pending(self, page, account):
        value = self.rows.get(account.path)
        if isinstance(value, Exception):
            raise value
        return value


class _Ledger:
    def __init__(self, balances):
        self.balances = balances

    def balance(self, name):
        return self.balances.get(name, Decimal(0))


def _run(tmp_path, monkeypatch, rows, site, ledger, dry_run=False):
    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    fetcher = PendingFetcher(
        {"credit/DemoCard": [(_fx("bofa_credit.csv"), "current_1111.csv", "rolling")]},
        site,
        rows,
    )
    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path / "run",
        tmp_path / "statements",
        fetcher=fetcher,
        log=lambda s: None,
        ledger=_Ledger(ledger),
        dry_run=dry_run,
    )
    return {o.account.path: o for o in outcomes}, fetcher


def test_runner_subtracts_pending_writes_snapshot_and_lists_rows(tmp_path, monkeypatch):
    rows = [
        PendingRow(date(2030, 10, 7), "ACH HOLD DEMO", Decimal("-320.00")),
        PendingRow(date(2030, 10, 8), "Zelle to DEMO", Decimal("-27.76")),
    ]
    by_path, fetcher = _run(
        tmp_path,
        monkeypatch,
        rows={"checking/DemoChecking": rows},
        site={"checking/DemoChecking": Decimal("1071.73")},
        ledger={"Assets:Checking:DemoChecking": Decimal("1419.49")},
    )
    assert "checking/DemoChecking" not in fetcher.fetched
    checking = by_path["checking/DemoChecking"]
    assert "balance matches ledger (1,419.49 posted" in checking.detail
    text = "\n".join(checking.notes)
    assert "2 pending (-347.76)" in text and "Zelle to DEMO" in text
    snap = pending.snapshot_path(tmp_path / "statements", "checking/DemoChecking")
    assert [r.amount for r in pending.read_snapshot(snap)] == [
        Decimal("-320.00"),
        Decimal("-27.76"),
    ]


def test_runner_read_failure_keeps_snapshot(tmp_path, monkeypatch):
    snap = pending.snapshot_path(tmp_path / "statements", "checking/DemoChecking")
    old = [PendingRow(date(2030, 1, 1), "OLD", Decimal("-1.00"))]
    pending.write_snapshot(snap, old)
    by_path, _ = _run(
        tmp_path,
        monkeypatch,
        rows={"checking/DemoChecking": RuntimeError("selector changed")},
        site={"checking/DemoChecking": Decimal("10.00")},
        ledger={"Assets:Checking:DemoChecking": Decimal("10.00")},
    )
    assert by_path["checking/DemoChecking"].ok
    assert any("pending not read" in n for n in by_path["checking/DemoChecking"].notes)
    assert pending.read_snapshot(snap) == pending.with_ids(old)


def test_runner_dry_run_writes_no_snapshot(tmp_path, monkeypatch):
    _run(
        tmp_path,
        monkeypatch,
        rows={"checking/DemoChecking": []},
        site={},
        ledger={},
        dry_run=True,
    )
    assert not (tmp_path / "statements" / "pending").exists()


def test_ledger_balances_skip_booked_pending(tmp_path):
    from beancount_tooling.fetch.ledger import LedgerBalances

    journal = tmp_path / "j.beancount"
    journal.write_text(
        "2030-01-01 open Assets:Checking:Demo\n"
        "2030-01-01 open Expenses:Food\n"
        '2030-01-02 * "Shop"\n  Assets:Checking:Demo  -3.00 USD\n  Expenses:Food\n'
        '2030-01-03 ! "Held"\n  pending: "pabc"\n'
        "  Assets:Checking:Demo  -1.50 USD\n  Expenses:Food\n"
    )
    assert LedgerBalances(journal, date(2030, 1, 31)).balance(
        "Assets:Checking:Demo"
    ) == Decimal("-3.00")


# --- extract -----------------------------------------------------------------

OPENS = """\
2030-01-01 open Assets:Checking:Demo
2030-01-01 open Assets:Receivable:Others
2030-01-01 open Assets:Pending-Transfer
"""


def _ledger(tmp_path, month_text):
    tx = tmp_path / "transactions"
    month = tx / "2030-10" / "checking"
    month.mkdir(parents=True)
    bean = month / "Demo.bean"
    bean.write_text(month_text)
    journal = tmp_path / "journal.beancount"
    journal.write_text(OPENS + f'include "{bean}"\n')
    return journal, tx, bean


def _row(desc, amount, when):
    return pending.with_ids([PendingRow(when, desc, Decimal(amount))])[0]


def test_reconcile_books_keeps_carries_and_drops(tmp_path):
    zelle = _row("Zelle Transfer DEMO PERSON", "-27.76", date(2030, 10, 8))
    hold = _row("ACH HOLD DEMO", "-320.00", date(2030, 10, 7))
    stale = _row("OLD HOLD", "-1.00", date(2030, 10, 1))
    month_text = f"""\
2030-10-01 ! "Old Hold" ""
  pending: "{stale.id}"
  Assets:Checking:Demo  -1.00 USD
  Assets:Pending-Transfer

2030-10-07 ! "Ach Hold Demo" "Demo broker deposit" ^demo-link
  pending: "{hold.id}"
  Assets:Checking:Demo  -320.00 USD
  Assets:Pending-Transfer  (160 * 2) USD

2030-10-09 * "Demo DES:Funds" ""
  Assets:Checking:Demo  -320.00 USD
    ref: "20301009123"
  Assets:Receivable:Others

"""
    journal, tx, bean = _ledger(tmp_path, month_text)
    entries, _, _ = loader.load_file(str(journal))
    report = pending.reconcile(
        "checking/Demo",
        [zelle],  # the hold posted, the old hold vanished, the Zelle is new
        entries,
        tx,
        new_refs={"20301009123"},
        categorize=lambda d, a: (d.title(), "Assets:Receivable:Others"),
    )
    text = bean.read_text()
    assert f'pending: "{stale.id}"' not in text
    assert f'pending: "{hold.id}"' not in text
    # The posted row took the pending entry's narration, link and second leg.
    assert '2030-10-09 * "Demo DES:Funds" "Demo broker deposit" ^demo-link' in text
    assert "(160 * 2) USD" in text and 'ref: "20301009123"' in text
    # The new Zelle row is appended as pending, categorized by the importer.
    assert f'pending: "{zelle.id}"' in text
    assert '2030-10-08 ! "Zelle Transfer Demo Person"' in text
    assert any("dropped pending" in line for line in report)
    assert any("carried over" in line for line in report)
    entries, errors, _ = loader.load_file(str(journal))
    assert errors == []

    # A second run with the same snapshot changes nothing.
    before = bean.read_text()
    report = pending.reconcile("checking/Demo", [zelle], entries, tx)
    assert bean.read_text() == before and report == []
