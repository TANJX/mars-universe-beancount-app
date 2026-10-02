"""Guards run on every staged download before it replaces anything.

Guards 1, 3 and 4 are pure functions over file text. Guard 2 runs the real
importer (built exactly as `extract` builds it) on the staged file.

1. BofA placeholder: an export with no posted transactions is "no new rows".
2. Parse: the configured importer must identify the file and extract rows.
3. Overlap: every old row dated inside the new file's date range must still be
   present in the new file, matched the way the importer's `ref:` dedup sees
   rows (by the reference column, with the same date and amount, for importers
   that key on one; byte-identical otherwise). A row already in another file
   under statements/<path>/ (a closed-statement archive) has moved, not gone.
   A uniform day offset across the missing rows is the wrong-timezone signature.
4. Sanity: the new file's latest date is not older than the old file's.
"""

from __future__ import annotations

import csv
from collections import Counter
from collections.abc import Hashable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from beancount_tooling.fetch.config import AccountConfig

BOFA_PLACEHOLDER_TEXT = "has no posted transactions"
DATE_COLUMNS = ("Posted Date", "Date")
DATE_FORMAT = "%m/%d/%Y"
# Rows that are statement furniture rather than transactions. Their date tracks
# the requested range, so they legitimately change between exports.
IGNORED_ROW_PREFIXES = ("Beginning balance as of",)
# Importers whose `ref:` is a per-row id column rather than a hash of the whole
# line. Re-exports fill in other columns on rows already exported (Amex adds
# Address, City/State, Zip Code and Category later), and that cannot duplicate
# anything, so guard 3 matches these rows by the id plus date and amount. A date
# change is still caught: that is the wrong-timezone hazard. Importers not listed
# here hash the line, so any byte change is a new ref and rows match byte for byte.
REF_KEY_COLUMNS = {
    "AmexImporter": "Reference",
    "BofAImporter": "Reference Number",
}
AMOUNT_COLUMN = "Amount"


# ---------------------------------------------------------------------------
# CSV records
# ---------------------------------------------------------------------------


def read_text(path: Path) -> str:
    """Read a statement keeping line terminators exactly as downloaded."""
    return path.read_text(encoding="utf-8", errors="surrogateescape", newline="")


def split_records(text: str) -> list[str]:
    """Split CSV text into raw records, quote-aware, without line terminators.

    A quoted field may contain newlines (Amex Extended Details), so splitting on
    lines would cut one transaction in two.
    """
    records: list[str] = []
    start = 0
    in_quotes = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"':
            in_quotes = not in_quotes
        elif not in_quotes and c in "\r\n":
            records.append(text[start:i])
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            start = i + 1
        i += 1
    if start < n:
        records.append(text[start:])
    return records


def _fields(raw: str) -> list[str]:
    rows = list(csv.reader([raw]))
    return rows[0] if rows else []


@dataclass(frozen=True)
class Row:
    raw: str
    fields: tuple[str, ...]
    date: date


@dataclass
class Table:
    header: tuple[str, ...] = ()
    date_index: int | None = None
    rows: list[Row] = field(default_factory=list)

    @property
    def dates(self) -> list[date]:
        return [r.date for r in self.rows]

    @property
    def first_date(self) -> date | None:
        return min(self.dates) if self.rows else None

    @property
    def last_date(self) -> date | None:
        return max(self.dates) if self.rows else None


def _parse_date(value: str) -> date | None:
    try:
        return datetime.strptime(value.strip(), DATE_FORMAT).date()  # noqa: DTZ007 (date only)
    except ValueError:
        return None


def parse_table(text: str) -> Table:
    """Find the transaction table (the first record with a date column) and its rows."""
    table = Table()
    for raw in split_records(text):
        if not raw.strip():
            continue
        cells = _fields(raw)
        if table.date_index is None:
            header = tuple(c.lstrip("﻿").strip() for c in cells)
            for col in DATE_COLUMNS:
                if col in header:
                    table.header = header
                    table.date_index = header.index(col)
                    break
            continue
        if table.date_index >= len(cells):
            continue
        d = _parse_date(cells[table.date_index])
        if d is None:
            continue
        if any(c.startswith(IGNORED_ROW_PREFIXES) for c in cells):
            continue
        table.rows.append(Row(raw=raw, fields=tuple(cells), date=d))
    return table


