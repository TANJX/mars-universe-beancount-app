#!/usr/bin/env python3
"""Generate the demo ledger's transactions/ tree.

Reads the demo repo's config/forecast.yaml for recurring templates, then
fills in one-off transactions (groceries, restaurants, coffee, transit,
rideshare, shopping, occasional VTI buys) from a baked-in pattern table.

Idempotent: deletes and rewrites only `journal/transactions/`. Hand-authored
files (accounts.bean, config/, journal/plan/*) are left alone.

Usage:
    uv run python scripts/generate-demo-ledger.py \
        --out ../mars-universe-beancount-demo \
        [--anchor 2026-05-02] [--seed 42] \
        [--months-back 6] [--months-fwd 3]
"""

from __future__ import annotations

import argparse
import calendar
import random
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import yaml


# ────────────────────────────────────────────────────────────────────────
# Pattern table — one-off transactions drawn at random within each month.
# Rates are "events per month"; amounts are uniform within the given range.
# ────────────────────────────────────────────────────────────────────────

@dataclass
class Pattern:
    payee: str
    expense_account: str
    funding_account: str
    amount_range: tuple[float, float]
    monthly_rate_range: tuple[int, int]
    narration: str = ""


PATTERNS: list[Pattern] = [
    Pattern("Trader Joes", "Expenses:Food:Groceries", "Liabilities:Credit:Visa", (28.0, 95.0), (3, 5)),
    Pattern("Whole Foods", "Expenses:Food:Groceries", "Liabilities:Credit:Visa", (45.0, 130.0), (1, 3)),
    Pattern("Costco", "Expenses:Food:Groceries", "Liabilities:Credit:Visa", (110.0, 240.0), (0, 2)),
    Pattern("Starbucks", "Expenses:Food:Coffee", "Liabilities:Credit:Visa", (4.5, 9.5), (3, 8)),
    Pattern("Blue Bottle Coffee", "Expenses:Food:Coffee", "Liabilities:Credit:Visa", (5.0, 12.0), (1, 4)),
    Pattern("Doordash", "Expenses:Food:Restaurants", "Liabilities:Credit:Visa", (18.0, 42.0), (1, 4)),
    Pattern("Grubhub", "Expenses:Food:Restaurants", "Liabilities:Credit:Visa", (15.0, 38.0), (1, 3)),
    Pattern("Cafe Mogador", "Expenses:Food:Restaurants", "Liabilities:Credit:Visa", (28.0, 65.0), (0, 2)),
    Pattern("Joe's Pizza", "Expenses:Food:Restaurants", "Liabilities:Credit:Visa", (12.0, 28.0), (1, 3)),
    Pattern("MTA", "Expenses:Transportation:Public", "Liabilities:Credit:Visa", (2.9, 2.9), (8, 14)),
    Pattern("NJ Transit", "Expenses:Transportation:Public", "Liabilities:Credit:Visa", (5.5, 18.0), (0, 2)),
    Pattern("Uber", "Expenses:Transportation:Rideshare", "Liabilities:Credit:Visa", (12.0, 38.0), (1, 4)),
    Pattern("Lyft", "Expenses:Transportation:Rideshare", "Liabilities:Credit:Visa", (10.0, 32.0), (0, 2)),
    Pattern("Amazon", "Expenses:Shopping", "Liabilities:Credit:Visa", (12.0, 95.0), (1, 4)),
    Pattern("CVS", "Expenses:Healthcare", "Liabilities:Credit:Visa", (8.0, 35.0), (0, 2)),
]


# ────────────────────────────────────────────────────────────────────────
# Date helpers
# ────────────────────────────────────────────────────────────────────────

def first_of_month(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, n: int) -> date:
    """Return the first-of-month n months from d (n may be negative)."""
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    return date(y, m, 1)


def month_range(anchor: date, months_back: int, months_fwd: int) -> list[date]:
    """List of first-of-month dates spanning the window, oldest first."""
    start = add_months(first_of_month(anchor), -months_back)
    end = add_months(first_of_month(anchor), months_fwd)
    out: list[date] = []
    cur = start
    while cur <= end:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def resolve_template_date(spec, year: int, month: int) -> date:
    """Resolve a forecast.yaml-style date spec to a concrete date.

    Supports: int day-of-month, "weekday:N" (last weekday on or before day
    N — N may be negative, where -1 means last day of month).
    """
    if isinstance(spec, int):
        day = max(1, min(spec, days_in_month(year, month)))
        return date(year, month, day)
    if isinstance(spec, str) and spec.startswith("weekday:"):
        n = int(spec.split(":", 1)[1])
        if n < 0:
            n = days_in_month(year, month) + 1 + n  # -1 → last day
        n = max(1, min(n, days_in_month(year, month)))
        d = date(year, month, n)
        # Walk backward to the previous weekday if d falls on a weekend.
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        return d
    raise ValueError(f"Unsupported date spec: {spec!r}")


