"""Credit-card billing-cycle math.

Pure date arithmetic over `(closeDay, dueDay, lastClosedDate, today)`. No
ledger access. Used by:

- `cc_projection.py` to anchor `cc-locked` / `cc-forecast` projections to a
  cycle's due date.
- `merge.py` to compute `paidThisCycle` per card by querying cleared
  postings inside the cycle's payment-attribution window.
- The CC override modal (via the API payload) to know which cycle a
  payment is being planned against.

A **cycle** is `(start, end, dueMonth)`:

- `start` — the statement-close date that produced the cycle's bill.
- `end`   — the payment-due date the bill is due on.
- `dueMonth` — `"YYYY-MM"` of `end`. Stable identifier.

A **payment** at date `d` is attributed to a cycle if
`cycle.start < d <= cycle.end + grace`. The grace window catches
late-posting payments (autopay settling 1–2 days after dueDay, weekend
rolls, manual ACH lag). Default grace = 3 days; `merge.py`'s plan-vs-
cleared matching uses the same constant so both paths agree.
"""

import calendar
import datetime
from dataclasses import dataclass
from typing import Optional


SETTLEMENT_GRACE_DAYS = 3
"""How many days after `cycle.end` a payment can post and still attribute
to this cycle, and the symmetric window `annotate_past_state` uses to
match a past plan against a cleared txn. One global knob — promote to
per-card config only if a real card pushes past this. Used in:

- `cycle_payment_window` (this module) for `paidThisCycle` summation.
- `annotate_past_state` / `auto_clear_pending` in `merge.py` for plan-vs-
  cleared matching tolerance.
"""


@dataclass(frozen=True)
class Cycle:
    start: datetime.date  # statement close that produced this cycle's bill
    end: datetime.date  # payment due date
    dueMonth: str  # "YYYY-MM" of `end`


def _resolve_day(year: int, month: int, day: int) -> datetime.date:
    """Clamp `day` to the last day of the month if it overshoots.

    `day == -1` is treated as "last day of the month" — same convention
    as the existing config inputs.
    """
    last = calendar.monthrange(year, month)[1]
    if day == -1:
        return datetime.date(year, month, last)
    return datetime.date(year, month, min(max(1, day), last))


def _add_months(d: datetime.date, n: int, target_day: int) -> datetime.date:
    """Shift `d` by `n` months and resolve to `target_day` in the new month."""
    m = d.month + n
    y = d.year
    while m > 12:
        m -= 12
        y += 1
    while m < 1:
        m += 12
        y -= 1
    return _resolve_day(y, m, target_day)


def next_due_date(today: datetime.date, due_day: int) -> datetime.date:
    """The next `paymentDueDay` on or after `today`."""
    candidate = _resolve_day(today.year, today.month, due_day)
    if candidate >= today:
        return candidate
    return _add_months(today, 1, due_day)


DEFAULT_CYCLE_LENGTH_DAYS = 30
"""Fallback cycle length when `statementCloseDay` is not configured. Plan
§6 — "Surface a UI prompt to configure it" is the longer-term ask;
30-day rolling window is the safe default until then."""


def previous_close(cycle_end: datetime.date, close_day: Optional[int]) -> datetime.date:
    """The latest `statementCloseDay` strictly before `cycle_end`.

    Two layouts handled:
    - close 20th, due 15th of next month: cycle_end=5/15 → close=4/20 (prev month)
    - close 5th,  due 25th of same month: cycle_end=5/25 → close=5/5  (same month)

    Falls back to `cycle_end − DEFAULT_CYCLE_LENGTH_DAYS` when `close_day`
    isn't configured. The fallback is a rolling 30-day window — wrong for
    matching exact statement boundaries but right enough that
    `paidThisCycle` captures recent payments.
    """
    if close_day is None:
        return cycle_end - datetime.timedelta(days=DEFAULT_CYCLE_LENGTH_DAYS)
    candidate = _resolve_day(cycle_end.year, cycle_end.month, close_day)
    if candidate < cycle_end:
        return candidate
    return _add_months(cycle_end, -1, close_day)


