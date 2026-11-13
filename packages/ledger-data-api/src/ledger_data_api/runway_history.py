"""Actual month-end balances and monthly flows for the /runway chart's history.

The runway page projects forward from today; this module looks back. For each
of the last N months before the plan starts, it reads the ledger as of that
month's end (priced at that date) and sorts every position into sleeves with
the person's own `starting` rules, the same mapping runway.py uses for today's
starting balances. Only people whose starting balances come from the ledger
(`starting.source: ledger`) have history; a person with typed-in balances gets
`available: false` and a reason.

Flows per month (heuristics, documented in the payload contract):
  takeHome  in each transaction with an `Income:` posting and no lot with a
            cost basis (trades book gains to Income too), the postings into
            accounts of the cash sleeves (checking, ef, reserve).
  spending  `Expenses:` postings in transactions with no `Income:` posting
            (payroll withholding sits in the paycheck transaction).
  deposits  per transaction, for ira / k401 / hsa, the positive net weight of
            postings into that sleeve when the transaction also touches
            accounts outside it.
"""

from __future__ import annotations

import datetime
import re
from typing import Any

from beancount.core import convert, data

from . import runway
from .fire import _query, _usd

CASH = ("checking", "ef", "reserve")
DEPOSIT_SLEEVES = ("ira", "k401", "hsa")
MAX_MONTHS = 36


def _positions_at(ledger, entries, asof: datetime.date) -> list[tuple[str, str, float]]:
    """(account, currency, USD market value at `asof` prices) at `asof`."""
    d = asof.isoformat()
    rows = _query(
        ledger,
        entries,
        f"SELECT account, currency, convert(value(sum(position), {d}), 'USD', {d}) AS usd "
        f"WHERE account ~ '^(Assets|Liabilities)' AND date <= {d} "
        "GROUP BY account, currency",
    )
    out = []
    for account, currency, inv in rows:
        usd = float(_usd(inv))
        if abs(usd) >= 0.005:
            out.append((str(account), str(currency), usd))
    return out


class _Classifier:
    """First-match sleeve for an account name, cached."""

    def __init__(self, rules: list[tuple[str, re.Pattern]], cards, loans):
        self.rules = rules
        self.cards = cards
        self.loans = loans
        self._cache: dict[str, str | None] = {}

    def __call__(self, account: str) -> str | None:
        if account not in self._cache:
            sleeve = None
            if not ((self.cards and self.cards.search(account)) or (self.loans and self.loans.search(account))):
                sleeve = next((s for s, p in self.rules if p.search(account)), None)
            self._cache[account] = sleeve
        return self._cache[account]


def _weight_usd(posting: data.Posting) -> float:
    w = convert.get_weight(posting)
    return float(w.number) if w.currency == "USD" and w.number is not None else 0.0


def _flows(entries, classify: _Classifier, months: list[str]) -> dict[str, dict]:
    want = set(months)
    out = {
        m: {"takeHome": 0.0, "spending": 0.0, "deposits": {k: 0.0 for k in DEPOSIT_SLEEVES}}
        for m in months
    }
    for e in entries:
        if not isinstance(e, data.Transaction):
            continue
        m = e.date.strftime("%Y-%m")
        if m not in want:
            continue
        row = out[m]
        has_income = any(p.account.startswith("Income:") for p in e.postings)
        # A trade (any lot with a cost basis) books its gain to Income too, but
        # moving money between holdings is not pay.
        is_pay = has_income and not any(p.cost is not None for p in e.postings)
        by_sleeve: dict[str | None, float] = {}
        for p in e.postings:
            usd = _weight_usd(p)
            if p.account.startswith("Expenses:") and not has_income:
                row["spending"] += usd
            sleeve = classify(p.account) if p.account.startswith("Assets:") else None
            by_sleeve[sleeve] = by_sleeve.get(sleeve, 0.0) + usd
            if is_pay and sleeve in CASH:
                row["takeHome"] += usd
        sleeves_touched = {classify(p.account) if p.account.startswith("Assets:") else None for p in e.postings}
        for s in DEPOSIT_SLEEVES:
            if s in sleeves_touched and len(sleeves_touched) > 1 and by_sleeve.get(s, 0.0) > 0:
                row["deposits"][s] += by_sleeve[s]
    return out


