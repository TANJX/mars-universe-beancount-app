"""Build the mobile snapshot from loaded beancount entries.

The snapshot is one JSON-serialisable dict. Its top-level fields from schema
version 1 (``netWorth``, ``cash``, ``cards``, ``spend``, ``recent``, ...) keep
their names and meanings; version 2 adds ``meta``, ``accounts``, ``activity``
and ``plan``. The field-by-field reference lives with the app that reads it.

Sign conventions, in one place:

- Top-level ``cards`` values, liability groups under ``accounts`` and loan
  balances are amounts owed: positive means you owe, negative means a credit.
- Asset values are what you hold: negative means overdrawn.
- ``spend`` and ``recent`` amounts are spending: positive is money spent.
- ``activity.transactions[].amount`` is the cash effect on the row's account:
  negative is money leaving it (a purchase, a transfer out, a buy inside a
  brokerage account), positive is money arriving (income, a card payment
  landing on the card, a contribution, a sale).
- ``plan.events[].amount`` is the effect on cash: negative is money going out.
"""

from __future__ import annotations

import calendar
import collections
import datetime as dt
from decimal import Decimal
from typing import Any

from beancount.core import data, prices

from beancount_tooling import billing
from beancount_tooling.mobile.config import (
    MEASURE_BALANCE,
    MEASURE_CARD_SPEND,
    MEASURE_CONTRIBUTIONS,
    MobileConfig,
    Goal,
)

SCHEMA_VERSION = 2

# Balances smaller than this are left out of account lists.
TRIVIAL = Decimal("0.5")
# Months of net-worth history, months of spending history.
SERIES_MONTHS = 24
SPEND_MONTHS = 13
RECENT_LIMIT = 40

ZERO = Decimal(0)
BALANCE_SHEET = ("Assets", "Liabilities")

KIND_EXPENSE = "expense"
KIND_INCOME = "income"
KIND_TRANSFER = "transfer"
KIND_CARD_PAYMENT = "card payment"
KIND_INVESTMENT = "investment"
KIND_LOAN_PAYMENT = "loan payment"

GROUPS = (
    # id, name, kind, has a meaningful 30-day change
    ("cash", "Cash", "asset", True),
    ("cards", "Credit cards", "liability", False),
    ("investments", "Investments", "asset", True),
    ("loans", "Loans", "liability", True),
    ("receivables", "Receivables", "asset", False),
    ("payables", "Payables", "liability", False),
    ("other", "Other", "asset", True),
)


def _r2(x: Any) -> float:
    return round(float(x), 2)


def _month_end(y: int, m: int) -> dt.date:
    return dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)


def _add_months(ym: tuple[int, int], n: int) -> tuple[int, int]:
    i = ym[0] * 12 + ym[1] - 1 + n
    return i // 12, i % 12 + 1


def _exp_cat(account: str) -> str:
    parts = account.split(":")
    return parts[1] if len(parts) > 1 else parts[0]


def _label(t: data.Transaction) -> tuple[str, str]:
    """(payee, note): the narration stands in for a missing payee."""
    return (t.payee or t.narration or ""), (t.narration or "" if t.payee else "")


