"""Card statement facts: the append-only billing store.

A closed card statement is a durable record identified by (account, id), where
id is the statement closing date. `just fetch` writes one JSON object per line
to statements/billing/credit/<CardName>.jsonl, either from a bank adapter's
read_statement hook (source "fetch") or typed at the terminal prompt (source
"manual"). The store sits outside the account's own statements dir and
`just extract` skips it, so no importer reads it.

Reader rule: the last line per (account, id) wins; a malformed line is ignored
and never replaces an earlier line; a line with "void": true removes the id
until a later valid line re-instates it. Money is a JSON string.

The reader half of this module (Statement, reduce_lines, card_file,
read_statements, read_all) is duplicated in ledger_data_api/billing.py because
the two packages do not depend on each other. Keep the two identical in
semantics; tests/fixtures/billing_vectors.json holds the shared test vectors.
"""

from __future__ import annotations

import calendar
import datetime
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

BILLING_DIR = "billing"
CREDIT_DIR = "credit"
_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# Reader (duplicated in ledger_data_api/billing.py)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Statement:
    account: str
    id: str  # closing date YYYY-MM-DD
    statementBalance: str
    dueDate: str | None
    minimumPayment: str | None
    source: str
    capturedAt: str

    def to_dict(self) -> dict:
        return asdict(self)


def _is_date(v) -> bool:
    if not isinstance(v, str) or not _ID_RE.match(v):
        return False
    try:
        datetime.date.fromisoformat(v)
    except ValueError:
        return False
    return True


def _is_money(v) -> bool:
    if not isinstance(v, str):
        return False
    try:
        return Decimal(v).is_finite()
    except InvalidOperation:
        return False


def reduce_lines(lines: Iterable[str]) -> list[Statement]:
    state: dict[tuple[str, str], Statement | None] = {}
    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(d, dict):
            continue
        account, sid = d.get("account"), d.get("id")
        if not isinstance(account, str) or not account or not _is_date(sid):
            continue
        if d.get("void") is True:
            state[(account, sid)] = None
            continue
        due, minimum = d.get("dueDate"), d.get("minimumPayment")
        if not _is_money(d.get("statementBalance")):
            continue
        if due is not None and not _is_date(due):
            continue
        if minimum is not None and not _is_money(minimum):
            continue
        source, captured = d.get("source"), d.get("capturedAt")
        state[(account, sid)] = Statement(
            account,
            sid,
            d["statementBalance"],
            due,
            minimum,
            source if isinstance(source, str) and source else "manual",
            captured if isinstance(captured, str) else "",
        )
    return sorted(
        (s for s in state.values() if s is not None), key=lambda s: (s.account, s.id)
    )


def card_file(statements_dir: Path, account: str) -> Path:
    return statements_dir / BILLING_DIR / CREDIT_DIR / f"{account.split(':')[-1]}.jsonl"


def _read_file(path: Path) -> list[Statement]:
    try:
        with path.open("r", encoding="utf-8") as f:
            return reduce_lines(f)
    except (OSError, UnicodeDecodeError):
        return []


def read_statements(statements_dir: Path, account: str) -> list[Statement]:
    """The closed (non-void) statements of `account`, ascending by id. Empty
    when the file is missing or unreadable."""
    path = card_file(Path(statements_dir), account)
    return [s for s in _read_file(path) if s.account == account]


def read_all(statements_dir: Path) -> dict[str, list[Statement]]:
    """Every card's closed statements, keyed by account, ascending by id.
    A record is kept only in the file named after its card. Never raises."""
    out: dict[str, list[Statement]] = {}
    root = Path(statements_dir) / BILLING_DIR / CREDIT_DIR
    try:
        paths = sorted(root.glob("*.jsonl"))
    except OSError:
        return out
    for path in paths:
        for s in _read_file(path):
            if s.account.split(":")[-1] == path.stem:
                out.setdefault(s.account, []).append(s)
    return out


# ---------------------------------------------------------------------------
# What an adapter or the prompt produces
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StatementInfo:
    closing_date: date
    statement_balance: Decimal
    due_date: date | None = None
    minimum_payment: Decimal | None = None