def cycle_for_due(
    due_date: datetime.date,
    close_day: Optional[int],
    last_closed_date: Optional[datetime.date] = None,
) -> Cycle:
    """Build a Cycle anchored on a known `due_date`.

    `last_closed_date` (if present and strictly before `due_date`) wins
    over arithmetic — it's authoritative when banks shift close dates
    (weekends, product changes). Falls back to `previous_close` otherwise,
    which itself falls back to a 30-day rolling window when `close_day`
    isn't configured.
    """
    if last_closed_date is not None and last_closed_date < due_date:
        start = last_closed_date
    else:
        start = previous_close(due_date, close_day)
    return Cycle(
        start=start,
        end=due_date,
        dueMonth=f"{due_date.year:04d}-{due_date.month:02d}",
    )


def active_cycle(
    today: datetime.date,
    close_day: Optional[int],
    due_day: int,
    last_closed_date: Optional[datetime.date] = None,
) -> Cycle:
    """The cycle the user is currently planning to pay.

    Active = the cycle whose `end` is the next `paymentDueDay >= today`.
    The user's planning horizon flips to the next cycle on the morning
    after dueDay.
    """
    return cycle_for_due(next_due_date(today, due_day), close_day, last_closed_date)


def next_cycle(cycle: Cycle, close_day: Optional[int], due_day: int) -> Cycle:
    """The cycle one month after `cycle` — used for `cc-forecast`."""
    next_end = _add_months(cycle.end, 1, due_day)
    return cycle_for_due(next_end, close_day, last_closed_date=None)


def cycle_payment_window(
    cycle: Cycle,
    today: datetime.date,
    grace_days: int = SETTLEMENT_GRACE_DAYS,
) -> tuple[datetime.date, datetime.date]:
    """Date range to sum cleared payments for `paidThisCycle`.

    Returns `(start_exclusive, end_inclusive)`. The end is capped at
    `today` so we never look into the future, and at `cycle.end + grace`
    so payments after the grace window (which belong to the *next* cycle)
    aren't double-counted here.
    """
    end = min(today, cycle.end + datetime.timedelta(days=grace_days))
    return (cycle.start, end)


# ---------- statement-date predictions ----------

DEFAULT_DUE_OFFSET_DAYS = 25
"""Due date guess for a statement with no due date on file and no usable
`paymentDueDay`: closing date plus this many days."""

STATEMENT_OVERDUE_DAYS = 3
"""Days past the predicted closing date before "statement expected since"
is raised for a card that still has no record for it."""

MIN_NEXT_CLOSE_GAP_DAYS = 14
"""The next close is never predicted sooner than this after the last one, so
a statement that closed a few days off its usual day does not predict the
same month again."""


def valid_day(day) -> bool:
    """A usable day-of-month hint: an int (not bool) that is -1 or 1..31."""
    return (
        isinstance(day, int)
        and not isinstance(day, bool)
        and (day == -1 or 1 <= day <= 31)
    )


def first_day_after(anchor: datetime.date, day: int) -> datetime.date:
    """The first date strictly after `anchor` that is `day` of its month
    (clamped to the month length, -1 meaning the last day)."""
    candidate = _resolve_day(anchor.year, anchor.month, day)
    if candidate > anchor:
        return candidate
    return _add_months(anchor, 1, day)


def predict_due(closing: datetime.date, due_day: Optional[int]) -> datetime.date:
    """Due date for a statement that closed on `closing`."""
    if valid_day(due_day):
        return first_day_after(closing, due_day)
    return closing + datetime.timedelta(days=DEFAULT_DUE_OFFSET_DAYS)


def predict_next_close(
    closed_ids: list[str], close_day: Optional[int]
) -> datetime.date:
    """Closing date of the statement after the newest one in `closed_ids`
    (non-empty, ISO dates): one month after the last real close, on the same
    day of the month, so the prediction follows a card whose closing date
    drifts. The closing-day hint never overrides history; it only settles
    whether a month-end close means "last day of the month" (hint 31 or -1,
    or no hint) or a fixed day such as the 28th.
    """
    last = datetime.date.fromisoformat(max(closed_ids))
    month_end = last.day == calendar.monthrange(last.year, last.month)[1]
    sticky = month_end and (not valid_day(close_day) or close_day in (31, -1))
    return _add_months(last, 1, -1 if sticky else last.day)