class _Ledger:
    """Transactions, prices and USD balances at the dates the snapshot needs."""

    def __init__(self, entries: list, asof: dt.date):
        self.asof = asof
        self.price_map = prices.build_price_map(entries)
        self.txs = sorted(
            (e for e in entries if isinstance(e, data.Transaction)),
            key=lambda t: t.date,
        )
        self.commodity_names = {
            e.currency: e.meta.get("name")
            for e in entries
            if isinstance(e, data.Commodity) and e.meta.get("name")
        }

        y, m = _add_months((asof.year, asof.month), -SERIES_MONTHS)
        month_ends = []
        while (y, m) < (asof.year, asof.month):
            month_ends.append(_month_end(y, m))
            y, m = _add_months((y, m), 1)
        self.year_start = dt.date(asof.year - 1, 12, 31)
        self.checkpoints = sorted(
            set(month_ends)
            | {asof - dt.timedelta(days=d) for d in (30, 7, 1)}
            | {asof, self.year_start}
        )
        self.series_dates = sorted(
            set(month_ends) | {asof - dt.timedelta(days=d) for d in (30, 7, 1)} | {asof}
        )

        units: dict[str, dict[str, Decimal]] = collections.defaultdict(
            lambda: collections.defaultdict(Decimal)
        )
        self.snaps: dict[dt.date, dict[str, Decimal]] = {}
        self.units_now: dict[str, dict[str, Decimal]] = {}
        ci = 0
        for t in [*self.txs, None]:
            while ci < len(self.checkpoints) and (
                t is None or t.date > self.checkpoints[ci]
            ):
                d = self.checkpoints[ci]
                self.snaps[d] = {
                    a: sum((self.usd(c, n, d) for c, n in inv.items()), ZERO)
                    for a, inv in units.items()
                    if a.startswith(BALANCE_SHEET)
                }
                if d == asof:
                    self.units_now = {
                        a: dict(inv)
                        for a, inv in units.items()
                        if a.startswith(BALANCE_SHEET)
                    }
                ci += 1
            if t is None or t.date > asof:
                break
            for p in t.postings:
                units[p.account][p.units.currency] += p.units.number

        self.now = self.snaps[asof]
        self.past = [t for t in self.txs if t.date <= asof]
        self.future = [t for t in self.txs if t.date > asof]

    def price(self, cur: str, date: dt.date) -> tuple[dt.date | None, Decimal | None]:
        if cur == "USD":
            return None, Decimal(1)
        return prices.get_price(self.price_map, (cur, "USD"), date)

    def usd(self, cur: str, num: Decimal, date: dt.date) -> Decimal:
        if cur == "USD":
            return num
        _, p = self.price(cur, date)
        return num * p if p is not None else ZERO

    def val(self, p: data.Posting, date: dt.date) -> Decimal:
        """Posting value in USD. A USD price on the posting wins over the
        market price (foreign-currency legs booked with their USD cost)."""
        if p.units.currency == "USD":
            return p.units.number
        if p.price is not None and p.price.currency == "USD":
            return p.units.number * p.price.number
        return self.usd(p.units.currency, p.units.number, date)

    def trade_val(self, p: data.Posting, date: dt.date) -> Decimal:
        """Like :meth:`val`, but a lot's USD cost beats the market price."""
        if p.units.currency == "USD":
            return p.units.number
        if p.price is not None and p.price.currency == "USD":
            return p.units.number * p.price.number
        if (
            p.cost is not None
            and p.cost.currency == "USD"
            and p.cost.number is not None
        ):
            return p.units.number * p.cost.number
        return self.usd(p.units.currency, p.units.number, date)

    def total(self, d: dt.date, prefix: tuple[str, ...] | str = BALANCE_SHEET) -> float:
        return float(sum(v for a, v in self.snaps[d].items() if a.startswith(prefix)))

    def balance(self, prefix: str, d: dt.date | None = None) -> Decimal:
        snap = self.now if d is None else self.snaps[d]
        return sum((v for a, v in snap.items() if a.startswith(prefix)), ZERO)


class _Names:
    """Display names: the config's overrides, else the account path made readable."""

    def __init__(self, cfg: MobileConfig):
        self.cfg = cfg

    def display(self, account: str, fallback: str | None = None) -> str:
        if not account:
            return ""
        named = self.cfg.display_names.get(account)
        if named:
            return named
        # "Assets:Gift-Card:*": "{name} gift card" names a whole subtree.
        parts = account.split(":")
        for i in range(len(parts) - 1, 0, -1):
            pattern = self.cfg.display_names.get(":".join(parts[:i]) + ":*")
            if pattern:
                rest = " ".join(parts[i:]).replace("-", " ")
                return pattern.replace("{name}", rest)
        if fallback is None:
            fallback = ":".join(parts[2:]) or parts[-1]
        return fallback.replace("-", " ").replace(":", " ")

    def investment(self, account: str) -> str:
        """Name of the investment account an account path rolls up into."""
        parts = account.split(":")
        for g in self.cfg.investments:
            if account.startswith(g.prefix):
                if g.name is not None:
                    return g.name
                if g.component is not None and len(parts) > g.component:
                    return parts[g.component]
        return parts[2] if len(parts) > 2 else parts[-1]


def _common_prefix(accounts: list[str]) -> str:
    split = [a.split(":") for a in accounts]
    out = []
    for comps in zip(*split):
        if len(set(comps)) != 1:
            break
        out.append(comps[0])
    return ":".join(out)


# ---- accounts ----------------------------------------------------------------


def _group_of(account: str, cfg: MobileConfig) -> str:
    a = cfg.accounts
    for gid, prefixes in (
        ("cards", a.cards),
        ("loans", a.loans),
        ("payables", a.payables),
        ("cash", a.cash),
        ("investments", a.investments),
        ("receivables", a.receivables),
    ):
        if account.startswith(prefixes):
            return gid
    return "other"


def _entry_key(account: str, gid: str, names: _Names) -> tuple[str, str]:
    """(roll-up key, short name) for one ledger account inside its group."""
    parts = account.split(":")
    if gid == "investments":
        name = names.investment(account)
        return name, name
    if gid == "receivables":
        return ":".join(parts[:4]), ":".join(parts[2:4])
    if gid == "other":
        return account, ":".join(parts[1:])
    return ":".join(parts[:3]), ":".join(parts[2:3])


