"""Reader for closed card statements (billing facts).

Facts live at `<LEDGER_DIR>/statements/billing/credit/<CardName>.jsonl`:
one JSON object per line, append-only, written only by the fetch command in
beancount-tooling. This package never writes them.

The two packages do not depend on each other, so this reducer is a copy of
`beancount_tooling.billing` and must stay identical in semantics. Both run the
same vectors (`tests/fixtures/billing_vectors.json`).

Rules: the last line per (account, id) wins; a malformed line is ignored and
never replaces an earlier line; `"void": true` removes the id until a later
valid line re-instates it; money must be a JSON string.
"""

import datetime
import json
import re
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

BILLING_DIR = "billing"
CREDIT_DIR = "credit"
_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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


def reduce_lines(lines) -> list[Statement]:
    state = {}
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
    """Closed statements of one card, ascending by id. [] when the file is
    missing or unreadable."""
    return [
        s
        for s in _read_file(card_file(Path(statements_dir), account))
        if s.account == account
    ]


def read_all(statements_dir: Path) -> dict[str, list[Statement]]:
    """Every card's closed statements, keyed by account, ascending by id.

    A record counts only in the file named after its card (the last segment
    of its account). Accounts with no surviving record are absent. A missing
    directory or an unreadable file is skipped, never raised.
    """
    root = Path(statements_dir) / BILLING_DIR / CREDIT_DIR
    out: dict[str, list[Statement]] = {}
    try:
        paths = sorted(root.glob("*.jsonl"))
    except OSError:
        return out
    for path in paths:
        for s in _read_file(path):
            if s.account.split(":")[-1] != path.stem:
                continue
            out.setdefault(s.account, []).append(s)
    return out
