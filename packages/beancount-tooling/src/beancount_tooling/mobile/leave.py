"""The snapshot's ``leave`` section: PTO and sick balances, in days, and where
they go if no more leave is taken.

Read from the ledger directory, never written:

- ``statements/leave/<Provider>.jsonl``: one record per paystub, copied from
  its leave table. ``id`` (the pay date, ``-2`` for a second stub that day),
  ``payDate``, ``periodEnd``, ``unit`` (``"days"`` or ``"hours"``) and
  ``policies.pto`` / ``policies.sick`` with ``balance`` and ``accrued``. The
  last line with an ``id`` wins. A blank cell is ``null``.
- ``statements/leave/policies.json``: the employer's policy limits, optional.
  Used: ``hireDate``; ``policies.pto``: ``accrualPerYear``,
  ``accrualPerYearFrom`` (``[{tenureYears, days}]``), ``balanceCap``;
  ``policies.sick``: ``cycle`` (``"calendar"`` resets every Jan 1),
  ``resetTo``, ``carryoverCap``, ``annualAccrualCap``, ``balanceCap``,
  ``frontloadedFrom`` and ``breakdownAsOf`` (``{date, accrued}``).
- ``journal/leave/taken.jsonl``: one line per day off (``date``, ``type``
  ``pto`` or ``sick``, ``days``).

Plus ``mobile.yaml``'s ``leave`` section: the accrual per weekday. Without
that section, or without a usable stub on or before the as-of date, there is
no ``leave`` section.

The balances are the newest stub's, as of its period end. The projection
walks the days after that one at a time, assuming no leave is taken: every
weekday adds the per-weekday accrual. PTO stops at its balance cap (no
catch-up once it drops below), and at each tenure step the PTO rate becomes
the configured rate times new days per year over current days per year. Sick
accrual stops once the year has accrued ``annualAccrualCap``; on a reset day
the balance becomes ``min(balance, carryoverCap) + resetTo`` and what is above
the carryover lapses. From ``frontloadedFrom`` on, the reset is the year's
whole grant and sick time accrues no more.
"""

from __future__ import annotations

import calendar
import datetime as dt
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from beancount_tooling.mobile.config import Leave

STUBS_RELATIVE = Path("statements") / "leave"
POLICIES_FILENAME = "policies.json"
TAKEN_RELATIVE = Path("journal") / "leave" / "taken.jsonl"

# Weekdays in an average year, for the monthly accrual figure.
WEEKDAYS_PER_YEAR = 261
# How far ahead to look for the day PTO reaches its cap when that is after
# the projection's last point.
CAP_SEARCH_YEARS = 10


@dataclass(frozen=True)
class LeaveFiles:
    """The ledger's leave files, parsed but not interpreted."""

    stubs: list[dict] = field(default_factory=list)
    policies: dict | None = None
    taken: list[dict] = field(default_factory=list)


def _warn(path: Path, problem: str) -> None:
    print(f"warning: {path}: {problem}", file=sys.stderr)


def _jsonl(path: Path) -> list[dict]:
    out = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            _warn(path, f"line {n} skipped: {e}")
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def read_leave(ledger_dir: Path) -> LeaveFiles | None:
    """The leave files under ``ledger_dir``, or None when there are no stubs."""
    folder = ledger_dir / STUBS_RELATIVE
    if not folder.is_dir():
        return None
    stubs: dict[tuple[str, str], dict] = {}
    for path in sorted(folder.glob("*.jsonl")):
        for row in _jsonl(path):
            key = str(row.get("id") or row.get("payDate"))
            stubs[(path.stem, key)] = row  # the last line with an id wins
    if not stubs:
        return None
    policies = None
    pol_path = folder / POLICIES_FILENAME
    if pol_path.is_file():
        try:
            doc = json.loads(pol_path.read_text(encoding="utf-8"))
            policies = doc if isinstance(doc, dict) else None
        except json.JSONDecodeError as e:
            _warn(pol_path, f"ignored: {e}")
    taken_path = ledger_dir / TAKEN_RELATIVE
    taken = _jsonl(taken_path) if taken_path.is_file() else []
    return LeaveFiles(stubs=list(stubs.values()), policies=policies, taken=taken)