# ────────────────────────────────────────────────────────────────────────
# Transaction model — minimal, just enough to render to .bean text.
# ────────────────────────────────────────────────────────────────────────

@dataclass
class Posting:
    account: str
    amount: float | None  # None = residual
    currency: str = "USD"
    cost: tuple[float, str] | None = None  # (price, currency) for lots


@dataclass
class Txn:
    d: date
    flag: str
    payee: str
    narration: str
    postings: list[Posting]
    tid: str | None = None
    file: str = ""  # repo-relative path under journal/

    def render(self) -> str:
        lines = [f'{self.d.isoformat()} {self.flag} "{self.payee}" "{self.narration}"']
        for i, p in enumerate(self.postings):
            if p.amount is None:
                lines.append(f"  {p.account}")
            elif p.cost is not None:
                price, ccy = p.cost
                lines.append(
                    f"  {p.account:40s}{p.amount:>14.4f} {p.currency} "
                    f"{{{price:.2f} {ccy}}}"
                )
            else:
                lines.append(f"  {p.account:40s}{p.amount:>14.2f} {p.currency}")
            if i == 0 and self.tid:
                lines.append(f'    tid: "{self.tid}"')
        return "\n".join(lines) + "\n"


# ────────────────────────────────────────────────────────────────────────
# Generator
# ────────────────────────────────────────────────────────────────────────

@dataclass
class Forecast:
    salary: dict
    custom_templates: list[dict]
    accounts: dict
    flag: str

    @classmethod
    def load(cls, path: Path) -> "Forecast":
        with path.open() as f:
            data = yaml.safe_load(f)
        return cls(
            salary=data["defaults"]["salary"],
            custom_templates=data.get("custom_templates", []),
            accounts=data.get("accounts", {}),
            flag=data["forecast"].get("transaction_flag", "*"),
        )


def emit_recurring(month_start: date, fc: Forecast, flag: str, ctx: dict) -> list[Txn]:
    """Salary + every custom_template, fired once per month at the resolved date."""
    txns: list[Txn] = []
    y, m = month_start.year, month_start.month

    for payment in fc.salary["payments"]:
        d = resolve_template_date(payment["date"], y, m)
        postings: list[Posting] = []
        total = 0.0
        for alias, amt in payment["distribution"].items():
            acc = fc.accounts[alias]["beancount_account"]
            postings.append(Posting(acc, amt))
            total += amt
        postings.append(Posting(payment["income_account"], -total))
        # Salary lands in the checking account; output file = first
        # distribution's account file.
        first_alias = next(iter(payment["distribution"]))
        file = fc.accounts[first_alias]["file"].format(year=y, month=f"{m:02d}")
        txns.append(Txn(
            d=d, flag=flag, payee=payment["payee"],
            narration=payment.get("narration", ""),
            postings=postings,
            tid=f'{payment["id"]}:{y}-{m:02d}',
            file=file,
        ))

    for tpl in fc.custom_templates:
        d = resolve_template_date(tpl["date"], y, m)
        postings = [Posting(p["account"], p["amount"]) for p in tpl["postings"]]
        # cc_autopay is special — fill the residual with the prior month's
        # Visa total tracked on ctx.
        if tpl["id"] == "cc_autopay":
            prev_total = ctx.get("prev_visa_total", 0.0)
            if prev_total <= 0:
                continue  # no statement to pay yet
            postings = [
                Posting("Liabilities:Credit:Visa", prev_total),
                Posting("Assets:Checking:Acme-Bank", -prev_total),
            ]
        file = fc.accounts[tpl["account"]]["file"].format(year=y, month=f"{m:02d}")
        narration = tpl.get("narration", "").format(year=y, month=f"{m:02d}")
        txns.append(Txn(
            d=d, flag=flag, payee=tpl["payee"], narration=narration,
            postings=postings,
            tid=f'{tpl["id"]}:{y}-{m:02d}',
            file=file,
        ))

    return txns


def emit_random(month_start: date, flag: str, rng: random.Random) -> list[Txn]:
    """Sample one-off transactions across the month from PATTERNS."""
    y, m = month_start.year, month_start.month
    last_day = days_in_month(y, m)
    out: list[Txn] = []

    for i, pat in enumerate(PATTERNS):
        lo, hi = pat.monthly_rate_range
        n = rng.randint(lo, hi)
        for j in range(n):
            day = rng.randint(1, last_day)
            d = date(y, m, day)
            amt = round(rng.uniform(*pat.amount_range), 2)
            postings = [
                Posting(pat.funding_account, -amt),
                Posting(pat.expense_account, amt),
            ]
            file = (
                f"transactions/{y}-{m:02d}/credit/Visa.bean"
                if pat.funding_account.startswith("Liabilities:Credit:Visa")
                else f"transactions/{y}-{m:02d}/checking/Acme-Bank.bean"
            )
            out.append(Txn(
                d=d, flag=flag, payee=pat.payee, narration=pat.narration,
                postings=postings, file=file,
            ))
    return out


