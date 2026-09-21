"""Portfolio endpoint: holdings, value-vs-cost series, contribution room, realized.

Everything ledger-specific is discovered or configured, never named here:

* **Sleeves are discovered** by walking the investment subtree. Any account
  carrying a posting under it is attributed to a sleeve; a broker name in this
  module would be a bug.
* **Security names and asset classes** come from the journal's ``commodity``
  directives (``name:`` / ``asset-class:`` metadata). A ticker with no
  directive still renders, with the ticker as its name and no asset class.
* **Tax treatment, contribution limits, funding cadence, the margin tranche and
  the realized/dividend account names** come from ``<LEDGER_DIR>/config/ui.yaml``
  under ``investments:``.

Two correctness constraints drive the shape of this module:

1. The ledger carries future-dated ``!`` forecast transactions, including
   investment buys, so **every figure is bounded by ``date <= asof``**. An
   unbounded walk reports the forecast as if it had already happened.
2. Contributions are counted from the leg the money *left*, not the leg it
   arrived on. A broker match is encoded inline in the receiving amount, so the
   inflow side overstates what actually counts against an IRS limit. A
   ``contribution:`` metadata key on the transaction (or posting) overrides the
   structural derivation entirely.
"""

from __future__ import annotations

import datetime
import re
from collections import defaultdict
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from beancount.core import data

#: Root of the investment subtree. Sleeves live under it and are discovered.
INVESTMENT_ROOT = "Assets:Investment"

#: Account roots whose negative leg funds a contribution from outside a sleeve.
FUNDING_ROOTS = ("Assets:", "Liabilities:")

#: Income subtree that counts as contribution funding (pre-tax payroll).
#: Overridable via ``investments.contributions.payroll_prefixes``. Every other
#: income leg (broker match, trading proceeds, interest) is ignored by
#: construction: only these prefixes are ever read from ``Income:``.
DEFAULT_PAYROLL_PREFIXES = ("Income:Salary",)

#: Units below this are treated as a closed position rather than a holding.
UNIT_EPSILON = Decimal("0.000000005")

_SLUG_RE = re.compile(r"[^a-z0-9]+")



# ---------------------------------------------------------------- primitives