def _due_date(day: int, asof: dt.date) -> dt.date:
    def clamp(y: int, m: int) -> dt.date:
        return dt.date(y, m, min(day, calendar.monthrange(y, m)[1]))

    due = clamp(asof.year, asof.month)
    if due <= asof:
        y, m = _add_months((asof.year, asof.month), 1)
        due = clamp(y, m)
    return due


def _holdings(led: _Ledger, members: list[str]) -> list[dict]:
    units: dict[str, Decimal] = collections.defaultdict(Decimal)
    for a in members:
        for cur, n in led.units_now.get(a, {}).items():
            units[cur] += n
    if set(units) <= {"USD"}:
        return []
    out = []
    for cur, n in units.items():
        value = led.usd(cur, n, led.asof)
        if abs(n) < Decimal("0.00000001") or (
            cur == "USD" and abs(n) < Decimal("0.005")
        ):
            continue
        price_date, price = led.price(cur, led.asof)
        out.append(
            {
                "symbol": cur,
                "name": "Cash" if cur == "USD" else led.commodity_names.get(cur),
                "units": round(float(n), 8),
                "price": None if price is None else round(float(price), 6),
                "priceDate": price_date.isoformat() if price_date else None,
                "value": _r2(value),
            }
        )
    return sorted(out, key=lambda h: -h["value"])


def _card_billing(
    statements: list, day: Any, asof: dt.date
) -> tuple[dt.date | None, float | None] | None:
    """(due date, statement amount) for a card with closed statements on
    record, from the newest one closed on or before ``asof``. None when the
    card has none: the caller then synthesises both from the card settings.

    While that statement's due date has not passed, it gives both (a missing
    due date is predicted from the card's ``paymentDueDay``). Once it has
    passed, nothing is billed until the next statement closes: the due date
    is the next ``paymentDueDay`` and the amount is unknown (None). The typed
    ``statementBalance`` setting is never used for such a card: it stopped
    being maintained when the card got statement records."""
    closed = [s for s in statements if s.id <= asof.isoformat()]
    if not closed:
        return None
    stmt = max(closed, key=lambda s: s.id)
    if stmt.dueDate:
        due = dt.date.fromisoformat(stmt.dueDate)
    else:
        due = billing.predict_due(dt.date.fromisoformat(stmt.id), day)
    if due is not None and due >= asof:
        return due, float(stmt.statementBalance)
    return (_due_date(day, asof) if billing.valid_day(day) else None), None


def _build_accounts(
    led: _Ledger,
    cfg: MobileConfig,
    names: _Names,
    cc_cards: dict,
    statements: dict | None = None,
) -> dict[str, dict]:
    """Every balance-sheet account rolled up into its group, keyed by group id."""
    d30_date = led.asof - dt.timedelta(days=30)
    then = led.snaps[d30_date]
    rolled: dict[str, dict[str, dict]] = {gid: {} for gid, *_ in GROUPS}
    for account in sorted(set(led.now) | set(then)):
        gid = _group_of(account, cfg)
        key, name = _entry_key(account, gid, names)
        e = rolled[gid].setdefault(
            key, {"name": name, "members": [], "now": ZERO, "then": ZERO}
        )
        e["members"].append(account)
        e["now"] += led.now.get(account, ZERO)
        e["then"] += then.get(account, ZERO)

    loans = {loan.account: loan for loan in cfg.loans}
    groups: dict[str, dict] = {}
    for gid, gname, kind, has_d30 in GROUPS:
        sign = -1 if kind == "liability" else 1
        rows = []
        for key, e in rolled[gid].items():
            if abs(e["now"]) < TRIVIAL:
                continue
            path = _common_prefix(e["members"]) if gid == "investments" else key
            fallback = e["name"]
            row: dict[str, Any] = {
                "account": path,
                "name": e["name"],
                "displayName": "",
                "value": _r2(sign * e["now"]),
                "d30": _r2(sign * (e["now"] - e["then"])) if has_d30 else None,
                "holdings": _holdings(led, e["members"]),
            }
            if gid == "cash":
                savings = path.startswith(cfg.accounts.savings)
                row["type"] = "savings" if savings else "checking"
                if savings:
                    fallback += " savings"
            elif gid == "cards":
                meta = cc_cards.get(path, {})
                day = meta.get("paymentDueDay")
                funding = meta.get("fundingAccount") or ""
                fact = _card_billing((statements or {}).get(path, ()), day, led.asof)
                if fact:
                    # Statements on record win over the settings.
                    row["due"] = fact[0].isoformat() if fact[0] else None
                    row["statement"] = fact[1]
                    row["fundedBy"] = funding.split(":")[-1]
                    row["fundedByName"] = names.display(funding) if funding else None
                else:
                    row["due"] = _due_date(day, led.asof).isoformat() if day else None
                    row["statement"] = (
                        float(meta.get("statementBalance") or 0) if day else None
                    )
                    row["fundedBy"] = funding.split(":")[-1] if day else None
                    row["fundedByName"] = (
                        names.display(funding) if day and funding else None
                    )
            elif gid == "loans":
                loan = loans.get(path)
                fallback = loan.name if loan else fallback
                row["original"] = loan.original if loan else None
                row["payment"] = loan.payment if loan else None
                row["payoff"] = (
                    loan.payoff.isoformat() if loan and loan.payoff else None
                )
            row["displayName"] = names.display(path, fallback)
            rows.append(row)
        rows.sort(key=lambda r: -abs(r["value"]))
        groups[gid] = {
            "id": gid,
            "name": gname,
            "kind": kind,
            "total": _r2(sum(r["value"] for r in rows)),
            "d30": _r2(sum(r["d30"] for r in rows)) if has_d30 else None,
            "accounts": rows,
        }
    return groups


