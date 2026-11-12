"""Card statements `just fetch` could not read from a bank site: which ones
are missing, and the terminal prompt that records them.

Every card in journal/plan/cc-cards.json (written by the web app, read-only
here) can be asked about, including cards that are not in config/fetch.yaml.
History leads: once a card has a statement on file, the next one is expected
one month after the last real closing date, so the question follows a card
whose closing date drifts. A card with no statement on file falls back to its
statementCloseDay hint; with no hint either it is only asked about by
`fetch --statements-only`, as "enter the most recent statement". Answers are
recorded with source "manual".

No browser, no network: everything takes an injected `today`, `ask` and `out`.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from beancount_tooling import billing
from beancount_tooling.billing import StatementInfo

CC_CARDS_RELATIVE = Path("journal") / "plan" / "cc-cards.json"
CARD_PREFIX = "Liabilities:Credit:"
MAX_TRIES = 3
NO_VALUE = ("none", "-")  # typed at the due date prompt to clear the default


@dataclass(frozen=True)
class CardHint:
    account: str
    close_day: int | None  # only used until the card has a statement on file
    due_day: int | None


def load_card_hints(ledger_dir: Path) -> list[CardHint]:
    """Every card in cc-cards.json with its day hints (None when unset or
    unusable), sorted by account. Read-only; a missing or malformed file
    gives no cards."""
    try:
        raw = json.loads((Path(ledger_dir) / CC_CARDS_RELATIVE).read_text("utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, dict):
        return []
    hints = []
    for account, record in raw.items():
        if not (isinstance(account, str) and account.startswith(CARD_PREFIX)):
            continue
        if not isinstance(record, dict):
            continue
        close_day = record.get("statementCloseDay")
        due_day = record.get("paymentDueDay")
        hints.append(
            CardHint(
                account,
                close_day if billing.valid_day(close_day) else None,
                due_day if billing.valid_day(due_day) else None,
            )
        )
    return sorted(hints, key=lambda h: h.account)


@dataclass(frozen=True)
class PromptCandidate:
    hint: CardHint
    expected_close: date | None  # None: no statement on file and no hint
    predicted_due: date | None

    @property
    def card(self) -> str:
        return self.hint.account.split(":")[-1]


def manual_candidates(
    hints: Sequence[CardHint],
    statements_dir: Path,
    today: date,
    *,
    skip_accounts: Collection[str] = (),
    include_new: bool = False,
) -> list[PromptCandidate]:
    """The cards with a statement that should be out and is not on file.

    With statements on file: the one expected a month after the last real
    close, once that date has arrived (after a long gap this is the oldest
    missing one; the next run asks for the one after it). With none: the most
    recent close the statementCloseDay hint predicts. With neither, only when
    `include_new`: a first-statement candidate with no expected date.
    """
    out = []
    for hint in hints:
        if hint.account in skip_accounts:
            continue
        existing = billing.read_statements(statements_dir, hint.account)
        if existing:
            last = date.fromisoformat(max(s.id for s in existing))
            expected = billing.next_close_after(last, hint.close_day)
            if expected > today:
                continue
        elif hint.close_day is not None:
            expected = billing.last_expected_close(today, hint.close_day)
        elif include_new:
            out.append(PromptCandidate(hint, None, None))
            continue
        else:
            continue
        out.append(
            PromptCandidate(hint, expected, billing.predict_due(expected, hint.due_day))
        )
    return out


def prompts_enabled(no_prompt: bool, stdin: Any = None) -> bool:
    """False under --no-prompt or when stdin is not a terminal, so a scheduled
    or piped run never blocks on a question."""
    if no_prompt:
        return False
    stdin = sys.stdin if stdin is None else stdin
    if stdin is None:
        return False
    try:
        return bool(stdin.isatty())
    except (AttributeError, ValueError):  # no isatty, or a closed stream
        return False


class _Skip(Exception):
    """A field could not be read; the card is skipped."""


def _ask_field(
    ask: Callable[[str], str],
    out: Callable[[str], None],
    prompt: str,
    name: str,
    parse: Callable[[str], Any],
    default: Any,
) -> Any:
    """Ask up to MAX_TRIES times; Enter takes `default`."""
    for _ in range(MAX_TRIES):
        text = ask(prompt).strip()
        if not text:
            return default
        try:
            return parse(text)
        except ValueError as e:
            out(f"  {e}")
    out(f"  skipped: could not read {name}")
    raise _Skip(name)


def _parse_optional_date(text: str) -> date | None:
    return None if text.lower() in NO_VALUE else billing.parse_date(text)


def prompt_statement(
    candidate: PromptCandidate,
    *,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
) -> StatementInfo | None:
    """Ask for one card's statement. None when the balance is left empty, a
    field cannot be read after MAX_TRIES tries, or input ends (EOF)."""
    if candidate.expected_close is None:
        out(f"{candidate.card}: no statement on file, enter the most recent one")
    else:
        out(
            f"{candidate.card}: statement expected to have closed "
            f"{candidate.expected_close}"
        )
    try:
        closing = _ask_field(
            ask,
            out,
            (
                "  Closing date (Enter to skip): "
                if candidate.expected_close is None
                else f"  Closing date [{candidate.expected_close}]: "
            ),
            "closing date",
            billing.parse_date,
            candidate.expected_close,
        )
        if closing is None:
            return None
        balance = _ask_field(
            ask,
            out,
            "  Statement balance (Enter to skip): ",
            "statement balance",
            billing.parse_money,
            None,
        )
        if balance is None:
            return None
        # A typed closing date moves the predicted due date with it.
        predicted_due = (
            candidate.predicted_due
            if closing == candidate.expected_close
            else billing.predict_due(closing, candidate.hint.due_day)
        )
        due = _ask_field(
            ask,
            out,
            f"  Due date [{predicted_due or 'none'}]: ",
            "due date",
            _parse_optional_date,
            predicted_due,
        )
        minimum = _ask_field(
            ask,
            out,
            "  Minimum payment (optional): ",
            "minimum payment",
            billing.parse_money,
            None,
        )
    except (_Skip, EOFError):
        return None
    return StatementInfo(closing, balance, due, minimum)


_STATUS_TEXT = {
    "appended": "recorded",
    "corrected": "corrected",
    "unchanged": "unchanged",
}


def run_manual_prompts(
    candidates: Sequence[PromptCandidate],
    statements_dir: Path,
    today: date,
    *,
    dry_run: bool = False,
    ask: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
) -> list[str]:
    """Prompt for every candidate and record the answers with source
    "manual" (a typed entry may correct an existing record). Returns the
    summary lines. Ctrl-C or the end of input skips the remaining cards."""
    lines: list[str] = []
    stopped = False
    for candidate in candidates:
        card = candidate.card
        if stopped:
            lines.append(f"{card}: skipped")
            continue
        try:
            info = prompt_statement(candidate, ask=ask, out=out)
        except (KeyboardInterrupt, EOFError):
            stopped = True
            out("")
            lines.append(f"{card}: skipped")
            continue
        if info is None:
            lines.append(f"{card}: skipped")
            continue
        try:
            result = billing.record_statement(
                statements_dir,
                candidate.hint.account,
                info,
                source="manual",
                today=today,
                allow_correction=True,
                dry_run=dry_run,
            )
        except OSError as e:
            lines.append(f"{card}: not recorded: {type(e).__name__}: {e}")
            continue
        sid = result.statement_id
        if result.status == "rejected":
            lines.append(f"{card}: not recorded: " + "; ".join(result.errors))
            continue
        text = _STATUS_TEXT[result.status]
        if dry_run and result.status != "unchanged":
            text = f"would be {text}"
        lines.append(f"{card}: statement {sid} {text}")
        lines += [f"  {note}" for note in result.notes]
    return lines