# ---------------------------------------------------------------------------
# Guard 1: BofA placeholder
# ---------------------------------------------------------------------------


def is_bofa_placeholder(text: str, kind: str) -> bool:
    """True if a BofA export is the "no posted transactions" placeholder.

    For checking, a file with no blank separator line between the summary and
    the table is also a placeholder (BofACheckingImporter cannot split it).
    """
    if BOFA_PLACEHOLDER_TEXT in text:
        return True
    if kind == "checking":
        return not any(not line.strip() for line in text.splitlines())
    return False


# ---------------------------------------------------------------------------
# Guard 2: parse with the real importer
# ---------------------------------------------------------------------------


class _NonInteractiveMerchantMap(dict):
    """Merchant map that knows every payee, so importers never prompt."""

    def __contains__(self, key: object) -> bool:
        return True

    def __missing__(self, key: Any) -> str:
        return "Equity:FIXME"


def build_importer(account: AccountConfig, payment_account: str):
    """Build the importer exactly as `extract` does, minus journal lookups."""
    # Imported lazily: beancount_tooling.extract reads config/extract.yaml at import.
    from beancount_tooling.extract import build_importer as extract_build_importer

    return extract_build_importer(
        account.extract,
        bank_refs={},
        merchant_map=_NonInteractiveMerchantMap(),
        all_accounts=["Equity:FIXME"],
        payment_account=payment_account,
    )


@dataclass(frozen=True)
class ParseResult:
    ok: bool
    entries: int
    message: str = ""


def parse_with_importer(
    staged: Path,
    account: AccountConfig,
    payment_account: str,
    *,
    expect_empty: bool = False,
    importer: Any = None,
) -> ParseResult:
    """Guard 2. The staged file must live under a `<type>/<name>/` directory so
    path-based `identify` sees it the same way it sees statements/<path>/."""
    from beangulp import identify

    try:
        importer = importer or build_importer(account, payment_account)
        if not identify.identify([importer], str(staged)):
            return ParseResult(False, 0, f"importer did not identify {staged.name}")
        entries = importer.extract(str(staged), [])
    except Exception as e:  # noqa: BLE001 (importer bugs must not abort other accounts)
        return ParseResult(False, 0, f"importer failed: {type(e).__name__}: {e}")
    count = len(entries)
    if expect_empty:
        if count != 0:
            return ParseResult(
                False, count, f"expected 0 rows, importer produced {count}"
            )
        return ParseResult(True, 0)
    if count == 0:
        return ParseResult(False, 0, "importer produced 0 rows")
    return ParseResult(True, count)


# ---------------------------------------------------------------------------
# Guard 3: overlap
# ---------------------------------------------------------------------------

OVERLAP_OK = "ok"
OVERLAP_TIMEZONE = "timezone_shift"
OVERLAP_MISSING = "missing"


@dataclass
class OverlapResult:
    status: str
    missing: list[Row] = field(default_factory=list)
    shift_days: int | None = None
    added: int = 0  # new rows not in the old file
    aged_out: int = 0  # old rows dated before the new range
    new_range: tuple[date, date] | None = None

    @property
    def ok(self) -> bool:
        return self.status == OVERLAP_OK


def key_column_for(account: AccountConfig) -> str | None:
    """The id column guard 3 matches on for this account's importer, or None for
    byte-identical matching."""
    return REF_KEY_COLUMNS.get(str(account.extract.get("importer", "")))


class _Signer:
    """How guard 3 identifies a row of one table.

    full(): what must be unchanged for the old row to count as still present.
    dateless(): the same without the date, used to spot a uniform date shift.
    """

    def __init__(self, table: Table, key_column: str | None):
        self.date_index = table.date_index
        header = table.header
        self.key_index = (
            header.index(key_column) if key_column and key_column in header else None
        )
        self.amount_index = (
            header.index(AMOUNT_COLUMN) if AMOUNT_COLUMN in header else None
        )

    @staticmethod
    def _cell(row: Row, index: int | None) -> str:
        if index is None or index >= len(row.fields):
            return ""
        return row.fields[index].strip()

    def _key(self, row: Row) -> str:
        return self._cell(row, self.key_index)

    def full(self, row: Row) -> Hashable:
        key = self._key(row)
        if not key:
            return ("raw", row.raw)
        return ("ref", key, row.date, self._cell(row, self.amount_index))

    def dateless(self, row: Row) -> Hashable:
        key = self._key(row)
        if not key:
            i = self.date_index
            fields = row.fields if i is None else row.fields[:i] + row.fields[i + 1 :]
            return ("raw", fields)
        return ("ref", key, self._cell(row, self.amount_index))


