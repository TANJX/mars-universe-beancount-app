"""Load and validate ``$LEDGER_DIR/config/mobile.yaml``.

Everything personal about a snapshot lives in that file: goals, the emergency
fund, loans, key dates, display names, the rules that label upcoming cash
events and the labels that name raw payees. The generator itself only knows
the shape of a beancount ledger.

A missing file is a valid, empty config: the snapshot then has balances,
spending and activity but no goals, key dates or labelled events.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from beancount_tooling.mobile.payees import PayeeLabel

CONFIG_FILENAME = "mobile.yaml"

MEASURE_BALANCE = "balance"
MEASURE_CONTRIBUTIONS = "contributions"
MEASURE_CARD_SPEND = "card_spend"
MEASURES = (MEASURE_BALANCE, MEASURE_CONTRIBUTIONS, MEASURE_CARD_SPEND)

EVENT_KINDS = ("pay", "bill")


class MobileConfigError(ValueError):
    """mobile.yaml is malformed."""


@dataclass(frozen=True)
class Accounts:
    """Account prefixes that map the chart of accounts onto snapshot groups."""

    checking: tuple[str, ...] = ("Assets:Checking",)
    savings: tuple[str, ...] = ("Assets:Saving",)
    cards: tuple[str, ...] = ("Liabilities:Credit",)
    investments: tuple[str, ...] = ("Assets:Investment",)
    loans: tuple[str, ...] = ("Liabilities:Loan",)
    receivables: tuple[str, ...] = ("Assets:Receivable",)
    payables: tuple[str, ...] = ("Liabilities:Payable",)
    salary: tuple[str, ...] = ("Income:Salary",)
    # Clearing accounts a transfer passes through between two real accounts.
    clearing: tuple[str, ...] = ("Assets:Pending-Transfer",)
    # Other accounts that can pay for an expense (after cards and checking).
    paying: tuple[str, ...] = ("Assets:Transit", "Assets:Gift-Card")
    # Checking or savings accounts that are not spendable money (a benefit
    # card's balance). They leave the cash group, cash totals and projected
    # cash, and are listed under "other". Net worth still counts them.
    cash_exclude: tuple[str, ...] = ()

    @property
    def cash(self) -> tuple[str, ...]:
        return self.checking + self.savings

    def is_cash(self, account: str) -> bool:
        """Checking or savings, and not excluded from cash."""
        return account.startswith(self.cash) and not self.cash_excluded(account)

    def cash_excluded(self, account: str) -> bool:
        return bool(self.cash_exclude) and account.startswith(self.cash_exclude)


@dataclass(frozen=True)
class Measure:
    type: str
    account: str
    year: int | None = None
    since: dt.date | None = None
    exclude_payee_contains: tuple[str, ...] = ()
    exclude_accounts: tuple[str, ...] = ()


@dataclass(frozen=True)
class Goal:
    id: str
    name: str
    target: float
    measure: Measure
    due: dt.date | None = None
    note: str | None = None


@dataclass(frozen=True)
class EmergencyFund:
    account: str
    target: float
    name: str = "Emergency fund"
    note: str | None = None


@dataclass(frozen=True)
class Loan:
    account: str
    name: str
    original: float | None = None
    payment: float | None = None
    payoff: dt.date | None = None


@dataclass(frozen=True)
class KeyDate:
    date: dt.date
    label: str
    note: str = ""


@dataclass(frozen=True)
class InvestmentGroup:
    """Names the investment account an account path belongs to.

    ``name`` is a fixed name for everything under ``prefix``; ``component`` picks
    the path component at that index instead (0 is ``Assets``).
    """

    prefix: str
    name: str | None = None
    component: int | None = None


@dataclass(frozen=True)
class EventRule:
    """Relabels an upcoming transaction in the plan. First match wins."""

    payee_prefix: str | None = None
    payee_contains: str | None = None
    narration_contains: str | None = None
    label: str | None = None
    note: str | None = None
    kind: str | None = None
    merge: bool = False
    paycheck: bool = False

    def matches(self, payee: str, narration: str) -> bool:
        if self.payee_prefix is not None and not payee.startswith(self.payee_prefix):
            return False
        if self.payee_contains is not None and self.payee_contains not in payee:
            return False
        return self.narration_contains is None or self.narration_contains in narration


@dataclass(frozen=True)
class VestingSchedule:
    """One vesting schedule: ``shares`` vest in ``months`` equal monthly
    tranches counted from ``start``; nothing vests before ``cliff_months``
    have passed, and then every tranche up to that month vests at once."""

    shares: float
    start: dt.date
    months: int
    cliff_months: int = 0


@dataclass(frozen=True)
class EquityGrant:
    """An option grant. A grant with an unusual structure (two halves on
    different clocks) lists one schedule per part."""

    id: str
    shares: float
    strike: float
    vesting: tuple[VestingSchedule, ...]
    name: str | None = None
    type: str | None = None
    grant_date: dt.date | None = None
    expiration: dt.date | None = None
    exercised: float = 0.0


@dataclass(frozen=True)
class Equity:
    """Option grants in a private company: paper value, never in net worth."""

    grants: tuple[EquityGrant, ...]
    company: str | None = None
    # Fair market value of one common share (a 409A valuation).
    fmv: float | None = None
    fmv_date: dt.date | None = None
    # Price per share of the last preferred round.
    preferred_price: float | None = None
    note: str | None = None


@dataclass(frozen=True)
class MobileConfig:
    accounts: Accounts = field(default_factory=Accounts)
    horizon_until: dt.date | None = None
    horizon_days: int = 50
    activity_days: int = 90
    day_to_day_exclude: tuple[str, ...] = ()
    emergency_fund: EmergencyFund | None = None
    goals: tuple[Goal, ...] = ()
    loans: tuple[Loan, ...] = ()
    key_dates: tuple[KeyDate, ...] = ()
    investments: tuple[InvestmentGroup, ...] = ()
    event_rules: tuple[EventRule, ...] = ()
    display_names: dict[str, str] = field(default_factory=dict)
    equity: Equity | None = None
    payees: tuple[PayeeLabel, ...] = ()
    path: Path | None = None

    def horizon(self, asof: dt.date) -> dt.date:
        """Last day the plan covers: ``until`` while it is still ahead, else
        ``days`` from the as-of date."""
        if self.horizon_until is not None and self.horizon_until > asof:
            return self.horizon_until
        return asof + dt.timedelta(days=self.horizon_days)


def _mapping(value: Any, where: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise MobileConfigError(f"{where}: expected a mapping")
    return value


def _list(value: Any, where: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise MobileConfigError(f"{where}: expected a list")
    return value


def _known(m: dict, allowed: set[str], where: str) -> None:
    extra = sorted(set(m) - allowed)
    if extra:
        raise MobileConfigError(f"{where}: unknown key(s) {', '.join(extra)}")


def _str(m: dict, key: str, where: str, *, required: bool = True) -> str | None:
    v = m.get(key)
    if v is None:
        if required:
            raise MobileConfigError(f"{where}: missing '{key}'")
        return None
    return str(v)


def _num(m: dict, key: str, where: str, *, required: bool = True) -> float | None:
    v = m.get(key)
    if v is None:
        if required:
            raise MobileConfigError(f"{where}: missing '{key}'")
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise MobileConfigError(f"{where}: '{key}' must be a number")
    return float(v)


def _date(m: dict, key: str, where: str, *, required: bool = True) -> dt.date | None:
    v = m.get(key)
    if v is None:
        if required:
            raise MobileConfigError(f"{where}: missing '{key}'")
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v))
    except ValueError as e:
        raise MobileConfigError(f"{where}: '{key}' must be YYYY-MM-DD") from e


def _strs(value: Any, where: str) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    return tuple(str(v) for v in _list(value, where))


def _parse_accounts(raw: Any) -> Accounts:
    m = _mapping(raw, "accounts")
    fields = set(Accounts.__dataclass_fields__)
    _known(m, fields, "accounts")
    return Accounts(**{k: _strs(v, f"accounts.{k}") for k, v in m.items()})


def _parse_measure(raw: Any, where: str) -> Measure:
    m = _mapping(raw, where)
    _known(
        m,
        {
            "type",
            "account",
            "year",
            "since",
            "exclude_payee_contains",
            "exclude_accounts",
        },
        where,
    )
    kind = _str(m, "type", where)
    if kind not in MEASURES:
        raise MobileConfigError(f"{where}: type must be one of {', '.join(MEASURES)}")
    year = m.get("year")
    if year is not None and (isinstance(year, bool) or not isinstance(year, int)):
        raise MobileConfigError(f"{where}: 'year' must be an integer")
    return Measure(
        type=kind,
        account=_str(m, "account", where),
        year=year,
        since=_date(m, "since", where, required=kind == MEASURE_CARD_SPEND),
        exclude_payee_contains=tuple(
            s.lower() for s in _strs(m.get("exclude_payee_contains"), where)
        ),
        exclude_accounts=_strs(m.get("exclude_accounts"), where),
    )


def _parse_goal(raw: Any, i: int) -> Goal:
    where = f"goals[{i}]"
    m = _mapping(raw, where)
    _known(m, {"id", "name", "target", "measure", "due", "note"}, where)
    return Goal(
        id=_str(m, "id", where),
        name=_str(m, "name", where),
        target=_num(m, "target", where),
        measure=_parse_measure(m.get("measure"), f"{where}.measure"),
        due=_date(m, "due", where, required=False),
        note=_str(m, "note", where, required=False),
    )


def _parse_rule(raw: Any, i: int) -> EventRule:
    where = f"plan.events[{i}]"
    m = _mapping(raw, where)
    _known(m, {"match", "label", "note", "kind", "merge", "paycheck"}, where)
    match = _mapping(m.get("match"), f"{where}.match")
    _known(
        match,
        {"payee_prefix", "payee_contains", "narration_contains"},
        f"{where}.match",
    )
    if not match:
        raise MobileConfigError(f"{where}: 'match' needs at least one condition")
    kind = _str(m, "kind", where, required=False)
    if kind is not None and kind not in EVENT_KINDS:
        raise MobileConfigError(
            f"{where}: kind must be one of {', '.join(EVENT_KINDS)}"
        )
    return EventRule(
        payee_prefix=_str(match, "payee_prefix", where, required=False),
        payee_contains=_str(match, "payee_contains", where, required=False),
        narration_contains=_str(match, "narration_contains", where, required=False),
        label=_str(m, "label", where, required=False),
        note=_str(m, "note", where, required=False),
        kind=kind,
        merge=bool(m.get("merge", False)),
        paycheck=bool(m.get("paycheck", False)),
    )


def _parse_investment(raw: Any, i: int) -> InvestmentGroup:
    where = f"investments.accounts[{i}]"
    m = _mapping(raw, where)
    _known(m, {"prefix", "name", "component"}, where)
    name = _str(m, "name", where, required=False)
    component = m.get("component")
    if (name is None) == (component is None):
        raise MobileConfigError(f"{where}: give exactly one of 'name' or 'component'")
    if component is not None and (
        isinstance(component, bool) or not isinstance(component, int)
    ):
        raise MobileConfigError(f"{where}: 'component' must be an integer")
    return InvestmentGroup(
        prefix=_str(m, "prefix", where), name=name, component=component
    )


def _int(m: dict, key: str, where: str, default: int | None = None) -> int:
    v = m.get(key, default)
    if v is None:
        raise MobileConfigError(f"{where}: missing '{key}'")
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise MobileConfigError(f"{where}: '{key}' must be a whole number, 0 or more")
    return v


def _parse_grant(raw: Any, i: int) -> EquityGrant:
    where = f"equity.grants[{i}]"
    m = _mapping(raw, where)
    _known(
        m,
        {
            "id",
            "name",
            "type",
            "grant_date",
            "shares",
            "strike",
            "expiration",
            "exercised",
            "vesting",
        },
        where,
    )
    shares = _num(m, "shares", where)
    schedules = []
    for j, raw_s in enumerate(_list(m.get("vesting"), f"{where}.vesting")):
        sw = f"{where}.vesting[{j}]"
        sm = _mapping(raw_s, sw)
        _known(sm, {"shares", "start", "months", "cliff_months"}, sw)
        months = _int(sm, "months", sw)
        cliff = _int(sm, "cliff_months", sw, 0)
        if months < 1:
            raise MobileConfigError(f"{sw}: 'months' must be at least 1")
        if cliff > months:
            raise MobileConfigError(f"{sw}: 'cliff_months' is longer than 'months'")
        schedules.append(
            VestingSchedule(
                shares=_num(sm, "shares", sw),
                start=_date(sm, "start", sw),
                months=months,
                cliff_months=cliff,
            )
        )
    if not schedules:
        raise MobileConfigError(f"{where}: 'vesting' needs at least one schedule")
    if abs(sum(s.shares for s in schedules) - shares) > 1e-6:
        raise MobileConfigError(
            f"{where}: the vesting schedules do not add up to 'shares'"
        )
    exercised = _num(m, "exercised", where, required=False) or 0.0
    if not 0 <= exercised <= shares:
        raise MobileConfigError(f"{where}: 'exercised' must be between 0 and 'shares'")
    return EquityGrant(
        id=_str(m, "id", where),
        name=_str(m, "name", where, required=False),
        type=_str(m, "type", where, required=False),
        grant_date=_date(m, "grant_date", where, required=False),
        shares=shares,
        strike=_num(m, "strike", where),
        expiration=_date(m, "expiration", where, required=False),
        exercised=exercised,
        vesting=tuple(schedules),
    )


def _parse_equity(raw: Any) -> Equity | None:
    if raw is None:
        return None
    m = _mapping(raw, "equity")
    _known(
        m,
        {"company", "fmv", "fmv_date", "preferred_price", "note", "grants"},
        "equity",
    )
    grants = tuple(
        _parse_grant(g, i)
        for i, g in enumerate(_list(m.get("grants"), "equity.grants"))
    )
    if not grants:
        raise MobileConfigError("equity: 'grants' needs at least one grant")
    ids = [g.id for g in grants]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise MobileConfigError(f"equity.grants: duplicate id(s) {', '.join(dupes)}")
    return Equity(
        grants=grants,
        company=_str(m, "company", "equity", required=False),
        fmv=_num(m, "fmv", "equity", required=False),
        fmv_date=_date(m, "fmv_date", "equity", required=False),
        preferred_price=_num(m, "preferred_price", "equity", required=False),
        note=_str(m, "note", "equity", required=False),
    )


def _parse_payee(raw: Any, i: int) -> PayeeLabel:
    where = f"payees[{i}]"
    m = _mapping(raw, where)
    _known(m, {"match", "title", "narration"}, where)
    pattern = _str(m, "match", where)
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise MobileConfigError(f"{where}: 'match' is not a valid pattern: {e}") from e
    title = _str(m, "title", where)
    if not title.strip():
        raise MobileConfigError(f"{where}: 'title' is empty")
    return PayeeLabel(
        pattern=compiled,
        title=title,
        narration=_str(m, "narration", where, required=False),
    )


def parse_config(raw: Any, path: Path | None = None) -> MobileConfig:
    """Validate a parsed mobile.yaml document."""
    doc = _mapping(raw, "mobile.yaml")
    _known(
        doc,
        {
            "accounts",
            "plan",
            "activity",
            "spending",
            "emergency_fund",
            "goals",
            "loans",
            "key_dates",
            "investments",
            "display_names",
            "equity",
            "payees",
        },
        "mobile.yaml",
    )

    plan = _mapping(doc.get("plan"), "plan")
    _known(plan, {"horizon", "events"}, "plan")
    horizon = _mapping(plan.get("horizon"), "plan.horizon")
    _known(horizon, {"until", "days"}, "plan.horizon")
    days = horizon.get("days", 50)
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        raise MobileConfigError("plan.horizon.days must be a positive integer")

    activity = _mapping(doc.get("activity"), "activity")
    _known(activity, {"days"}, "activity")
    activity_days = activity.get("days", 90)
    if (
        isinstance(activity_days, bool)
        or not isinstance(activity_days, int)
        or activity_days < 1
    ):
        raise MobileConfigError("activity.days must be a positive integer")

    spending = _mapping(doc.get("spending"), "spending")
    _known(spending, {"day_to_day_exclude"}, "spending")

    ef = None
    if doc.get("emergency_fund") is not None:
        m = _mapping(doc["emergency_fund"], "emergency_fund")
        _known(m, {"account", "target", "name", "note"}, "emergency_fund")
        ef = EmergencyFund(
            account=_str(m, "account", "emergency_fund"),
            target=_num(m, "target", "emergency_fund"),
            name=_str(m, "name", "emergency_fund", required=False) or "Emergency fund",
            note=_str(m, "note", "emergency_fund", required=False),
        )

    goals = tuple(
        _parse_goal(g, i) for i, g in enumerate(_list(doc.get("goals"), "goals"))
    )
    ids = [g.id for g in goals] + (["ef"] if ef else [])
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise MobileConfigError(f"goals: duplicate id(s) {', '.join(dupes)}")

    loans = []
    for i, raw_loan in enumerate(_list(doc.get("loans"), "loans")):
        where = f"loans[{i}]"
        m = _mapping(raw_loan, where)
        _known(m, {"account", "name", "original", "payment", "payoff"}, where)
        loans.append(
            Loan(
                account=_str(m, "account", where),
                name=_str(m, "name", where),
                original=_num(m, "original", where, required=False),
                payment=_num(m, "payment", where, required=False),
                payoff=_date(m, "payoff", where, required=False),
            )
        )

    key_dates = []
    for i, raw_kd in enumerate(_list(doc.get("key_dates"), "key_dates")):
        where = f"key_dates[{i}]"
        m = _mapping(raw_kd, where)
        _known(m, {"date", "label", "note"}, where)
        key_dates.append(
            KeyDate(
                date=_date(m, "date", where),
                label=_str(m, "label", where),
                note=_str(m, "note", where, required=False) or "",
            )
        )
    key_dates.sort(key=lambda k: k.date)

    investments = _mapping(doc.get("investments"), "investments")
    _known(investments, {"accounts"}, "investments")

    names = _mapping(doc.get("display_names"), "display_names")

    return MobileConfig(
        accounts=_parse_accounts(doc.get("accounts")),
        horizon_until=_date(horizon, "until", "plan.horizon", required=False),
        horizon_days=days,
        activity_days=activity_days,
        day_to_day_exclude=_strs(
            spending.get("day_to_day_exclude"), "spending.day_to_day_exclude"
        ),
        emergency_fund=ef,
        goals=goals,
        loans=tuple(loans),
        key_dates=tuple(key_dates),
        investments=tuple(
            _parse_investment(g, i)
            for i, g in enumerate(
                _list(investments.get("accounts"), "investments.accounts")
            )
        ),
        event_rules=tuple(
            _parse_rule(r, i)
            for i, r in enumerate(_list(plan.get("events"), "plan.events"))
        ),
        display_names={str(k): str(v) for k, v in names.items()},
        equity=_parse_equity(doc.get("equity")),
        payees=tuple(
            _parse_payee(p, i) for i, p in enumerate(_list(doc.get("payees"), "payees"))
        ),
        path=path,
    )


def load_config(path: Path | str) -> MobileConfig:
    """Read and validate one mobile.yaml. A missing file is an empty config."""
    path = Path(path)
    if not path.is_file():
        return MobileConfig(path=path)
    try:
        with path.open(encoding="utf-8") as f:
            raw = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise MobileConfigError(f"{path}: invalid YAML: {e}") from e
    try:
        return parse_config(raw, path)
    except MobileConfigError as e:
        raise MobileConfigError(f"{path}: {e}") from e