def _people(raw: dict, root) -> list[tuple[str, dict | None, str | None]]:
    """(id, merged person mapping or None, reason) per configured person."""
    out = []
    for i, entry in enumerate(raw.get("people") or []):
        if not isinstance(entry, dict):
            continue
        inline = dict(entry)
        include = inline.pop("include", None) or inline.pop("file", None)
        merged = inline
        if include is not None:
            data_, message, _status = runway.resolve_include(root, include)
            if data_ is None:
                pid = inline.get("id") if isinstance(inline.get("id"), str) else f"person-{i + 1}"
                out.append((pid, None, message))
                continue
            merged = runway._deep_merge(data_, inline)
        pid = merged.get("id")
        if isinstance(pid, str) and pid:
            out.append((pid, merged, None))
    return out


def build_history(*, ledger, entries, ledger_file_path: str, today: datetime.date, months: int) -> dict:
    """The `runway_history` payload (see the module docstring)."""
    months = max(1, min(MAX_MONTHS, int(months)))
    current = runway.build_runway_data(
        ledger=ledger, entries=entries, ledger_file_path=ledger_file_path, today=today
    )
    start = current["start"]
    span = [runway._add_months(start, k - months) for k in range(months)]
    raw, _ = runway.read_raw_config(runway.runway_config_path(ledger_file_path))
    root = runway.ledger_root(ledger_file_path)
    positions: dict[str, list] = {}

    people: list[dict] = []
    errors: list[dict] = []
    for pid, merged, reason in _people(raw, root):
        none = {"id": pid, "available": False, "rows": [], "unmappedAccounts": []}
        if merged is None:
            people.append({**none, "reason": reason or "the person's file could not be read"})
            continue
        label = str(merged.get("label") or pid)
        starting = merged.get("starting") if isinstance(merged.get("starting"), dict) else {}
        if starting.get("source") != "ledger":
            people.append(
                {**none, "reason": f"{label}'s balances are typed into the runway file, not read from the ledger"}
            )
            continue
        try:
            rules = [
                (str(r.get("sleeve")), re.compile(str(r.get("accounts") or "")))
                for r in starting.get("rules") or []
                if isinstance(r, dict) and r.get("sleeve") in runway.SLEEVES
            ]
            cards = re.compile(str(starting["cards"])) if starting.get("cards") else None
            loans = re.compile(str(starting["loans"])) if starting.get("loans") else None
        except re.error as ex:
            errors.append({"personId": pid, "path": "starting.rules", "message": f"bad regex: {ex}"})
            people.append({**none, "reason": "a sleeve rule is not a valid pattern"})
            continue
        classify = _Classifier(rules, cards, loans)
        flows = _flows(entries, classify, span)
        rows: list[dict[str, Any]] = []
        unmapped_accounts: set[str] = set()
        for m in span:
            if m not in positions:
                positions[m] = _positions_at(ledger, entries, runway._month_end(m))
            mapped = runway.map_sleeves(rules, cards, loans, positions[m])
            unmapped_accounts.update(u["account"] for u in mapped["unmapped"])
            sleeves = mapped["sleeves"]
            f = flows[m]
            take_home = round(f["takeHome"], 2)
            spending = round(f["spending"], 2)
            rows.append(
                {
                    "month": m,
                    "sleeves": sleeves,
                    "cards": mapped["cards"],
                    "loans": mapped["loans"],
                    "netWorth": round(sum(sleeves.values()) - mapped["cards"] - mapped["loans"], 2),
                    "takeHome": take_home,
                    "spending": spending,
                    "net": round(take_home - spending, 2),
                    "deposits": {k: round(v, 2) for k, v in f["deposits"].items()},
                    "unmapped": round(sum(u["usd"] for u in mapped["unmapped"]), 2),
                }
            )
        people.append(
            {
                "id": pid,
                "available": True,
                "reason": None,
                "rows": rows,
                "unmappedAccounts": sorted(unmapped_accounts),
            }
        )
    return {
        "asof": current["asof"],
        "start": start,
        "months": span,
        "version": current["version"],
        "people": people,
        "errors": errors,
    }
