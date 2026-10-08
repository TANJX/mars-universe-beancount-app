"""Pending checking rows: the fetcher's snapshot and how extract books it.

Checking exports only carry posted rows. `just fetch` reads the rows a site
lists as pending and writes them to statements/pending/<type>/<name>.csv,
replacing the file every run (outside the account's own dir, so no importer
reads it). `just extract` then makes the ledger match that snapshot:

- a row in the snapshot with no `!` entry carrying its `pending:` id is
  appended to the month file's actuals block;
- a booked entry still in the snapshot is left alone, keeping any
  categorization done on it;
- a booked entry gone from the snapshot is removed. When a posted row
  extracted in the same run matches it (same account and amount, posted 0 to
  POSTED_WITHIN_DAYS days later, or slightly earlier), the pending entry's other postings,
  narration and links move onto that row first.
"""

from __future__ import annotations

import csv
import hashlib
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

PENDING_DIR = "pending"
PENDING_META = "pending"
FIELDS = ("date", "description", "amount", "id")
# A posted row matches a pending entry dated up to this many days after it, or
# a few days before (BofA rows with no date carry the fetch date that first saw
# them, which can be later than the posting date).
POSTED_WITHIN_DAYS = 10
POSTED_BEFORE_DAYS = 3
FIXME_ACCOUNTS = ("Equity:FIXME", "Expenses:FIXME")
ACCOUNT_PREFIX = {"checking": "Assets:Checking", "saving": "Assets:Saving"}

# A posting line: indented, starts with an account name ("  Assets:...").
POSTING_LINE = re.compile(r"^\s+[A-Z][\w-]*(:[\w-]+)+(\s|$)")


@dataclass(frozen=True)
class PendingRow:
    date: date
    description: str
    amount: Decimal
    id: str = ""


def snapshot_path(statements_dir: Path, account_path: str) -> Path:
    """statements/pending/<type>/<name>.csv for account path <type>/<name>."""
    return statements_dir / PENDING_DIR / f"{account_path}.csv"


def ledger_account(account_path: str) -> str | None:
    kind, _, name = account_path.partition("/")
    prefix = ACCOUNT_PREFIX.get(kind)
    return f"{prefix}:{name}" if prefix and name else None


def with_ids(rows: Iterable[PendingRow]) -> list[PendingRow]:
    """Give each row an id from its description and amount, not its date
    (BofA shows none, so the fetch date stands in and would change daily).
    Identical rows get -2, -3, ... in listing order."""
    seen: dict[str, int] = {}
    out = []
    for row in rows:
        key = f"{' '.join(row.description.split())}|{row.amount:.2f}"
        base = "p" + hashlib.sha1(key.encode()).hexdigest()[:12]
        seen[base] = seen.get(base, 0) + 1
        suffix = f"-{seen[base]}" if seen[base] > 1 else ""
        out.append(replace(row, id=base + suffix))
    return out