def parse_money(text: str) -> Decimal:
    """Site or typed text to a Decimal: "$1,234.56" gives 1234.56, and both
    "(12.00)" and "-12.00" are negative."""
    cleaned = str(text).strip()
    negative = False
    if cleaned.startswith("(") and cleaned.endswith(")"):
        negative, cleaned = True, cleaned[1:-1]
    cleaned = cleaned.replace("$", "").replace(",", "").replace(" ", "")
    if cleaned.startswith("-"):
        negative, cleaned = not negative, cleaned[1:]
    # Only plain digits: Decimal() would also take "1e3", "Infinity" and "1_0".
    if not re.fullmatch(r"\d+(\.\d*)?|\.\d+", cleaned):
        raise ValueError(f"not an amount: {text!r}")
    value = Decimal(cleaned)
    return -value if negative else value


_US_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def parse_date(text: str) -> date:
    """YYYY-MM-DD or M/D/YYYY."""
    cleaned = str(text).strip()
    if _ID_RE.match(cleaned):
        return date.fromisoformat(cleaned)  # ValueError on an impossible date
    m = _US_DATE.match(cleaned)
    if m:
        return date(int(m[3]), int(m[1]), int(m[2]))
    raise ValueError(f"not a date (YYYY-MM-DD or M/D/YYYY): {text!r}")


def parse_info(
    closing: str, balance: str, due: str | None = None, minimum: str | None = None
) -> StatementInfo:
    """Build a StatementInfo from site or typed text. Empty or None `due` and
    `minimum` become None. The ValueError names the field that failed."""

    def field(name, parser, text):
        try:
            return parser(text)
        except ValueError as e:
            raise ValueError(f"{name}: {e}") from None

    return StatementInfo(
        closing_date=field("closing date", parse_date, closing),
        statement_balance=field("statement balance", parse_money, balance),
        due_date=field("due date", parse_date, due) if due and due.strip() else None,
        minimum_payment=(
            field("minimum payment", parse_money, minimum)
            if minimum and minimum.strip()
            else None
        ),
    )


# ---------------------------------------------------------------------------
# Day-of-month cadence hints (statementCloseDay, paymentDueDay)
# ---------------------------------------------------------------------------