# ---- small helpers -----------------------------------------------------------


def _date(v: Any) -> dt.date | None:
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def _number(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _out(x: float) -> int | float:
    """Whole numbers as ints, anything else to 4 places (no rounding for display)."""
    r = round(x, 4)
    return int(r) if r == int(r) else r


def _anniversary(start: dt.date, years: int) -> dt.date:
    y = start.year + years
    return start.replace(
        year=y, day=min(start.day, calendar.monthrange(y, start.month)[1])
    )


def _month_end(d: dt.date) -> bool:
    return (d + dt.timedelta(days=1)).day == 1


# ---- the section ---------------------------------------------------------------


@dataclass(frozen=True)
class _Stub:
    pay_date: dt.date
    period_end: dt.date
    pto: float | None
    sick: float | None
    sick_accrued: float | None


def _stubs(files: LeaveFiles, cfg: Leave, asof: dt.date) -> list[_Stub]:
    out = []
    for r in files.stubs:
        pay = _date(r.get("payDate") or r.get("id"))
        if pay is None or pay > asof:
            continue
        per_day = cfg.hours_per_day if r.get("unit") == "hours" else 1.0
        pol = r.get("policies") if isinstance(r.get("policies"), dict) else {}

        def days(policy: str, key: str, pol=pol, per_day=per_day) -> float | None:
            cell = pol.get(policy)
            v = _number(cell.get(key)) if isinstance(cell, dict) else None
            return None if v is None else v / per_day

        out.append(
            _Stub(
                pay_date=pay,
                period_end=_date(r.get("periodEnd")) or pay,
                pto=days("pto", "balance"),
                sick=days("sick", "balance"),
                sick_accrued=days("sick", "accrued"),
            )
        )
    out.sort(key=lambda s: (s.pay_date, s.period_end))
    return out


def _pto_steps(
    policy: dict, hire: dt.date | None, start: dt.date, rate: float
) -> tuple[list[tuple[dt.date, float, float]], float | None]:
    """Future tenure steps as (date, days per year, per-weekday rate), and the
    days per year earned today."""
    base = _number(policy.get("accrualPerYear"))
    if base is None or base <= 0:
        return [], base
    steps = []
    for tier in policy.get("accrualPerYearFrom") or []:
        if not isinstance(tier, dict):
            continue
        years, per_year = _number(tier.get("tenureYears")), _number(tier.get("days"))
        if hire is None or years is None or per_year is None:
            continue
        steps.append((_anniversary(hire, int(years)), per_year))
    steps.sort()
    current = base
    for d, per_year in steps:
        if d <= start:
            current = per_year
    future = [
        (d, per_year, rate * per_year / current) for d, per_year in steps if d > start
    ]
    return future, current


def _year_sick_accrued(sick: dict, stubs: list[_Stub], start: dt.date) -> float:
    """Sick time accrued so far in ``start``'s calendar year: the policy's own
    breakdown when it is from that year, else the stubs' ``accrued`` cells."""
    breakdown = sick.get("breakdownAsOf")
    if isinstance(breakdown, dict):
        when, accrued = _date(breakdown.get("date")), _number(breakdown.get("accrued"))
        if when is not None and accrued is not None and when.year == start.year:
            return accrued
    return sum(
        s.sick_accrued or 0.0
        for s in stubs
        if s.pay_date.year == start.year and s.period_end <= start
    )


def build_leave(
    cfg: Leave | None, files: LeaveFiles | None, asof: dt.date
) -> dict | None:
    """The ``leave`` section as of ``asof``, or None when there is nothing to show."""
    if cfg is None or files is None:
        return None
    stubs = _stubs(files, cfg, asof)
    usable = [s for s in stubs if s.pto is not None and s.sick is not None]
    if not usable:
        return None
    last = usable[-1]
    start = last.period_end
    pto, sick_bal = last.pto, last.sick

    doc = files.policies or {}
    policies = doc.get("policies") if isinstance(doc.get("policies"), dict) else {}
    p = policies.get("pto") if isinstance(policies.get("pto"), dict) else {}
    s = policies.get("sick") if isinstance(policies.get("sick"), dict) else {}
    hire = _date(doc.get("hireDate"))

    # PTO: cap and tenure steps.
    pto_cap = _number(p.get("balanceCap"))
    steps, _ = _pto_steps(p, hire, start, cfg.pto_per_weekday)

    # Sick: the yearly reset, the yearly accrual cap and the frontloaded switch.
    reset_to = _number(s.get("resetTo"))
    resets = s.get("cycle") == "calendar" and reset_to is not None
    carryover = _number(s.get("carryoverCap")) or 0.0
    sick_cap = _number(s.get("balanceCap"))
    annual_cap = _number(s.get("annualAccrualCap"))
    frontloaded = _date(s.get("frontloadedFrom"))
    year_accrued = _year_sick_accrued(s, stubs, start)
    sick_accrues = cfg.sick_per_weekday > 0 and not (
        frontloaded is not None and frontloaded <= start
    )

    horizon = dt.date(start.year + 1, 12, 31)
    search_end = _anniversary(start, CAP_SEARCH_YEARS)
    rate = cfg.pto_per_weekday
    cap_date = start if pto_cap is not None and pto >= pto_cap else None
    resets_on = dt.date(start.year + 1, 1, 1) if resets else None
    lapses = None
    projection = []
    d = start
    while d < horizon or (cap_date is None and pto_cap is not None and d < search_end):
        d += dt.timedelta(days=1)
        if resets and d.month == 1 and d.day == 1:
            kept = min(sick_bal, carryover)
            if lapses is None:
                lapses = sick_bal - kept
            sick_bal = kept + reset_to
            if sick_cap is not None:
                sick_bal = min(sick_bal, sick_cap)
            year_accrued = 0.0
            if frontloaded is not None and frontloaded <= d:
                sick_accrues = False
        elif d.month == 1 and d.day == 1:
            year_accrued = 0.0
        for when, _, new_rate in steps:
            if when == d:
                rate = new_rate
        if d.weekday() < 5:
            if pto_cap is None or pto < pto_cap:
                pto = pto + rate if pto_cap is None else min(pto_cap, pto + rate)
                if pto_cap is not None and pto >= pto_cap and cap_date is None:
                    cap_date = d
            if sick_accrues:
                add = cfg.sick_per_weekday
                if annual_cap is not None:
                    add = max(0.0, min(add, annual_cap - year_accrued))
                if sick_cap is not None:
                    add = max(0.0, min(add, sick_cap - sick_bal))
                sick_bal += add
                year_accrued += add
        if d <= horizon and _month_end(d):
            projection.append(
                {"date": d.isoformat(), "pto": _out(pto), "sick": _out(sick_bal)}
            )

    history = {}
    for st in usable:
        history[st.pay_date] = {
            "date": st.pay_date.isoformat(),
            "pto": _out(st.pto),
            "sick": _out(st.sick),
        }

    def used(kind: str) -> float:
        total = 0.0
        for t in files.taken:
            day = _date(t.get("date"))
            n = _number(t.get("days"))
            if (
                t.get("type") == kind
                and day
                and n
                and day.year == asof.year
                and day <= asof
            ):
                total += n
        return _out(total)

    first_step = steps[0] if steps else None
    return {
        "asOf": start.isoformat(),
        "unit": "days",
        "lastStub": {
            "date": last.pay_date.isoformat(),
            "periodEnd": last.period_end.isoformat(),
        },
        "pto": {
            "balance": _out(last.pto),
            "accrualPerMonth": _out(cfg.pto_per_weekday * WEEKDAYS_PER_YEAR / 12),
            "balanceCap": None if pto_cap is None else _out(pto_cap),
            "usedThisYear": used("pto"),
            "capDate": cap_date.isoformat() if cap_date else None,
            "rateChange": (
                {
                    "date": first_step[0].isoformat(),
                    "accrualPerYear": _out(first_step[1]),
                }
                if first_step
                else None
            ),
        },
        "sick": {
            "balance": _out(last.sick),
            "usedThisYear": used("sick"),
            "resetsOn": resets_on.isoformat() if resets_on else None,
            "resetTo": None if reset_to is None else _out(reset_to),
            "lapsesOnReset": None if lapses is None else _out(lapses),
        },
        "history": list(history.values()),
        "projection": projection,
    }