def write_snapshot(path: Path, rows: Sequence[PendingRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(FIELDS)
        for r in with_ids(rows):
            writer.writerow(
                [r.date.isoformat(), r.description, f"{r.amount:.2f}", r.id]
            )
    tmp.replace(path)


def read_snapshot(path: Path) -> list[PendingRow]:
    with path.open(newline="") as f:
        return [
            PendingRow(
                date.fromisoformat(r["date"]),
                r["description"],
                Decimal(r["amount"]),
                r["id"],
            )
            for r in csv.DictReader(f)
        ]


# ---------------------------------------------------------------------------
# Extract side
# ---------------------------------------------------------------------------

# (description, amount) -> (payee, second-leg account) from the importer's
# usual heuristics; the caller falls back to Equity:FIXME.
Categorize = Callable[[str, Decimal], tuple[str, str]]


@dataclass
class _Edit:
    """Replace lines [start, end) of a file (0-based) with `lines`."""

    start: int
    end: int
    lines: list[str]


def _block(lines: list[str], lineno: int) -> tuple[int, int]:
    """[start, end) of the entry whose header is on 1-based `lineno`: up to
    the next blank line."""
    start = lineno - 1
    end = start + 1
    while end < len(lines) and lines[end].strip():
        end += 1
    return start, end


def _second_legs(block: list[str]) -> list[str]:
    """Lines from the second posting on (postings plus their metadata)."""
    idx = [i for i, line in enumerate(block) if POSTING_LINE.match(line)]
    return block[idx[1] :] if len(idx) > 1 else []


def _quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _header(entry, narration: str, links: set[str], tags: set[str]) -> str:
    parts = [entry.date.isoformat(), entry.flag]
    if entry.payee is not None:
        parts.append(_quote(entry.payee))
    parts.append(_quote(narration))
    parts += [f"#{t}" for t in sorted(tags)] + [f"^{k}" for k in sorted(links)]
    return " ".join(parts) + "\n"


def _is_categorized(entry) -> bool:
    return any(p.account not in FIXME_ACCOUNTS for p in entry.postings[1:])


def _pending_entry(row: PendingRow, account: str, categorize: Categorize | None):
    from beancount.core import amount, data, flags

    payee, other = row.description, FIXME_ACCOUNTS[0]
    if categorize is not None:
        try:
            payee, other = categorize(row.description, row.amount)
        except Exception:  # noqa: BLE001 (heuristics are best-effort)
            payee, other = row.description, FIXME_ACCOUNTS[0]
    meta = data.new_metadata("<pending>", 0)
    meta[PENDING_META] = row.id
    return data.Transaction(
        meta=meta,
        date=row.date,
        flag=flags.FLAG_WARNING,
        payee=payee,
        narration="",
        tags=frozenset(),
        links=frozenset(),
        postings=[
            data.Posting(
                account, amount.Amount(row.amount, "USD"), None, None, None, None
            ),
            data.Posting(other, None, None, None, None, None),
        ],
    )


def reconcile(
    account_path: str,
    rows: Sequence[PendingRow],
    entries: Sequence,
    transactions_dir: Path,
    *,
    new_refs: set[str] = frozenset(),
    categorize: Categorize | None = None,
) -> list[str]:
    """Make the ledger's pending entries for one account match `rows`.
    `entries` is the loaded ledger (with this run's posted rows already
    appended); `new_refs` are the refs extracted in this run. Returns report
    lines."""
    from beancount.core import data
    from beancount.parser import printer

    account = ledger_account(account_path)
    if account is None:
        return [f"{account_path}: pending snapshot ignored (not a checking account)"]
    kind, _, name = account_path.partition("/")

    booked = {}
    posted_new = []
    for e in entries:
        if not isinstance(e, data.Transaction) or not e.postings:
            continue
        if e.postings[0].account != account:
            continue
        if PENDING_META in e.meta and e.flag == "!":
            booked[str(e.meta[PENDING_META])] = e
        elif str((e.postings[0].meta or {}).get("ref", "")) in new_refs:
            posted_new.append(e)

    wanted = {r.id: r for r in rows}
    report = []
    edits: dict[str, list[_Edit]] = {}
    file_lines: dict[str, list[str]] = {}

    def lines_of(path: str) -> list[str]:
        if path not in file_lines:
            file_lines[path] = Path(path).read_text().splitlines(keepends=True)
        return file_lines[path]

    used: set[int] = set()
    for pid, entry in sorted(booked.items(), key=lambda kv: kv[1].date):
        if pid in wanted:
            continue
        units = entry.postings[0].units.number
        candidates = [
            e
            for e in posted_new
            if id(e) not in used
            and e.postings[0].units.number == units
            and entry.date - timedelta(days=POSTED_BEFORE_DAYS)
            <= e.date
            <= entry.date + timedelta(days=POSTED_WITHIN_DAYS)
        ]
        candidates.sort(key=lambda e: e.date)
        p_path, p_line = entry.meta["filename"], entry.meta["lineno"]
        p_lines = lines_of(p_path)
        p_start, p_end = _block(p_lines, p_line)
        p_block = p_lines[p_start:p_end]
        # Drop the entry and one blank line after it.
        drop_end = (
            p_end + 1 if p_end < len(p_lines) and not p_lines[p_end].strip() else p_end
        )
        edits.setdefault(p_path, []).append(_Edit(p_start, drop_end, []))
        label = f"{entry.date} {units:,.2f} {entry.payee or entry.narration}"
        if not candidates:
            report.append(
                f"{name}: dropped pending {label} (no posted row in this run)"
            )
            continue
        posted = candidates[0]
        used.add(id(posted))
        if not _is_categorized(entry):
            report.append(f"{name}: pending {label} posted {posted.date}")
            continue
        s_path, s_line = posted.meta["filename"], posted.meta["lineno"]
        s_lines = lines_of(s_path)
        s_start, s_end = _block(s_lines, s_line)
        s_block = s_lines[s_start:s_end]
        legs = _second_legs(p_block)
        keep = s_block[: len(s_block) - len(_second_legs(s_block))]
        header = _header(
            posted,
            posted.narration or entry.narration or "",
            set(posted.links) | set(entry.links),
            set(posted.tags) | set(entry.tags),
        )
        edits.setdefault(s_path, []).append(
            _Edit(s_start, s_end, [header, *keep[1:], *legs])
        )
        report.append(
            f"{name}: pending {label} posted {posted.date}; categorization carried over"
        )

    for path, path_edits in edits.items():
        lines = lines_of(path)
        for edit in sorted(path_edits, key=lambda e: e.start, reverse=True):
            lines[edit.start : edit.end] = edit.lines
        Path(path).write_text("".join(lines))

    new_rows = [r for r in rows if r.id not in booked]
    by_month: dict[str, list[str]] = {}
    for row in new_rows:
        entry = _pending_entry(row, account, categorize)
        by_month.setdefault(row.date.strftime("%Y-%m"), []).append(
            printer.format_entry(entry) + "\n"
        )
        report.append(
            f"{name}: new pending {row.date} {row.amount:,.2f} {row.description}"
        )
    for month, texts in by_month.items():
        target = transactions_dir / month / kind / f"{name}.bean"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a") as f:
            f.writelines(texts)
    return report