def _month_length(year: int, month: int) -> int:
    first_of_next = date(year + month // 12, month % 12 + 1, 1)
    return (first_of_next - timedelta(days=1)).day


def resolve_day(year: int, month: int, day: int) -> date:
    """Day `day` of the month; -1 means the last day, and a day past the end
    of the month clamps to it (31 in a 30-day month gives the 30th)."""
    last = _month_length(year, month)
    return date(year, month, last if day == -1 else min(day, last))


def valid_day(day: object) -> bool:
    return (
        isinstance(day, int)
        and not isinstance(day, bool)
        and (day == -1 or 1 <= day <= 31)
    )


def first_day_after(anchor: date, day: int) -> date:
    """The first date strictly after `anchor` that is day `day` of its month."""
    candidate = resolve_day(anchor.year, anchor.month, day)
    if candidate > anchor:
        return candidate
    year, month = anchor.year + anchor.month // 12, anchor.month % 12 + 1
    return resolve_day(year, month, day)


def last_expected_close(today: date, close_day: int) -> date:
    """The most recent closing date on or before `today`."""
    candidate = resolve_day(today.year, today.month, close_day)
    if candidate <= today:
        return candidate
    year, month = (
        (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    )
    return resolve_day(year, month, close_day)


def next_close_after(last: date, close_day: int | None = None) -> date:
    """The closing date one month after `last`, the newest statement on file,
    on the same day of the month. History leads, so the prediction follows a
    card whose closing date drifts; the closing-day hint only settles whether
    a month-end close means "last day of the month" (hint 31 or -1, or no
    hint) or a fixed day such as the 28th. Same rule as
    ledger_data_api.cc_cycle.predict_next_close."""
    month_end = last.day == calendar.monthrange(last.year, last.month)[1]
    sticky = month_end and (not valid_day(close_day) or close_day in (31, -1))
    year, month = (
        (last.year + 1, 1) if last.month == 12 else (last.year, last.month + 1)
    )
    return resolve_day(year, month, -1 if sticky else last.day)


def predict_due(closing: date, due_day: int | None) -> date | None:
    """The due date the paymentDueDay hint predicts for a statement that
    closed on `closing`. None without a usable hint."""
    if not valid_day(due_day):
        return None
    return first_day_after(closing, due_day)


MANUAL_TOLERANCE_DAYS = 5


def needs_manual_entry(
    statements: Sequence[Statement],
    expected_close: date,
    tolerance_days: int = MANUAL_TOLERANCE_DAYS,
) -> bool:
    """True when no statement closed on or after `expected_close` minus the
    tolerance (banks move a closing date by a few days around weekends)."""
    floor = (expected_close - timedelta(days=tolerance_days)).isoformat()
    return not any(s.id >= floor for s in statements)


# ---------------------------------------------------------------------------
# Guards (pure)
# ---------------------------------------------------------------------------


def check_statement(
    info: StatementInfo, existing: Sequence[Statement], today: date
) -> list[str]:
    """Hard failures for a statement about to be recorded; empty means ok.

    Zero and negative balances pass, and so does a missing due date. Nothing
    here depends on how long ago the last record was: a card can sit unused
    for a year.
    """
    errors: list[str] = []
    closing = info.closing_date
    if closing > today:
        errors.append(f"closing date {closing} is after today ({today})")
    if info.due_date is not None and info.due_date <= closing:
        errors.append(f"due date {info.due_date} is not after closing date {closing}")
    if not info.statement_balance.is_finite():
        errors.append("statement balance is not a number")
    if info.minimum_payment is not None:
        if not info.minimum_payment.is_finite():
            errors.append("minimum payment is not a number")
        elif info.minimum_payment < 0:
            errors.append("minimum payment is negative")
    if existing:
        ids = {s.id for s in existing}
        newest = max(ids)
        if closing.isoformat() not in ids and closing <= date.fromisoformat(newest):
            errors.append(
                f"closing date {closing} is not after the last recorded "
                f"statement {newest}"
            )
    return errors


CYCLE_MIN_DAYS = 25
CYCLE_MAX_DAYS = 35


def statement_notes(info: StatementInfo, existing: Sequence[Statement]) -> list[str]:
    """Soft notes, never failures: an unusual cycle length and a minimum
    payment above the balance."""
    notes: list[str] = []
    closing = info.closing_date.isoformat()
    earlier = [s.id for s in existing if s.id < closing]
    if earlier:
        previous = max(earlier)
        days = (info.closing_date - date.fromisoformat(previous)).days
        if not CYCLE_MIN_DAYS <= days <= CYCLE_MAX_DAYS:
            notes.append(f"cycle of {days} days since {previous}")
    if (
        info.minimum_payment is not None
        and info.minimum_payment.is_finite()
        and info.statement_balance.is_finite()
        and info.minimum_payment > max(info.statement_balance, Decimal(0))
    ):
        notes.append("minimum payment exceeds the statement balance")
    return notes


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------

_CENT = Decimal("0.01")


def now_iso() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")


def _cents(value: Decimal) -> Decimal:
    q = value.quantize(_CENT)
    return q.copy_abs() if q.is_zero() else q  # never "-0.00"


def _money(value: Decimal | None) -> str | None:
    return None if value is None else format(_cents(value), "f")


def _iso(value: date | None) -> str | None:
    return None if value is None else value.isoformat()


def _differences(stmt: Statement, info: StatementInfo) -> list[str]:
    out = []
    pairs = (
        ("statementBalance", stmt.statementBalance, _money(info.statement_balance)),
        ("minimumPayment", stmt.minimumPayment, _money(info.minimum_payment)),
    )
    for name, on_file, read in pairs:
        same = (
            on_file is None and read is None
            if on_file is None or read is None
            else Decimal(on_file) == Decimal(read)
        )
        if not same:
            out.append(f"{name} {on_file or 'none'} on file, {read or 'none'} read")
    if stmt.dueDate != _iso(info.due_date):
        out.append(
            f"dueDate {stmt.dueDate or 'none'} on file, "
            f"{_iso(info.due_date) or 'none'} read"
        )
    return out


def same_facts(stmt: Statement, info: StatementInfo) -> bool:
    """Whether `info` restates `stmt`: Decimal equality on the balance and the
    minimum (to the cent), ISO equality on the due date. source and capturedAt
    are ignored."""
    return not _differences(stmt, info)


def diff_facts(stmt: Statement, info: StatementInfo) -> list[str]:
    """One line per differing fact, e.g.
    "statementBalance 1200.00 on file, 1234.56 read"."""
    return _differences(stmt, info)


@dataclass(frozen=True)
class RecordResult:
    # "appended" | "unchanged" | "conflict" | "corrected" | "rejected" | "voided"
    status: str
    statement_id: str
    errors: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()  # soft notes, plus diff lines on conflict/corrected
    written: bool = False  # False on dry_run, unchanged, conflict, rejected, voided


def voided_ids(statements_dir: Path, account: str) -> set[str]:
    """Statement ids of `account` whose last valid line is a void."""
    try:
        text = card_file(Path(statements_dir), account).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return set()
    out: set[str] = set()
    for raw in text.splitlines():
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(d, dict) or d.get("account") != account:
            continue
        sid = d.get("id")
        if not _is_date(sid):
            continue
        if d.get("void") is True:
            out.add(sid)
        elif reduce_lines([raw]):
            out.discard(sid)
    return out


def _append_line(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lead = ""
    if path.exists() and path.stat().st_size:
        with path.open("rb") as f:
            f.seek(-1, 2)
            if f.read(1) != b"\n":
                lead = "\n"
    with path.open("a", encoding="utf-8") as f:
        f.write(lead + json.dumps(obj) + "\n")


def record_statement(
    statements_dir: Path,
    account: str,
    info: StatementInfo,
    *,
    source: str,
    today: date,
    allow_correction: bool = False,
    dry_run: bool = False,
    captured_at: str | None = None,
) -> RecordResult:
    """Record a closed statement, keeping closed statements immutable.

    No record for the id: append ("appended"). An identical record: nothing
    ("unchanged"). A different record: nothing, and the difference is reported
    ("conflict"), unless `allow_correction` (the terminal prompt), which
    appends so the last line wins ("corrected"). A guard failure never writes
    ("rejected"). A record the owner voided is not brought back by a plain
    read ("voided", nothing written): only `allow_correction` re-instates it.
    `dry_run` returns the same status without writing.
    """
    statements_dir = Path(statements_dir)
    sid = info.closing_date.isoformat()
    existing = read_statements(statements_dir, account)
    errors = check_statement(info, existing, today)
    if errors:
        return RecordResult("rejected", sid, errors=tuple(errors))
    notes = statement_notes(info, existing)
    current = next((s for s in existing if s.id == sid), None)
    if current is None:
        if not allow_correction and sid in voided_ids(statements_dir, account):
            return RecordResult("voided", sid, notes=("voided on file, not written",))
        status = "appended"
    elif same_facts(current, info):
        return RecordResult("unchanged", sid)
    else:
        notes = diff_facts(current, info) + notes
        if not allow_correction:
            return RecordResult("conflict", sid, notes=tuple(notes))
        status = "corrected"
    if not dry_run:
        _append_line(
            card_file(statements_dir, account),
            {
                "account": account,
                "id": sid,
                "statementBalance": _money(info.statement_balance),
                "dueDate": _iso(info.due_date),
                "minimumPayment": _money(info.minimum_payment),
                "source": source,
                "capturedAt": captured_at or now_iso(),
            },
        )
    return RecordResult(status, sid, notes=tuple(notes), written=not dry_run)


def void_statement(
    statements_dir: Path,
    account: str,
    statement_id: str,
    *,
    source: str = "manual",
    captured_at: str | None = None,
) -> None:
    """Append a void line: the statement disappears for readers until a later
    valid line for the same id re-instates it."""
    if not _is_date(statement_id):
        raise ValueError(f"not a statement id (YYYY-MM-DD): {statement_id!r}")
    _append_line(
        card_file(Path(statements_dir), account),
        {
            "account": account,
            "id": statement_id,
            "void": True,
            "source": source,
            "capturedAt": captured_at or now_iso(),
        },
    )
