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
"""

import datetime
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional

from .cc_cycle import active_cycle, next_cycle
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
) -> list[ProjectedPayment]:
    """Build the next-two-payment projection set for each configured card.

    `derived_balances[path]` is the live ledger-derived current-balance owed
    on the card (positive number, USD). Always provided by the caller; the
    record itself no longer stores currentBalance.

    `paid_this_cycle[path]` is the sum of cleared+scheduled payment postings
    inside the active cycle window (see `merge.compute_paid_this_cycle`).
    `cc-locked = max(0, statementBalance − paidThisCycle)`. Defaults to 0
    per card when omitted (preserves callers that haven't been updated yet).
    """
    out: list[ProjectedPayment] = []
    paid_this_cycle = paid_this_cycle or {}
    for path, rec in records.items():
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
