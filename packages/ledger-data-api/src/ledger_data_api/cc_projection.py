"""CC payment projection math.

For each configured CCCardRecord with monthly inputs:
  - cc-locked    = max(0, statementBalance − paidThisCycle)   at next paymentDueDay
  - cc-forecast  = max(0, currentBalance − cc-locked)          one cycle later

`paidThisCycle` is the sum of cleared (`*`) + scheduled (`!`) payment
postings inside the active cycle's window — computed in `merge.py` and
passed in. Netting it out makes the projection reflect partial payments
already made: a $1,492.11 statement with $990.01 already committed shows
as $502.10 due, not the raw statement.

Each projection materializes as one ProjectedPayment on the card's
`fundingAccount`. Per-month allocation across multiple checking accounts is
handled at the Plan layer (CC override dialog), not here — when the user
saves an override for a (card, cycle) pair, the merge step suppresses the
projection for that cycle and the override Plans take over.

Cards with no fundingAccount produce floating projections (no `fundingAccount`
on the result), to be assigned manually by the user.

Date math (next-due, previous-close, etc.) lives in `cc_cycle.py`.

The above is the LEGACY path: a card with no statement records, driven by
cc-cards.json. A card in statement mode (see `cc_statements.py`) projects from
facts instead:
  - cc-locked    for the active closed statement, on its due date:
                 max(0, statementBalance − paid since close), or for a
                 minimum-payment card max(0, minimumPayment − paid since close)
                 when the statement carries a minimum;
  - cc-forecast  for the next (expected) statement, on its predicted due date:
                 the owner's estimatedBalance when set, else
                 max(0, currentBalance − remaining of the active statement).
In the gap after a due date passed and before the next statement closes there
is no cc-locked row, only the forecast.
"""

import datetime
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional

from .cc_cycle import active_cycle, next_cycle
from .cc_statements import CardState
from .models import CCCardRecord


@dataclass
class ProjectedPayment:
    cardAccountPath: str
    displayName: str
    fundingAccount: Optional[str]
    date: str  # YYYY-MM-DD
    amount: str  # negative number string (it's an outflow from the funding account)
    kind: str  # "cc-locked" | "cc-forecast"
    cycleMonth: str  # "YYYY-MM" — the payment cycle this projection belongs to
    # The statement this projection stands for. None for a legacy projection
    # and for a forecast with no expected-statement record yet.
    statementId: Optional[str] = None
    statementKind: str = "legacy"  # "closed" | "expected" | "legacy"


def _safe_decimal(value: Optional[str]) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def project_payments(
    records: dict[str, CCCardRecord],
    display_name_for: dict[str, str],
    today: datetime.date,
    derived_balances: dict[str, Decimal],
    paid_this_cycle: Optional[dict[str, Decimal]] = None,
    *,
    states: Optional[dict[str, CardState]] = None,
) -> list[ProjectedPayment]:
    """Build the next-two-payment projection set for each configured card.

    `derived_balances[path]` is the live ledger-derived current-balance owed
    on the card (positive number, USD). Always provided by the caller; the
    record itself no longer stores currentBalance.

    `paid_this_cycle[path]` is the sum of cleared+scheduled payment postings
    inside the active cycle window (see `merge.compute_paid_this_cycle`).
    `cc-locked = max(0, statementBalance − paidThisCycle)`. Defaults to 0
    per card when omitted (preserves callers that haven't been updated yet).

    `states[path]` (see `cc_statements.card_state`) switches a card with
    closed statements to the statement-mode math; such a card needs no
    cc-cards.json record. Cards without statements run the legacy body.
    """
    out: list[ProjectedPayment] = []
    paid_this_cycle = paid_this_cycle or {}
    states = states or {}
    statement_paths = [p for p, s in states.items() if s.has_statements]
    for path in statement_paths:
        rec = records.get(path) or CCCardRecord(accountPath=path)
        out.extend(
            _project_statement_card(
                rec,
                states[path],
                display_name_for.get(path, path.split(":")[-1]),
                today,
                derived_balances.get(path) or Decimal("0"),
                paid_this_cycle.get(path, Decimal("0")),
            )
        )
    for path, rec in records.items():
        if path in states and states[path].has_statements:
            continue
        if rec.paymentDueDay is None:
            continue
        # `statementCloseDay` is optional — `cycle_for_due` falls back to a
        # 30-day rolling window when it's not configured. Projection still
        # emits at next due date; only `paidThisCycle` accuracy degrades.
        stmt = _safe_decimal(rec.statementBalance)
        curr = derived_balances.get(path)
        paid = paid_this_cycle.get(path, Decimal("0"))
        display = display_name_for.get(path, path.split(":")[-1])

        last_closed = _parse_iso_date(rec.lastClosedDate)
        active = active_cycle(
            today, rec.statementCloseDay, rec.paymentDueDay, last_closed
        )
        following = next_cycle(active, rec.statementCloseDay, rec.paymentDueDay)

        # Remaining for the active cycle = statement net of payments already
        # committed this cycle. When `remaining == 0` the cycle is effectively
        # done — no `cc-locked` row needs to render.
        remaining = max(Decimal("0"), stmt - paid) if stmt is not None else None

        # Cards on a minimum-payment plan (e.g., 0% APR balance carry) get no
        # forecast row — next month's payment is approximately the same minimum.
        if rec.minimumPaymentOnly:
            forecast_total = None
        elif curr is not None and remaining is not None:
            # Next-cycle accrual = everything currently on the card that
            # isn't this cycle's remaining bill. Equivalently:
            #   currentBalance ≈ statement − paid + spendThisCycle
            #   ⇒ currentBalance − remaining = spendThisCycle
            # which is a lower bound on next cycle's bill (more spend may
            # land before next close).
            forecast_total = max(Decimal("0"), curr - remaining)
        else:
            forecast_total = None

        if remaining is not None and remaining > 0:
            out.append(
                ProjectedPayment(
                    cardAccountPath=path,
                    displayName=display,
                    fundingAccount=rec.fundingAccount,
                    date=active.end.isoformat(),
                    amount=f"-{remaining}",
                    kind="cc-locked",
                    cycleMonth=active.dueMonth,
                )
            )
        if forecast_total is not None and forecast_total > 0:
            out.append(
                ProjectedPayment(
                    cardAccountPath=path,
                    displayName=display,
                    fundingAccount=rec.fundingAccount,
                    date=following.end.isoformat(),
                    amount=f"-{forecast_total}",
                    kind="cc-forecast",
                    cycleMonth=following.dueMonth,
                )
            )
    return out