def check_overlap(
    old: Table,
    new: Table,
    *,
    key_column: str | None = None,
    archived: Iterable[Table] = (),
) -> OverlapResult:
    """Guard 3. Multiset comparison of old rows inside the new date range.

    key_column: match rows by this id column (plus date and amount) instead of
        byte for byte; see REF_KEY_COLUMNS.
    archived: other statement files for the same account. An old row found in
        one of them has moved to a closed-statement archive (it counts as aged
        out, not missing): the importer reads every file, so it stays booked.
    """
    if not new.rows:
        return OverlapResult(OVERLAP_OK, aged_out=len(old.rows))
    lo, hi = new.first_date, new.last_date
    old_sig, new_sig = _Signer(old, key_column), _Signer(new, key_column)
    in_range = [r for r in old.rows if lo <= r.date <= hi]
    aged_out = sum(1 for r in old.rows if r.date < lo)

    new_counts = Counter(new_sig.full(r) for r in new.rows)
    remaining = Counter(new_counts)
    missing: list[Row] = []
    for r in in_range:
        sig = old_sig.full(r)
        if remaining[sig] > 0:
            remaining[sig] -= 1
        else:
            missing.append(r)

    if missing:
        archived_sigs: set[Hashable] = set()
        for table in archived:
            signer = _Signer(table, key_column)
            archived_sigs.update(signer.full(r) for r in table.rows)
        still_missing = [r for r in missing if old_sig.full(r) not in archived_sigs]
        aged_out += len(missing) - len(still_missing)
        missing = still_missing

    old_counts = Counter(old_sig.full(r) for r in old.rows)
    added = sum(max(0, c - old_counts[sig]) for sig, c in new_counts.items())

    result = OverlapResult(
        OVERLAP_OK, added=added, aged_out=aged_out, new_range=(lo, hi)
    )
    if not missing:
        return result

    result.missing = missing
    result.status = OVERLAP_MISSING
    shift = _uniform_shift(missing, old_sig, new, new_sig, remaining)
    if shift is not None:
        result.status = OVERLAP_TIMEZONE
        result.shift_days = shift
    return result


def _uniform_shift(
    missing: list[Row],
    old_sig: _Signer,
    new: Table,
    new_sig: _Signer,
    unmatched_new: Counter,
) -> int | None:
    """If every missing row reappears in the new file with only its date moved by
    the same non-zero number of days, return that offset."""
    if old_sig.date_index is None or new_sig.date_index is None:
        return None
    candidates: dict[Hashable, list[Row]] = {}
    for r in new.rows:
        if unmatched_new[new_sig.full(r)] > 0:
            candidates.setdefault(new_sig.dateless(r), []).append(r)
    common: set[int] | None = None
    for m in missing:
        offsets = {
            (c.date - m.date).days for c in candidates.get(old_sig.dateless(m), [])
        }
        offsets.discard(0)
        common = offsets if common is None else common & offsets
        if not common:
            return None
    return min(common, key=abs) if common else None


# ---------------------------------------------------------------------------
# Guard 4: sanity
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SanityResult:
    ok: bool
    old_latest: date | None
    new_latest: date | None
    message: str = ""


def check_latest_date(old: Table, new: Table) -> SanityResult:
    """Guard 4. Catches a previous-period export landing in the rolling slot."""
    old_latest, new_latest = old.last_date, new.last_date
    if old_latest is None:
        return SanityResult(True, old_latest, new_latest)
    if new_latest is None:
        return SanityResult(False, old_latest, new_latest, "new file has no dated rows")
    if new_latest < old_latest:
        return SanityResult(
            False,
            old_latest,
            new_latest,
            f"new file ends {new_latest:%m/%d/%Y}, before the existing "
            f"file's {old_latest:%m/%d/%Y}",
        )
    return SanityResult(True, old_latest, new_latest)