def emit_investment(month_start: date, flag: str, rng: random.Random) -> list[Txn]:
    """A bi-monthly VTI buy from brokerage cash — exercises the investment view."""
    y, m = month_start.year, month_start.month
    if m % 2 == 1:  # buy on odd months
        return []
    day = min(20, days_in_month(y, m))
    d = date(y, m, day)
    shares = rng.choice([1, 1, 2])
    price = round(rng.uniform(245.0, 285.0), 2)
    cash_out = round(shares * price, 2)
    postings = [
        Posting("Assets:Investment:Brokerage:VTI", float(shares), "VTI", cost=(price, "USD")),
        Posting("Assets:Investment:Brokerage:Cash", -cash_out),
    ]
    file = f"transactions/{y}-{m:02d}/investment/Brokerage.bean"
    return [Txn(d=d, flag=flag, payee="Vanguard", narration=f"Buy {shares} VTI",
                postings=postings, file=file)]


def emit_brokerage_funding(month_start: date, flag: str) -> list[Txn]:
    """A small, fixed monthly transfer from checking → brokerage cash, so VTI
    buys don't drive the cash account negative."""
    y, m = month_start.year, month_start.month
    if m % 2 == 1:
        return []
    d = date(y, m, min(18, days_in_month(y, m)))
    postings = [
        Posting("Assets:Investment:Brokerage:Cash", 600.00),
        Posting("Assets:Checking:Acme-Bank", -600.00),
    ]
    return [Txn(d=d, flag=flag, payee="Vanguard", narration="Brokerage funding",
                postings=postings,
                file=f"transactions/{y}-{m:02d}/checking/Acme-Bank.bean")]


def regenerate(out_root: Path, anchor: date, seed: int,
               months_back: int, months_fwd: int) -> None:
    fc = Forecast.load(out_root / "config" / "forecast.yaml")
    txns_dir = out_root / "journal" / "transactions"
    if txns_dir.exists():
        shutil.rmtree(txns_dir)
    txns_dir.mkdir(parents=True)

    rng = random.Random(seed)
    forecast_anchor = first_of_month(anchor)
    months = month_range(anchor, months_back, months_fwd)
    ctx: dict = {"prev_visa_total": 0.0}

    for ms in months:
        # Forecast months (>= anchor month) use `!` flag; historical use `*`.
        flag = "!" if ms >= forecast_anchor else "*"

        month_txns: list[Txn] = []
        month_txns += emit_recurring(ms, fc, flag, ctx)
        month_txns += emit_random(ms, flag, rng)
        month_txns += emit_brokerage_funding(ms, flag)
        month_txns += emit_investment(ms, flag, rng)

        # Compute this month's Visa charges to feed next month's autopay.
        # Charges are postings with negative amount on Liabilities:Credit:Visa
        # (positive = payment, e.g., the autopay we just emitted).
        next_visa = 0.0
        for t in month_txns:
            for p in t.postings:
                if p.account == "Liabilities:Credit:Visa" and p.amount and p.amount < 0:
                    next_visa += -p.amount  # accumulate the absolute charge
        ctx["prev_visa_total"] = round(next_visa, 2)

        write_month(txns_dir.parent, month_txns)


def write_month(journal_dir: Path, txns: list[Txn]) -> None:
    """Group by `file` and write each group as a single sorted .bean file."""
    groups: dict[str, list[Txn]] = defaultdict(list)
    for t in txns:
        groups[t.file].append(t)
    for relpath, group in groups.items():
        group.sort(key=lambda t: (t.d, t.payee))
        path = journal_dir / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        body = "\n".join(t.render() for t in group)
        path.write_text(body)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Regenerate the demo ledger's transactions/")
    ap.add_argument("--out", type=Path, required=True,
                    help="Path to the mars-universe-beancount-demo working tree")
    ap.add_argument("--anchor", type=date.fromisoformat, default=None,
                    help="Anchor date YYYY-MM-DD; window pivots around this month (default: today)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--months-back", type=int, default=6)
    ap.add_argument("--months-fwd", type=int, default=3)
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    anchor = args.anchor or date.today()
    if not (args.out / "config" / "forecast.yaml").exists():
        raise SystemExit(f"forecast.yaml not found under {args.out}")
    regenerate(args.out, anchor, args.seed, args.months_back, args.months_fwd)
    print(f"wrote transactions for {args.months_back} months back + "
          f"{args.months_fwd} months forward of {anchor}")


if __name__ == "__main__":
    main()
