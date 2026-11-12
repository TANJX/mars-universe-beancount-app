"""The snapshot's ``equity`` section: option grants valued as of one day.

Paper value only. Nothing here touches the ledger or net worth: the grants
come from ``mobile.yaml`` and the section stands on its own.

Vesting: a schedule's tranche ``i`` (1 to ``months``) vests on ``start`` plus
``i`` months, each worth ``shares / months``. Before ``cliff_months`` tranches
have come due nothing is vested; on the cliff date they all vest together.
A grant's vested count is the sum over its schedules, rounded down to a whole
share (fractions carry forward, so the last tranche lands on the full count).

Values are net of strike: ``(price - strike) x shares``, never below zero.
"""

from __future__ import annotations

import calendar
import datetime as dt
from fractions import Fraction
from math import floor
from typing import Any

from beancount_tooling.mobile.config import Equity, EquityGrant, VestingSchedule


def _frac(x: float) -> Fraction:
    return Fraction(str(x))


def _num(x: Fraction | int) -> int | float:
    """Whole numbers as ints, anything else rounded to 4 places."""
    return int(x) if x == int(x) else round(float(x), 4)


def _money(x: Fraction) -> float:
    return round(float(x), 2)


def tranche_date(start: dt.date, i: int) -> dt.date:
    """``start`` plus ``i`` months, the day clamped to the month's length."""
    n = start.year * 12 + start.month - 1 + i
    y, m = n // 12, n % 12 + 1
    return dt.date(y, m, min(start.day, calendar.monthrange(y, m)[1]))


def _schedule_vested(s: VestingSchedule, on: dt.date) -> Fraction:
    due = 0
    for i in range(1, s.months + 1):
        if tranche_date(s.start, i) > on:
            break
        due = i
    if due < s.cliff_months:
        return Fraction(0)
    return _frac(s.shares) * due / s.months


def vested_shares(grant: EquityGrant, on: dt.date) -> int:
    """Whole shares of ``grant`` vested on ``on``."""
    return floor(sum((_schedule_vested(s, on) for s in grant.vesting), Fraction(0)))


def _vest_dates(grant: EquityGrant) -> list[dt.date]:
    return sorted(
        {
            tranche_date(s.start, i)
            for s in grant.vesting
            for i in range(max(s.cliff_months, 1), s.months + 1)
        }
    )


def next_vest(grant: EquityGrant, asof: dt.date) -> tuple[dt.date, int] | None:
    """(date, whole shares) of the first vesting after ``asof``."""
    have = vested_shares(grant, asof)
    for d in _vest_dates(grant):
        if d <= asof:
            continue
        gain = vested_shares(grant, d) - have
        if gain > 0:
            return d, gain
    return None


def fully_vested(grant: EquityGrant) -> dt.date:
    return max(tranche_date(s.start, s.months) for s in grant.vesting)


def _spread(price: float | None, strike: float, shares: Fraction) -> float | None:
    if price is None:
        return None
    return _money(max(_frac(price) - _frac(strike), Fraction(0)) * shares)


def _grant_row(g: EquityGrant, eq: Equity, asof: dt.date) -> dict[str, Any]:
    total = _frac(g.shares)
    exercised = _frac(g.exercised)
    vested = Fraction(vested_shares(g, asof))
    # Exercised shares are no longer options: they leave both value lines.
    exercisable = max(vested - exercised, Fraction(0))
    outstanding = max(total - exercised, Fraction(0))
    nxt = next_vest(g, asof)
    strike = _frac(g.strike)
    return {
        "id": g.id,
        "name": g.name or g.id,
        "type": g.type,
        "grantDate": g.grant_date.isoformat() if g.grant_date else None,
        "expiration": g.expiration.isoformat() if g.expiration else None,
        "shares": _num(total),
        "strike": g.strike,
        "vested": _num(vested),
        "unvested": _num(total - vested),
        "exercised": _num(exercised),
        "exercisable": _num(exercisable),
        "exerciseCost": _money(strike * outstanding),
        "exerciseCostVested": _money(strike * exercisable),
        "vestedValue": _spread(eq.fmv, g.strike, exercisable),
        "totalValue": _spread(eq.fmv, g.strike, outstanding),
        "vestedValuePreferred": _spread(eq.preferred_price, g.strike, exercisable),
        "totalValuePreferred": _spread(eq.preferred_price, g.strike, outstanding),
        "nextVest": (
            {"date": nxt[0].isoformat(), "shares": nxt[1]} if nxt else None
        ),
        "fullyVested": fully_vested(g).isoformat(),
    }


def build_equity(eq: Equity | None, asof: dt.date) -> dict[str, Any] | None:
    """The ``equity`` section, None when no grants are configured."""
    if eq is None:
        return None
    rows = [_grant_row(g, eq, asof) for g in eq.grants]

    def total(key: str) -> Any:
        values = [r[key] for r in rows]
        if any(v is None for v in values):
            return None
        s = sum(values)
        return _num(Fraction(str(s))) if key in COUNTS else round(s, 2)

    upcoming = [(r["nextVest"]["date"], r) for r in rows if r["nextVest"]]
    nxt = None
    if upcoming:
        first = min(d for d, _ in upcoming)
        on_day = [r for d, r in upcoming if d == first]
        nxt = {
            "date": first,
            "shares": sum(r["nextVest"]["shares"] for r in on_day),
            "grants": [
                {"id": r["id"], "shares": r["nextVest"]["shares"]} for r in on_day
            ],
        }
    shares = total("shares")
    vested = total("vested")
    return {
        "company": eq.company,
        "note": eq.note,
        "fmv": eq.fmv,
        "fmvDate": eq.fmv_date.isoformat() if eq.fmv_date else None,
        "preferredPrice": eq.preferred_price,
        **{key: total(key) for key in (*COUNTS, *MONEY)},
        "vestedFraction": round(vested / shares, 4) if shares else 0.0,
        "nextVest": nxt,
        "fullyVested": max(r["fullyVested"] for r in rows),
        "grants": rows,
    }


VEST_LABEL = "Options vest"


def vest_key_date(section: dict[str, Any] | None) -> dict[str, str] | None:
    """The next vest as a key date, None without equity or once fully vested.

    Takes the built ``equity`` section, so the reminder always agrees with
    ``equity.nextVest``. It names the grants vesting that day and the whole
    shares they add; it carries no money, so it moves no cash in the plan.
    """
    nxt = (section or {}).get("nextVest")
    if not nxt:
        return None
    ids = [g["id"] for g in nxt["grants"]]
    names = ids[0] if len(ids) == 1 else ", ".join(ids[:-1]) + " and " + ids[-1]
    shares = nxt["shares"]
    unit = "share" if shares == 1 else "shares"
    return {
        "date": nxt["date"],
        "label": VEST_LABEL,
        "note": f"{names}, +{shares:,} {unit}",
    }


COUNTS = ("shares", "vested", "unvested", "exercised", "exercisable")
MONEY = (
    "exerciseCost",
    "exerciseCostVested",
    "vestedValue",
    "totalValue",
    "vestedValuePreferred",
    "totalValuePreferred",
)