def _parse_iso_date(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        return None


def card_amounts(
    rec: CCCardRecord, state: CardState, curr: Decimal, paid: Decimal
) -> dict:
    """Statement-mode amounts for one card, computed once for both the
    projection rows and the card payload. Each value is a Decimal or None.

    - remaining: active statement balance net of payments since close.
    - lockedAmount / lockedSource: what the cc-locked row shows. "minimum"
      for a minimum-payment card whose statement carries a minimum (netted by
      payments since close, so the row disappears once it is paid), else
      "balance" (= remaining).
    - computedForecast: ledger forecast of the next statement; None for a
      minimum-payment card. In the gap (no active statement) it is `curr`.
    """
    zero = Decimal("0")
    active = state.active
    remaining = max(zero, Decimal(active.statementBalance) - paid) if active else None
    locked: Optional[Decimal] = remaining
    source: Optional[str] = "balance" if active else None
    if active and rec.minimumPaymentOnly and active.minimumPayment is not None:
        locked = max(zero, Decimal(active.minimumPayment) - paid)
        source = "minimum"
    forecast: Optional[Decimal]
    if rec.minimumPaymentOnly:
        forecast = None
    else:
        forecast = max(zero, curr - (remaining or zero))
    return {
        "remaining": remaining,
        "lockedAmount": locked,
        "lockedSource": source,
        "computedForecast": forecast,
    }


def _project_statement_card(
    rec: CCCardRecord,
    state: CardState,
    display: str,
    today: datetime.date,
    curr: Decimal,
    paid: Decimal,
) -> list[ProjectedPayment]:
    out: list[ProjectedPayment] = []
    amounts = card_amounts(rec, state, curr, paid)

    locked = amounts["lockedAmount"]
    if state.active and state.active_cycle and locked is not None and locked > 0:
        out.append(
            ProjectedPayment(
                cardAccountPath=rec.accountPath,
                displayName=display,
                fundingAccount=rec.fundingAccount,
                date=state.active_cycle.end.isoformat(),
                amount=f"-{locked}",
                kind="cc-locked",
                cycleMonth=state.active_cycle.dueMonth,
                statementId=state.active.id,
                statementKind="closed",
            )
        )

    expected = state.expected
    forecast = amounts["computedForecast"]
    if expected is not None:
        estimate = _safe_decimal(expected.estimatedBalance)
        if estimate is not None:
            forecast = estimate
    if forecast is not None and forecast > 0 and state.next_due is not None:
        # A predicted due date that already passed still drives the row,
        # dated today ("statement expected since" covers the nag).
        out.append(
            ProjectedPayment(
                cardAccountPath=rec.accountPath,
                displayName=display,
                fundingAccount=rec.fundingAccount,
                date=max(state.next_due, today).isoformat(),
                amount=f"-{forecast}",
                kind="cc-forecast",
                cycleMonth=f"{state.next_due.year:04d}-{state.next_due.month:02d}",
                statementId=expected.id if expected is not None else None,
                statementKind="expected",
            )
        )
    return out