# ---- spending ----------------------------------------------------------------


def _build_spend(led: _Ledger, cfg: MobileConfig) -> tuple[dict, dict, float, list]:
    """(spend, income, savingsRate3m, per-month spend by category)."""
    asof = led.asof
    monthly: dict = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    daily: dict = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    flex: dict = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    income: dict = collections.defaultdict(Decimal)
    for t in led.past:
        ym = t.date.strftime("%Y-%m")
        for p in t.postings:
            is_expense = p.account.startswith("Expenses")
            if p.units.currency != "USD" and not is_expense:
                continue
            v = led.val(p, t.date)
            if is_expense:
                cat = _exp_cat(p.account)
                monthly[ym][cat] += v
                daily[ym][t.date.day] += v
                if cat not in cfg.day_to_day_exclude:
                    flex[ym][t.date.day] += v
            elif p.account.startswith("Income"):
                income[ym] -= v

    cur = asof.strftime("%Y-%m")
    months = [
        "{:04d}-{:02d}".format(*_add_months((asof.year, asof.month), -i))
        for i in range(SPEND_MONTHS - 1, -1, -1)
    ]
    first = min(monthly, default=cur)
    months = [m for m in months if m >= first]
    prior = [m for m in months if m < cur]
    totals = {m: sum(monthly[m].values(), ZERO) for m in prior}
    # "Usual" is the last 3 complete months that are not outliers (a one-off
    # month at twice the median would drag the comparison).
    usual_months: list[str] = []
    if totals:
        median = sorted(totals.values())[len(totals) // 2]
        usual_months = [m for m in prior if totals[m] < 2 * median][-3:]

    def cum(ym: str, upto: int, src: dict) -> list[int]:
        run, out = ZERO, []
        for d in range(1, upto + 1):
            run += src[ym].get(d, ZERO)
            out.append(round(float(run)))
        return out

    def usual_curve(src: dict) -> list[int]:
        if not usual_months:
            return [0] * 31
        curves = [cum(m, 31, src) for m in usual_months]
        return [round(sum(c) / len(usual_months)) for c in zip(*curves)]

    mtd_curve = cum(cur, asof.day, daily)
    avg_curve = usual_curve(daily)
    flex_mtd = cum(cur, asof.day, flex)
    flex_avg = usual_curve(flex)
    n_usual = max(len(usual_months), 1)
    cats = sorted(monthly[cur].items(), key=lambda kv: -kv[1])

    def day_total(d: dt.date) -> Decimal:
        return daily[d.strftime("%Y-%m")].get(d.day, ZERO)

    spend = {
        "mtd": _r2(sum(monthly[cur].values(), ZERO)),
        "usualByToday": avg_curve[asof.day - 1],
        "usualMonth": avg_curve[-1],
        "flex": {
            "mtd": flex_mtd[-1],
            "usualByToday": flex_avg[asof.day - 1],
            "usualMonth": flex_avg[-1],
            "mtdCurve": flex_mtd,
            "usualCurve": flex_avg,
        },
        "mtdCurve": mtd_curve,
        "usualCurve": avg_curve,
        "categories": [
            {
                "name": k,
                "value": _r2(v),
                "usual": _r2(
                    sum((monthly[m].get(k, ZERO) for m in usual_months), ZERO) / n_usual
                ),
            }
            for k, v in cats
            if v > 0
        ],
        "byMonth": [
            {"month": m, "value": round(float(sum(monthly[m].values(), ZERO)))}
            for m in months
        ],
        "today": _r2(day_total(asof)),
        "last7": [
            _r2(day_total(asof - dt.timedelta(days=i))) for i in range(6, -1, -1)
        ],
    }
    income_out = {
        "mtd": _r2(income[cur]),
        "byMonth": [{"month": m, "value": round(float(income[m]))} for m in months],
    }
    inc3 = sum((income[m] for m in usual_months), ZERO)
    exp3 = sum((totals[m] for m in usual_months), ZERO)
    savings_rate = round(float((inc3 - exp3) / inc3), 3) if inc3 else 0.0
    by_month = [
        {
            "month": m,
            "total": _r2(sum(monthly[m].values(), ZERO)),
            "categories": [
                {"name": k, "value": _r2(v)}
                for k, v in sorted(monthly[m].items(), key=lambda kv: -kv[1])
                if abs(v) >= Decimal("0.005")
            ],
        }
        for m in months
    ]
    return spend, income_out, savings_rate, by_month


# ---- recent, upcoming, activity ----------------------------------------------


def _build_recent(led: _Ledger, cfg: MobileConfig) -> list[dict]:
    paying = cfg.accounts.cards + cfg.accounts.checking + cfg.accounts.paying
    out = []
    for t in reversed(led.past):
        if t.flag != "*":
            continue
        e = [p for p in t.postings if p.account.startswith("Expenses")]
        if not e:
            continue
        amount = sum((led.val(p, t.date) for p in e), ZERO)
        src = next((p.account for p in t.postings if p.account.startswith(paying)), "")
        payee, note = _label(t)
        out.append(
            {
                "date": t.date.isoformat(),
                "payee": payee,
                "note": note,
                "amount": _r2(amount),
                "category": _exp_cat(max(e, key=lambda p: p.units.number).account),
                "account": src.split(":")[-1],
            }
        )
        if len(out) == RECENT_LIMIT:
            break
    return out


def _build_upcoming(led: _Ledger, cfg: MobileConfig, horizon: dt.date) -> list[dict]:
    """Future-dated entries (forecasts) that touch checking or a card."""
    legs_in = cfg.accounts.checking + cfg.accounts.cards
    out = []
    for t in led.future:
        if t.date > horizon:
            continue
        legs = [
            p
            for p in t.postings
            if p.account.startswith(legs_in) and p.units.currency == "USD"
        ]
        if not legs:
            continue
        net = sum((p.units.number for p in legs), ZERO)
        if any(p.account.startswith(cfg.accounts.salary) for p in t.postings):
            kind = "income"
        elif abs(net) < Decimal("0.005"):
            kind = "card payment"
        else:
            kind = "in" if net > 0 else "out"
        amount = net if kind != "card payment" else max(p.units.number for p in legs)
        label, note = _label(t)
        out.append(
            {
                "date": t.date.isoformat(),
                "label": label,
                "note": note,
                "amount": _r2(amount),
                "kind": kind,
                "account": legs[0].account.split(":")[-1],
                "accountPath": legs[0].account,
            }
        )
    return out


def _classify(
    t: data.Transaction, led: _Ledger, cfg: MobileConfig
) -> tuple[str, Decimal, str, str | None, str | None]:
    """(kind, signed amount, primary account, category, subcategory)."""
    a = cfg.accounts
    ps = t.postings
    exp = [p for p in ps if p.account.startswith("Expenses")]
    inc = [p for p in ps if p.account.startswith("Income")]
    inv = [p for p in ps if p.account.startswith(a.investments)]
    sheet = [p for p in ps if p.account.startswith(BALANCE_SHEET)]
    outside = [p for p in sheet if not p.account.startswith(a.investments)]

    def first(prefixes: tuple[str, ...], pool: list | None = None) -> str | None:
        for prefix in prefixes:
            for p in sheet if pool is None else pool:
                if p.account.startswith(prefix):
                    return p.account
        return None

    def moved(account: str) -> Decimal:
        return sum((led.val(p, t.date) for p in ps if p.account == account), ZERO)

    def primary() -> str:
        return (
            first(a.cards + a.checking + a.savings + a.paying)
            or first(a.loans + a.investments + a.payables + a.receivables)
            or first(
                tuple(p.account for p in sheet if not p.account.startswith(a.clearing))
            )
            or first(a.clearing)
            or ""
        )

    if inv and (any(p.units.currency != "USD" for p in inv) or outside):
        cash_legs = [p for p in inv if p.units.currency == "USD"]
        if cash_legs and not outside:
            # A trade inside the account: its cash leg (a buy spends cash).
            amount = sum((p.units.number for p in cash_legs), ZERO)
        else:
            # Value arriving in (+) or leaving (-) the investment accounts.
            amount = sum((led.trade_val(p, t.date) for p in inv), ZERO)
        return KIND_INVESTMENT, amount, inv[0].account, None, None

    loan_legs = [p for p in ps if p.account.startswith(a.loans) and p.units.number > 0]
    payer = first(a.cash, [p for p in sheet if p.units.number < 0])
    if loan_legs and payer:
        return KIND_LOAN_PAYMENT, moved(payer), payer, None, None

    if exp:
        top = max(exp, key=lambda p: p.units.number).account
        parts = top.split(":")
        amount = -sum((led.val(p, t.date) for p in exp), ZERO)
        return (
            KIND_EXPENSE,
            amount,
            primary(),
            _exp_cat(top),
            ":".join(parts[2:]) or None,
        )
    if inc:
        amount = -sum((led.val(p, t.date) for p in inc), ZERO)
        account = primary()
        through = moved(account)
        if abs(amount) * 2 < abs(through):
            # Mostly money changing accounts (a repayment with a rounding
            # gain, a discounted gift card): show what moved, not the sliver.
            return KIND_TRANSFER, through, account, None, None
        parts = inc[0].account.split(":")
        return (
            KIND_INCOME,
            amount,
            account,
            _exp_cat(inc[0].account),
            ":".join(parts[2:]) or None,
        )

    card = first(a.cards, [p for p in sheet if p.units.number > 0])
    if card and all(p.account.startswith(a.cards + a.cash + a.clearing) for p in sheet):
        return KIND_CARD_PAYMENT, moved(card), card, None, None

    account = primary()
    return KIND_TRANSFER, moved(account), account, None, None


def _build_activity(
    led: _Ledger,
    cfg: MobileConfig,
    names: _Names,
    spend_by_month: list,
    investment_paths: dict[str, str],
) -> dict:
    start = led.asof - dt.timedelta(days=cfg.activity_days)
    rows = []
    ordinal: dict[dt.date, int] = collections.defaultdict(int)
    for t in led.past:
        if t.date < start or t.flag != "*":
            continue
        ordinal[t.date] += 1
        kind, amount, account, category, sub = _classify(t, led, cfg)
        if kind == KIND_TRANSFER and abs(amount) < Decimal("0.005"):
            continue  # $0 verification entries and the like
        if account.startswith(cfg.accounts.investments):
            # Rows point at the rolled-up investment account, not the
            # per-ticker ledger account, so they join accounts.groups.
            short = names.investment(account)
            account = investment_paths.get(short, account)
            shown = names.display(account, short)
        else:
            short = account.split(":")[-1]
            shown = names.display(account)
        rows.append(
            {
                "id": f"{t.date.isoformat()}-{ordinal[t.date]:03d}",
                "date": t.date.isoformat(),
                "payee": t.payee or t.narration or "",
                "narration": (t.narration or "") if t.payee else "",
                "amount": _r2(amount),
                "kind": kind,
                "category": category,
                "subcategory": sub,
                "account": short,
                "accountName": shown,
                "accountPath": account,
            }
        )
    rows.reverse()
    return {
        "from": start.isoformat(),
        "to": led.asof.isoformat(),
        "transactions": rows,
        "spendByMonth": spend_by_month,
    }


# ---- goals and plan -----------------------------------------------------------


def _goal_value(goal: Goal, led: _Ledger, cfg: MobileConfig) -> Decimal:
    m = goal.measure
    if m.type == MEASURE_BALANCE:
        return led.balance(m.account)
    if m.type == MEASURE_CONTRIBUTIONS:
        year = m.year or led.asof.year
        funding = cfg.accounts.cash + cfg.accounts.clearing
        total = ZERO
        for t in led.past:
            if t.date.year != year:
                continue
            from_salary = any(
                p.account.startswith(cfg.accounts.salary) for p in t.postings
            )
            from_cash = any(
                p.account.startswith(funding) and p.units.number < 0 for p in t.postings
            )
            if from_salary or from_cash:
                total += sum(
                    (
                        p.units.number
                        for p in t.postings
                        if p.account.startswith(m.account)
                        and p.units.currency == "USD"
                        and p.units.number > 0
                    ),
                    ZERO,
                )
        return total
    if m.type == MEASURE_CARD_SPEND:
        total = ZERO
        for t in led.past:
            if m.since and t.date < m.since:
                continue
            payee = (t.payee or "").lower()
            if any(s in payee for s in m.exclude_payee_contains):
                continue
            if m.exclude_accounts and any(
                p.account.startswith(m.exclude_accounts) for p in t.postings
            ):
                continue
            total -= sum(
                (
                    p.units.number
                    for p in t.postings
                    if p.account == m.account and p.units.number < 0
                ),
                ZERO,
            )
        return total
    raise ValueError(f"unknown measure {m.type}")


def _goal_row(
    gid: str,
    name: str,
    value: Decimal,
    target: float,
    due: dt.date | None,
    note: str | None,
) -> dict:
    row: dict[str, Any] = {
        "id": gid,
        "name": name,
        "value": _r2(value),
        "target": target,
    }
    if due is not None:
        row["due"] = due.isoformat()
    if note:
        row["note"] = note
    row["progress"] = round(float(value) / target, 4) if target else 0.0
    row["remaining"] = _r2(max(Decimal(str(target)) - value, ZERO))
    return row


def _build_goals(led: _Ledger, cfg: MobileConfig) -> list[dict]:
    goals = []
    ef = cfg.emergency_fund
    if ef is not None:
        goals.append(
            _goal_row("ef", ef.name, led.balance(ef.account), ef.target, None, ef.note)
        )
    for g in cfg.goals:
        goals.append(
            _goal_row(g.id, g.name, _goal_value(g, led, cfg), g.target, g.due, g.note)
        )
    return goals


def _build_events(
    cfg: MobileConfig,
    names: _Names,
    upcoming: list[dict],
    cards: list[dict],
    key_dates: list[dict],
    horizon: dt.date,
    start_cash: float,
) -> tuple[list[dict], dict | None]:
    """Dated cash events through the horizon, with the running cash balance."""
    out: list[dict] = []
    merged: dict[tuple[int, str], dict] = {}
    for u in upcoming:
        rule_i, rule = next(
            (
                (i, r)
                for i, r in enumerate(cfg.event_rules)
                if r.matches(u["label"], u["note"])
            ),
            (None, None),
        )
        default_kind = "pay" if u["amount"] > 0 else "bill"
        if rule is not None and rule.merge:
            e = merged.setdefault(
                (rule_i, u["date"]),
                {
                    "date": u["date"],
                    "label": rule.label or u["label"],
                    "note": rule.note or "",
                    "amount": 0.0,
                    "kind": rule.kind,
                    "paycheck": rule.paycheck,
                },
            )
            e["amount"] += u["amount"]
            continue
        out.append(
            {
                "date": u["date"],
                "label": (
                    rule.label if rule and rule.label else u["note"] or u["label"]
                ),
                "note": (
                    rule.note
                    if rule and rule.note is not None
                    else names.display(u["accountPath"])
                ),
                "amount": u["amount"],
                "kind": (rule.kind if rule and rule.kind else default_kind),
                "paycheck": bool(rule and rule.paycheck),
            }
        )
    for e in merged.values():
        e["amount"] = _r2(e["amount"])
        e["kind"] = e["kind"] or ("pay" if e["amount"] > 0 else "bill")
        out.append(e)
    limit = horizon.isoformat()
    for c in cards:
        if c["due"] and c["value"] > 1 and c["due"] <= limit:
            out.append(
                {
                    "date": c["due"],
                    "label": c["displayName"],
                    "note": f"Paid from {c['fundedByName'] or ''}".rstrip(),
                    "amount": -c["value"],
                    "kind": "card",
                    "paycheck": False,
                }
            )
    for k in key_dates:
        if k["date"] <= limit:
            out.append({**k, "amount": 0.0, "kind": "info", "paycheck": False})

    order = {"pay": 0, "info": 1, "bill": 2, "card": 3}
    out.sort(key=lambda e: (e["date"], order[e["kind"]]))
    balance = Decimal(str(start_cash))
    events = []
    next_pay = None
    for i, e in enumerate(out):
        balance += Decimal(str(e["amount"]))
        paycheck = e.pop("paycheck")
        row = {"id": f"{e['date']}-{i:03d}", **e, "balance": _r2(balance)}
        events.append(row)
        if paycheck and next_pay is None:
            next_pay = row
    return events, next_pay


# ---- entry point ---------------------------------------------------------------


def build_snapshot(
    entries: list,
    cfg: MobileConfig,
    asof: dt.date,
    *,
    cc_cards: dict | None = None,
    statements: dict | None = None,
    meta: dict | None = None,
) -> dict:
    """Build the snapshot dict.

    ``cc_cards`` is the planner's per-card settings (``journal/plan/cc-cards.json``:
    ``paymentDueDay``, ``statementBalance``, ``fundingAccount`` keyed by account).
    ``statements`` is the closed card statements on record, keyed by account
    (``billing.read_all``): a card that has any gets its due date and
    statement amount from the newest one, never from ``statementBalance``.
    ``meta`` is merged into the snapshot's ``meta`` block (generation time,
    ledger commit).
    """
    led = _Ledger(entries, asof)
    names = _Names(cfg)
    a = cfg.accounts
    groups = _build_accounts(led, cfg, names, cc_cards or {}, statements)
    horizon = cfg.horizon(asof)

    series = [
        {
            "date": d.isoformat(),
            "netWorth": round(led.total(d)),
            "invest": round(led.total(d, a.investments)),
            "cash": round(led.total(d, a.cash)),
        }
        for d in led.series_dates
    ]

    cash_rows = groups["cash"]["accounts"]
    cash = [
        {"name": r["name"], "value": r["value"]}
        for r in cash_rows
        if r["type"] == "checking"
    ] + [
        {"name": r["name"] + " savings", "value": r["value"]}
        for r in cash_rows
        if r["type"] == "savings"
    ]
    cards = []
    for r in groups["cards"]["accounts"]:
        c = {"name": r["name"], "value": r["value"]}
        if r["due"]:
            c.update(due=r["due"], statement=r["statement"], fundedBy=r["fundedBy"])
        c["displayName"] = r["displayName"]
        cards.append(c)
    invest = sorted(
        (
            {"name": r["name"], "value": r["value"]}
            for r in groups["investments"]["accounts"]
        ),
        key=lambda g: -g["value"],
    )

    spend, income, savings_rate, spend_by_month = _build_spend(led, cfg)
    recent = _build_recent(led, cfg)
    upcoming = _build_upcoming(led, cfg, horizon)
    goals = _build_goals(led, cfg)
    key_dates = [
        {"date": k.date.isoformat(), "label": k.label, "note": k.note}
        for k in cfg.key_dates
        if k.date >= asof
    ]

    cash_total = _r2(sum(g["value"] for g in cash))
    card_total = _r2(sum(g["value"] for g in cards))
    reserve = (
        float(led.balance(cfg.emergency_fund.account)) if cfg.emergency_fund else 0.0
    )
    loan = None
    if cfg.loans:
        first = cfg.loans[0]
        loan = {
            "name": first.name,
            "balance": _r2(-led.balance(first.account)),
            "original": first.original,
            "payment": first.payment,
            "payoff": first.payoff.isoformat() if first.payoff else None,
        }

    events, next_pay = _build_events(
        cfg,
        names,
        upcoming,
        groups["cards"]["accounts"],
        key_dates,
        horizon,
        cash_total,
    )
    low = min(events, key=lambda e: e["balance"], default=None)
    if low is None or low["balance"] >= cash_total:
        low_out = {"date": asof.isoformat(), "balance": cash_total}
    else:
        low_out = {"date": low["date"], "balance": low["balance"]}

    net_now = led.total(asof)
    invest_now = led.total(asof, a.investments)
    d30 = asof - dt.timedelta(days=30)
    return {
        "meta": {
            "schemaVersion": SCHEMA_VERSION,
            "asOf": asof.isoformat(),
            "generatedAt": None,
            "ledgerCommit": None,
            "ledgerDirty": None,
            **(meta or {}),
        },
        "asOf": asof.isoformat(),
        "netWorth": {
            "value": round(net_now, 2),
            "d1": round(net_now - led.total(asof - dt.timedelta(days=1))),
            "d30": round(net_now - led.total(d30)),
            "ytd": round(net_now - led.total(led.year_start)),
            "series": series,
        },
        "cash": {"total": cash_total, "accounts": cash},
        "cards": {"total": card_total, "accounts": cards},
        "float": {
            "afterCards": _r2(cash_total - card_total),
            "reserve": _r2(reserve),
            "spendable": _r2(cash_total - reserve - card_total),
        },
        "invest": {
            "total": _r2(invest_now),
            "d30": round(invest_now - led.total(d30, a.investments)),
            "accounts": invest,
        },
        "loan": loan,
        "receivable": [
            {"name": r["name"], "value": r["value"]}
            for r in groups["receivables"]["accounts"]
        ],
        "payable": [
            {"name": r["name"], "value": r["value"]}
            for r in groups["payables"]["accounts"]
        ],
        "spend": spend,
        "income": income,
        "savingsRate3m": savings_rate,
        "recent": recent,
        "upcoming": upcoming,
        "goals": goals,
        "keyDates": key_dates,
        "accounts": {"groups": [groups[gid] for gid, *_ in GROUPS]},
        "activity": _build_activity(
            led,
            cfg,
            names,
            spend_by_month,
            {r["name"]: r["account"] for r in groups["investments"]["accounts"]},
        ),
        "plan": {
            "horizon": horizon.isoformat(),
            "startCash": cash_total,
            "events": events,
            "low": low_out,
            "nextPay": next_pay,
            "goals": goals,
            "keyDates": key_dates,
        },
    }