def _dec(value: Any) -> Decimal | None:
    """Coerce a YAML / metadata scalar to Decimal, or None if it is not one."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    number = getattr(value, "number", None)  # beancount Amount
    if isinstance(number, Decimal):
        return number
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _money(value: Decimal | None) -> float:
    return float(round(value or Decimal(0), 2))


def _units(value: Decimal | None) -> float:
    return float(round(value or Decimal(0), 8))


def _price(value: Decimal | None) -> float | None:
    return None if value is None else float(round(value, 6))


def _slug(account: str) -> str:
    prefix = INVESTMENT_ROOT + ":"
    tail = account.removeprefix(prefix)
    return _SLUG_RE.sub("-", tail.lower()).strip("-")


def _last_segment(account: str) -> str:
    return account.rsplit(":", 1)[-1]


def _in_subtree(account: str, root: str) -> bool:
    return account == root or account.startswith(root + ":")


def _month_end(year: int, month: int) -> datetime.date:
    if month == 12:
        return datetime.date(year, 12, 31)
    return datetime.date(year, month + 1, 1) - datetime.timedelta(days=1)


# ------------------------------------------------------------------- config


def _config_section(ui_config: dict, *path: str) -> dict:
    node: Any = ui_config
    for key in path:
        if not isinstance(node, dict):
            return {}
        node = node.get(key)
    return node if isinstance(node, dict) else {}


def _sleeve_annotations(ui_config: dict) -> tuple[dict[str, dict], list[str]]:
    """Return {account: annotation} plus limit keys in configured order."""
    investments = _config_section(ui_config, "investments")
    raw = investments.get("sleeves")
    annotations: dict[str, dict] = {}
    limit_key_order: list[str] = []
    if not isinstance(raw, list):
        return annotations, limit_key_order
    for item in raw:
        if not isinstance(item, dict):
            continue
        account = item.get("account")
        if not isinstance(account, str) or not account:
            continue
        annotations[account] = item
        key = item.get("limit_key")
        if isinstance(key, str) and key and key not in limit_key_order:
            limit_key_order.append(key)
    return annotations, limit_key_order


def _limits_for_year(ui_config: dict, year: int) -> dict[str, Decimal]:
    limits = _config_section(ui_config, "investments", "limits")
    for raw_year, mapping in limits.items():
        if str(raw_year) != str(year) or not isinstance(mapping, dict):
            continue
        out: dict[str, Decimal] = {}
        for key, value in mapping.items():
            amount = _dec(value)
            if isinstance(key, str) and amount is not None:
                out[key] = amount
        return out
    return {}


def _payroll_prefixes(ui_config: dict) -> tuple[str, ...]:
    configured = _config_section(ui_config, "investments", "contributions").get(
        "payroll_prefixes"
    )
    if isinstance(configured, list):
        prefixes = tuple(p for p in configured if isinstance(p, str) and p)
        if prefixes:
            return prefixes
    return DEFAULT_PAYROLL_PREFIXES


# ------------------------------------------------------- commodity metadata


def _commodity_meta(ledger) -> dict[str, dict[str, str | None]]:
    """Map ticker -> {name, assetClass} from the journal's commodity directives.

    Absent metadata degrades: the name falls back to the ticker itself and the
    asset class stays None so the ticker groups as unclassified rather than
    silently joining a bucket it does not belong to.
    """
    out: dict[str, dict[str, str | None]] = {}
    for directive in getattr(ledger.all_entries_by_type, "Commodity", []):
        meta = directive.meta or {}
        name = meta.get("name")
        asset_class = meta.get("asset-class")
        out[directive.currency] = {
            "name": str(name) if name else None,
            "assetClass": str(asset_class) if asset_class else None,
        }
    return out


# ------------------------------------------------------------ sleeve walking


class _SleeveResolver:
    """Map an investment posting account to the sleeve that owns it.

    A sleeve holds commodity leaves named after the commodity they carry
    (``<sleeve>:USD``, ``<sleeve>:<TICKER>``). Some sleeves post directly on
    themselves instead. Both shapes resolve without naming anything: an account
    is a commodity leaf when its own last segment is a currency it actually
    holds, and then its parent is the sleeve.
    """

    def __init__(self, currencies_by_account: dict[str, set[str]]) -> None:
        self._sleeve_of: dict[str, str] = {}
        for account, currencies in currencies_by_account.items():
            if _last_segment(account) in currencies and ":" in account:
                parent = account.rsplit(":", 1)[0]
                self._sleeve_of[account] = (
                    parent if parent != INVESTMENT_ROOT else account
                )
            else:
                self._sleeve_of[account] = account

    def of(self, account: str) -> str:
        return self._sleeve_of.get(account, account)


def _scan_investment_accounts(
    entries: Iterable[data.Directive], asof: datetime.date
) -> dict[str, set[str]]:
    currencies_by_account: dict[str, set[str]] = defaultdict(set)
    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        for posting in entry.postings:
            if not _in_subtree(posting.account, INVESTMENT_ROOT):
                continue
            if posting.units is None:
                continue
            currencies_by_account[posting.account].add(posting.units.currency)
    return currencies_by_account


# -------------------------------------------------------------- the endpoint


def build_portfolio(
    *,
    ledger,
    entries: Iterable[data.Directive],
    ui_config: dict,
    asof: datetime.date,
) -> dict:
    """Assemble the whole ``/portfolio`` payload, bounded by ``asof``."""
    entries = sorted(entries, key=lambda e: e.date)
    operating = (ledger.options.get("operating_currency") or ["USD"])[0]
    prices = ledger.prices
    commodity_meta = _commodity_meta(ledger)
    annotations, limit_key_order = _sleeve_annotations(ui_config)
    display_names = _config_section(ui_config, "accounts", "display_names")

    resolver = _SleeveResolver(_scan_investment_accounts(entries, asof))

    # (sleeve, currency) -> units / cost basis, and the month-end series, in one
    # pass over the entries in date order.
    units: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    cost: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    running_units: dict[str, Decimal] = defaultdict(Decimal)
    running_cost: dict[str, Decimal] = defaultdict(Decimal)

    series: list[dict] = []
    snapshots = _snapshot_dates(entries, asof)
    next_snapshot = 0

    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        while next_snapshot < len(snapshots) and snapshots[next_snapshot] < entry.date:
            series.append(
                _series_point(
                    snapshots[next_snapshot],
                    running_units,
                    running_cost,
                    prices,
                    operating,
                )
            )
            next_snapshot += 1
        for posting in entry.postings:
            if not _in_subtree(posting.account, INVESTMENT_ROOT):
                continue
            if posting.units is None:
                continue
            currency = posting.units.currency
            amount = posting.units.number or Decimal(0)
            basis = (
                amount * posting.cost.number
                if posting.cost is not None and posting.cost.number is not None
                else (amount if currency == operating else Decimal(0))
            )
            sleeve = resolver.of(posting.account)
            units[sleeve, currency] += amount
            cost[sleeve, currency] += basis
            running_units[currency] += amount
            running_cost[currency] += basis

    while next_snapshot < len(snapshots):
        series.append(
            _series_point(
                snapshots[next_snapshot],
                running_units,
                running_cost,
                prices,
                operating,
            )
        )
        next_snapshot += 1

    # ---- sleeves
    by_sleeve: dict[str, dict[str, tuple[Decimal, Decimal]]] = defaultdict(dict)
    for (sleeve, currency), amount in units.items():
        by_sleeve[sleeve][currency] = (amount, cost[sleeve, currency])

    sleeves: list[dict] = []
    price_dates: list[datetime.date] = []
    totals_cost = Decimal(0)
    totals_value = Decimal(0)
    totals_cash = Decimal(0)
    totals_securities_value = Decimal(0)
    open_positions = 0

    for account in sorted(by_sleeve):
        annotation = annotations.get(account, {})
        cash = Decimal(0)
        sec_cost = Decimal(0)
        sec_value = Decimal(0)
        holdings: list[dict] = []
        closed: list[dict] = []

        for currency, (amount, basis) in sorted(by_sleeve[account].items()):
            meta = commodity_meta.get(currency, {})
            name = meta.get("name") or currency
            asset_class = meta.get("assetClass")
            if currency == operating:
                cash += amount
                continue
            if abs(amount) < UNIT_EPSILON:
                closed.append(
                    {
                        "ticker": currency,
                        "name": name,
                        "assetClass": asset_class,
                    }
                )
                continue
            price_date, price = prices.get_price_point((currency, operating), asof)
            if price is None:
                value = basis
            else:
                value = amount * price
                if price_date is not None:
                    price_dates.append(price_date)
            sec_cost += basis
            sec_value += value
            open_positions += 1
            holdings.append(
                {
                    "ticker": currency,
                    "name": name,
                    "assetClass": asset_class,
                    "units": _units(amount),
                    "price": _price(price),
                    "cost": _money(basis),
                    "value": _money(value),
                }
            )

        holdings.sort(key=lambda h: h["value"], reverse=True)
        tranche = _dec(annotation.get("margin_free_tranche"))
        tax = annotation.get("tax")
        limit_key = annotation.get("limit_key")
        sleeves.append(
            {
                "id": _slug(account),
                "account": account,
                "label": display_names.get(account) or _last_segment(account),
                "tax": tax if isinstance(tax, str) else None,
                "limitKey": limit_key if isinstance(limit_key, str) else None,
                "cash": _money(cash),
                "marginFreeTranche": None if tranche is None else _money(tranche),
                "securitiesCost": _money(sec_cost),
                "securitiesValue": _money(sec_value),
                "cost": _money(sec_cost + cash),
                "value": _money(sec_value + cash),
                "holdings": holdings,
                "closed": closed,
            }
        )
        totals_cost += sec_cost + cash
        totals_value += sec_value + cash
        totals_cash += cash
        totals_securities_value += sec_value

    sleeves.sort(key=lambda s: (-s["value"], s["label"]))

    price_asof = max(price_dates) if price_dates else None
    contributions = _contributions(
        entries=entries,
        asof=asof,
        operating=operating,
        resolver=resolver,
        annotations=annotations,
        limit_key_order=limit_key_order,
        ui_config=ui_config,
    )

    return {
        "asof": asof.isoformat(),
        "priceAsof": price_asof.isoformat() if price_asof else None,
        "staleDays": (asof - price_asof).days if price_asof else None,
        "totals": {
            "cost": _money(totals_cost),
            "value": _money(totals_value),
            "cash": _money(totals_cash),
            "securitiesValue": _money(totals_securities_value),
            "positions": open_positions,
        },
        "sleeves": sleeves,
        "series": series,
        "realized": _realized(entries, asof, operating, ui_config),
        "contributions": contributions,
    }


# --------------------------------------------------------------- the series


def _snapshot_dates(
    entries: list[data.Directive], asof: datetime.date
) -> list[datetime.date]:
    """Month ends from the first investment posting through ``asof``.

    The last point is ``asof`` itself so the series ends on the same figures the
    header reports rather than on the previous month end.
    """
    start: datetime.date | None = None
    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        if any(_in_subtree(p.account, INVESTMENT_ROOT) for p in entry.postings):
            start = entry.date
            break
    if start is None:
        return []

    dates: list[datetime.date] = []
    cursor = _month_end(start.year, start.month)
    while cursor < asof:
        dates.append(cursor)
        cursor = _next_month_end(cursor)
    dates.append(asof)
    return dates


def _next_month_end(date: datetime.date) -> datetime.date:
    following = date + datetime.timedelta(days=1)
    return _month_end(following.year, following.month)


def _series_point(
    date: datetime.date,
    units: dict[str, Decimal],
    cost: dict[str, Decimal],
    prices,
    operating: str,
) -> dict:
    total_cost = Decimal(0)
    total_value = Decimal(0)
    for currency, amount in units.items():
        basis = cost.get(currency, Decimal(0))
        total_cost += basis
        if currency == operating:
            total_value += amount
            continue
        if abs(amount) < UNIT_EPSILON:
            continue
        _, price = prices.get_price_point((currency, operating), date)
        total_value += basis if price is None else amount * price
    return {
        "date": date.isoformat(),
        "cost": _money(total_cost),
        "value": _money(total_value),
    }


# -------------------------------------------------------------- realized P/L


def _realized(
    entries: Iterable[data.Directive],
    asof: datetime.date,
    operating: str,
    ui_config: dict,
) -> list[dict]:
    configured = _config_section(ui_config, "investments", "realized")
    gains_account = configured.get("gains")
    dividends_account = configured.get("dividends")
    if not isinstance(gains_account, str) and not isinstance(dividends_account, str):
        return []

    by_year: dict[int, dict[str, Decimal]] = defaultdict(
        lambda: {"gains": Decimal(0), "dividends": Decimal(0)}
    )
    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        for posting in entry.postings:
            if posting.units is None or posting.units.currency != operating:
                continue
            amount = posting.units.number or Decimal(0)
            if isinstance(gains_account, str) and _in_subtree(
                posting.account, gains_account
            ):
                by_year[entry.date.year]["gains"] -= amount
            elif isinstance(dividends_account, str) and _in_subtree(
                posting.account, dividends_account
            ):
                by_year[entry.date.year]["dividends"] -= amount

    return [
        {
            "year": year,
            "gains": _money(by_year[year]["gains"]),
            "dividends": _money(by_year[year]["dividends"]),
        }
        for year in sorted(by_year)
    ]


# ------------------------------------------------------------ contributions


def _tax_year(entry: data.Transaction, posting, fallback: int) -> int:
    for meta in (getattr(posting, "meta", None), entry.meta):
        if not meta:
            continue
        raw = meta.get("tax-year")
        value = _dec(raw)
        if value is not None:
            return int(value)
    return fallback


def _explicit_amount(entry: data.Transaction, posting) -> Decimal | None:
    for meta in (getattr(posting, "meta", None), entry.meta):
        if not meta:
            continue
        value = _dec(meta.get("contribution"))
        if value is not None:
            return abs(value)
    return None


def _credited_sleeve(
    entry: data.Transaction, resolver: _SleeveResolver, operating: str
) -> tuple[str, Any] | None:
    """The sleeve a transaction pays into: the largest inbound investment leg."""
    best: tuple[Decimal, str, Any] | None = None
    for posting in entry.postings:
        if not _in_subtree(posting.account, INVESTMENT_ROOT):
            continue
        if posting.units is None or posting.units.currency != operating:
            continue
        amount = posting.units.number or Decimal(0)
        if amount <= 0:
            continue
        if best is None or amount > best[0]:
            best = (amount, resolver.of(posting.account), posting)
    return (best[1], best[2]) if best else None


def _funding_total(
    entry: data.Transaction,
    sleeve: str,
    operating: str,
    payroll_prefixes: tuple[str, ...],
) -> Decimal:
    """Sum the legs the money left, which is what counts against a limit.

    A negative leg counts when it sits on an asset or liability account outside
    the receiving sleeve, or on a payroll income account. Everything else,
    including a broker match booked to income, is ignored by construction.
    """
    total = Decimal(0)
    for posting in entry.postings:
        if posting.units is None or posting.units.currency != operating:
            continue
        amount = posting.units.number or Decimal(0)
        if amount >= 0:
            continue
        account = posting.account
        if _in_subtree(account, sleeve):
            continue
        if account.startswith(FUNDING_ROOTS) or any(
            _in_subtree(account, prefix) for prefix in payroll_prefixes
        ):
            total += -amount
    return total


def _contributions(
    *,
    entries: Iterable[data.Directive],
    asof: datetime.date,
    operating: str,
    resolver: _SleeveResolver,
    annotations: dict[str, dict],
    limit_key_order: list[str],
    ui_config: dict,
) -> list[dict]:
    payroll_prefixes = _payroll_prefixes(ui_config)
    used: dict[tuple[str, int], Decimal] = defaultdict(Decimal)

    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        credited = _credited_sleeve(entry, resolver, operating)
        if credited is None:
            continue
        sleeve, posting = credited
        limit_key = annotations.get(sleeve, {}).get("limit_key")
        if not isinstance(limit_key, str) or not limit_key:
            continue
        amount = _explicit_amount(entry, posting)
        if amount is None:
            amount = _funding_total(entry, sleeve, operating, payroll_prefixes)
        if amount <= 0:
            continue
        used[limit_key, _tax_year(entry, posting, entry.date.year)] += amount

    limits = _limits_for_year(ui_config, asof.year)
    cadences = _config_section(ui_config, "investments", "cadence")
    keys = list(limit_key_order)
    for key in sorted(set(limits) | {k for k, _ in used}):
        if key not in keys:
            keys.append(key)

    out: list[dict] = []
    for key in keys:
        amount_used = used.get((key, asof.year), Decimal(0))
        limit = limits.get(key)
        cadence = cadences.get(key) if isinstance(cadences.get(key), dict) else None
        out.append(
            {
                "key": key,
                "label": _contribution_label(key, annotations),
                "used": _money(amount_used),
                "limit": None if limit is None else _money(limit),
                "cadence": _cadence_text(cadence),
            }
        )
    return out


def _contribution_label(key: str, annotations: dict[str, dict]) -> str:
    """ "IRA (Roth + Traditional)" — built from the sleeves sharing the key."""
    treatments: list[str] = []
    for annotation in annotations.values():
        if annotation.get("limit_key") != key:
            continue
        tax = annotation.get("tax")
        if isinstance(tax, str) and tax and tax.lower() != key.lower():
            pretty = tax.replace("-", " ").title()
            if pretty not in treatments:
                treatments.append(pretty)
    base = key.upper() if len(key) <= 4 else key.replace("-", " ").title()
    if len(treatments) > 1:
        return f"{base} ({' + '.join(treatments)})"
    return base


def _cadence_text(cadence: dict | None) -> str | None:
    if not cadence:
        return None
    amount = _dec(cadence.get("amount"))
    per = cadence.get("per")
    if amount is None or not isinstance(per, str) or not per:
        return None
    formatted = (
        f"{amount:,.0f}" if amount == amount.to_integral_value() else f"{amount:,.2f}"
    )
    return f"${formatted} / {per}"


