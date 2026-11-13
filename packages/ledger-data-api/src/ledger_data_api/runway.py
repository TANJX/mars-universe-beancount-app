"""Runway simulator: per-person monthly cash and sleeve plan inputs.

The web app's /runway page projects the next N months (24 by default) for
each person: take-home pay per paycheck, monthly outflows, and the balance of
each "sleeve" (checking buffer, emergency fund, reserve, core index, IRA,
401k, HSA, gold, play). The engine runs in the browser; this module only
resolves its inputs into one JSON payload:

  config    `config/runway.yaml` beside `config/ui.yaml`. Hand-edited and
            snake_case. Lists people plus shared defaults. A person entry may
            `include:` a file elsewhere in the ledger folder (a partner's file
            under a git-crypt encrypted path, say), which is deep-merged under
            the inline keys. Each person lists its `jobs` (pay settings
            under `pay`, salary as dated steps) and `scenarios`: named
            patches over the person's own plan (runway_patch.py).
  ledger    `starting.source: ledger` fills starting balances from the ledger
            at `asof`, mapping each account to a sleeve by ordered regex rules.
            A contribution stream's `ytd_from: <account regex>` fills that
            stream's `ytd` for the `asof` year from the ledger's deposits
            (`ledger_contributions`), so a hand-typed total can't drift.

The output is camelCase (see `build_runway_data`). Errors drop a person;
warnings keep it. Balances are never logged.
"""

from __future__ import annotations

import calendar
import datetime
import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Any

import yaml
from beancount.core import data

from . import store
from .fire import _query, _usd
from .portfolio import FUNDING_ROOTS, _explicit_amount, _tax_year
from .runway_patch import apply_patch

log = logging.getLogger(__name__)

SLEEVES = (
    "checking",
    "ef",
    "reserve",
    "core",
    "ira",
    "k401",
    "hsa",
    "gold",
    "play",
    "other",
)
CASH_SLEEVES = ("checking", "ef", "reserve")
PERIODS_PER_YEAR = {"biweekly": 26, "semimonthly": 24}
STATES = ("ny", "ny_nonresident", "nj", "none")
MATCH_TYPES = ("none", "flat", "threshold", "tiered")
#: Contribution streams: one account, one tax treatment, one channel.
ACCOUNTS = ("k401", "ira", "hsa")
#: Channels an account allows; the first is its default.
CHANNELS = {"k401": ("payroll",), "hsa": ("payroll", "direct"), "ira": ("direct",)}
PACES = {
    "payroll": ("off", "fixed", "percent", "even", "front_load"),
    "direct": ("off", "fixed", "even", "lump"),
}
#: Accepted pace spellings (the old election modes and the page's names).
PACE_ALIASES = {
    "per_paycheck": "fixed",
    "max": "even",
    "max_spread": "even",
    "early": "front_load",
}
HSA_TIERS = ("self", "family", "none")
#: YAML limit key -> payload key.
LIMIT_KEYS = {"k401": "k401", "ira": "ira", "hsa_self": "hsaSelf", "hsa_family": "hsaFamily"}
GITCRYPT_MAGIC = b"\x00GITCRYPT"
DEFAULT_RETURNS = {"equity": 0.07, "reserve": 0.039, "ef": 0.0365, "gold": 0.03}
DEFAULT_STATE_STD = {"ny": 8000, "ny_nonresident": 8000, "nj": 1000, "none": 0}
DEFAULT_FEDERAL_STD = {"single": 16100, "joint": 32200}
DEFAULT_SS_WAGE_BASE = 184500
DEFAULT_MONTHS = 24
DEFAULT_LOOKAHEAD = 12
DEFAULT_PLAY_CAP = 0.10
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
STALE_STATIC_DAYS = 45


class _Ctx:
    """Collects issues for one person (or the top level, person_id None)."""

    def __init__(self, person_id: str | None, base: str = "") -> None:
        self.person_id = person_id
        self.base = base
        self.errors: list[dict] = []
        self.warnings: list[dict] = []

    def _issue(self, path: str, message: str) -> dict:
        full = f"{self.base}.{path}" if self.base and path else (self.base or path)
        return {"personId": self.person_id, "path": full, "message": message}

    def err(self, path: str, message: str) -> None:
        self.errors.append(self._issue(path, message))

    def warn(self, path: str, message: str) -> None:
        self.warnings.append(self._issue(path, message))


# ---------- small coercion helpers ----------


def _deep_merge(base: Any, over: Any) -> Any:
    """`over` wins; dicts merge recursively, everything else (lists, None)
    replaces."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = _deep_merge(base.get(k), v) if k in base else v
        return out
    return over


def _has_path(d: Any, path: tuple[str, ...]) -> bool:
    for key in path:
        if not isinstance(d, dict) or key not in d:
            return False
        d = d[key]
    return True


def _set_path(d: dict, path: tuple[str, ...], value: Any) -> None:
    for key in path[:-1]:
        d = d.setdefault(key, {})
    d[path[-1]] = value


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_jsonable(x) for x in v]
    if isinstance(v, datetime.date):
        return v.isoformat()
    return v


def _num(
    ctx: _Ctx,
    value: Any,
    path: str,
    default: float | None = None,
    minimum: float | None = None,
) -> float | None:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int | float):
        ctx.err(path, f"expected a number, got {value!r}")
        return default
    if minimum is not None and value < minimum:
        ctx.err(path, f"must be at least {minimum:g}")
        return default
    return float(value)


def _month(ctx: _Ctx, value: Any, path: str, required: bool = False) -> str | None:
    if value is None:
        if required:
            ctx.err(path, "missing month (YYYY-MM)")
        return None
    if isinstance(value, datetime.date):
        return value.strftime("%Y-%m")
    if isinstance(value, str) and MONTH_RE.match(value):
        return value
    ctx.err(path, f"expected a month as YYYY-MM, got {value!r}")
    return None


def _date(ctx: _Ctx, value: Any, path: str, required: bool = False) -> str | None:
    if value is None:
        if required:
            ctx.err(path, "missing date (YYYY-MM-DD)")
        return None
    if isinstance(value, datetime.datetime):
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return datetime.date.fromisoformat(value).isoformat()
        except ValueError:
            pass
    ctx.err(path, f"expected a date as YYYY-MM-DD, got {value!r}")
    return None


def _dict(ctx: _Ctx, value: Any, path: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        ctx.err(path, "expected a mapping")
        return {}
    return value


def _list(ctx: _Ctx, value: Any, path: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        ctx.err(path, "expected a list")
        return []
    return value


def _add_months(month: str, n: int) -> str:
    y, m = int(month[:4]), int(month[5:7])
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def _month_end(month: str) -> datetime.date:
    y, m = int(month[:4]), int(month[5:7])
    return datetime.date(y, m, calendar.monthrange(y, m)[1])


# ---------- files ----------


def runway_config_path(ledger_file_path: str) -> Path:
    return store.ui_config_path(ledger_file_path).with_name("runway.yaml")


def ledger_root(ledger_file_path: str) -> Path:
    """<ledger dir>, the parent of journal/ and config/."""
    return Path(ledger_file_path).resolve().parent.parent


def _load_yaml_file(path: Path) -> tuple[Any, str | None, str]:
    """(data, message, status) where status is ok | missing | locked | error."""
    if not path.is_file():
        return None, f"{path.name} not found", "missing"
    try:
        raw = path.read_bytes()
    except OSError as ex:
        return None, f"cannot read {path.name}: {ex.strerror}", "error"
    if raw.startswith(GITCRYPT_MAGIC):
        return None, "git-crypt encrypted; unlock the repo", "locked"
    try:
        return yaml.safe_load(raw.decode("utf-8")), None, "ok"
    except (yaml.YAMLError, UnicodeDecodeError) as ex:
        return None, f"malformed YAML: {ex}", "error"


def read_raw_config(path: Path) -> tuple[dict, list[dict]]:
    """Read config/runway.yaml. ({}, []) when absent."""
    if not path.exists():
        return {}, []
    data, message, status = _load_yaml_file(path)
    if status != "ok":
        return {}, [{"personId": None, "path": "", "message": f"runway.yaml {message}"}]
    if data is None:
        return {}, []
    if not isinstance(data, dict):
        issue = {"personId": None, "path": "", "message": "runway.yaml must be a mapping"}
        return {}, [issue]
    return data, []


def resolve_include(root: Path, rel: Any) -> tuple[dict | None, str | None, str]:
    """Load an included person file relative to the ledger root.

    Returns (mapping, message, status), status one of ok | missing | locked |
    error. Absolute paths and anything that resolves outside `root` (`..`,
    or a symlink pointing elsewhere: `resolve()` follows it first) are
    rejected.
    """
    if not isinstance(rel, str) or not rel.strip():
        return None, "include must be a relative path", "error"
    if Path(rel).is_absolute():
        return None, f"include {rel} must be relative to the ledger folder", "error"
    if not rel.endswith((".yaml", ".yml")):
        return None, f"include {rel} must be a .yaml file", "error"
    root = root.resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        return None, f"include {rel} points outside the ledger folder", "error"
    data, message, status = _load_yaml_file(target)
    if status != "ok":
        return None, f"{rel}: {message}", status
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, f"{rel} must hold one person mapping", "error"
    if "include" in data or "file" in data:
        return None, f"{rel} may not include another file", "error"
    return data, None, "ok"


# ---------- ledger balances ----------


def ledger_positions(ledger, entries, asof: datetime.date) -> list[tuple[str, str, float]]:
    """(account, currency, usd market value) for every Assets/Liabilities
    position at `asof`. Rows under half a cent are dropped."""
    rows = _query(
        ledger,
        entries,
        "SELECT account, currency, convert(value(sum(position)), 'USD') AS usd "
        f"WHERE account ~ '^(Assets|Liabilities)' AND date <= {asof.isoformat()} "
        "GROUP BY account, currency",
    )
    out = []
    for account, currency, inv in rows:
        usd = float(_usd(inv))
        if abs(usd) >= 0.005:
            out.append((str(account), str(currency), usd))
    return sorted(out)


def ledger_contributions(entries, pattern: str, asof: datetime.date) -> dict[str, float]:
    """Contributions into accounts matching `pattern`, by tax year, up to `asof`.

    A transaction counts when it moves USD into a matching account: its largest
    inbound USD leg there is the deposit. The amount is the transaction's (or
    that posting's) `contribution:` metadata, which leaves a broker match out;
    without it, the USD that left asset or liability accounts outside the
    pattern. The tax year is `tax-year:` metadata, else the deposit's year, so a
    January deposit for last year counts toward last year.
    """
    rx = re.compile(pattern)
    by_year: dict[str, float] = {}
    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > asof:
            continue
        deposit = None
        for posting in entry.postings:
            units = posting.units
            if units is None or units.currency != "USD" or not rx.search(posting.account):
                continue
            if units.number > 0 and (deposit is None or units.number > deposit.units.number):
                deposit = posting
        if deposit is None:
            continue
        amount = _explicit_amount(entry, deposit)
        if amount is None:
            amount = sum(
                (
                    -p.units.number
                    for p in entry.postings
                    if p.units is not None
                    and p.units.currency == "USD"
                    and p.units.number < 0
                    and p.account.startswith(FUNDING_ROOTS)
                    and not rx.search(p.account)
                ),
                start=0,
            )
        if amount <= 0:
            continue
        year = str(_tax_year(entry, deposit, entry.date.year))
        by_year[year] = round(by_year.get(year, 0.0) + float(amount), 2)
    return by_year


def fill_ledger_ytd(ctx: _Ctx, contributions: list[dict], asof: datetime.date, contributions_fn) -> None:
    """Set `ytd[asof year]` from the ledger on every stream with `ytdFrom`.

    The filled years are listed in `ytdLedger` so a save writes `ytd_from`
    back instead of the number. A hand-written `ytd` for the same year loses,
    with a warning when it disagrees.
    """
    year = str(asof.year)
    for i, c in enumerate(contributions):
        pattern = c.get("ytdFrom")
        if not pattern:
            continue
        if contributions_fn is None:
            continue
        amount = contributions_fn(pattern).get(year, 0.0)
        hand = c["ytd"].get(year)
        if hand is not None and abs(hand - amount) >= 0.005:
            ctx.warn(
                f"contributions[{i}].ytd.{year}",
                f"ytd {year} is {hand:,.2f} here but {amount:,.2f} in the ledger (ytd_from); using the ledger",
            )
        c["ytd"] = {**c["ytd"], year: amount}
        c["ytdLedger"] = {year: amount}


def map_sleeves(
    rules: list[tuple[str, Any]],
    cards_re: Any,
    loans_re: Any,
    positions: list[tuple[str, str, float]],
) -> dict:
    """Bucket ledger positions into sleeves.

    `rules` is an ordered list of (sleeve, regex); the first regex that
    matches the full account name wins. Rows matching `cards_re` or
    `loans_re` are summed and negated (so an owed balance is positive) before
    rules are tried. Anything left is `unmapped` and stays out of net worth.
    """
    compiled = [(sleeve, re.compile(pattern)) for sleeve, pattern in rules]
    cards_p = re.compile(cards_re) if cards_re else None
    loans_p = re.compile(loans_re) if loans_re else None
    sleeves = {k: 0.0 for k in SLEEVES}
    cards = loans = 0.0
    accounts: list[dict] = []
    unmapped: list[dict] = []
    for account, currency, usd in positions:
        if cards_p and cards_p.search(account):
            cards -= usd
            continue
        if loans_p and loans_p.search(account):
            loans -= usd
            continue
        for sleeve, pattern in compiled:
            if pattern.search(account):
                sleeves[sleeve] += usd
                accounts.append(
                    {"account": account, "currency": currency, "sleeve": sleeve, "usd": round(usd, 2)}
                )
                break
        else:
            unmapped.append({"account": account, "currency": currency, "usd": round(usd, 2)})
    return {
        "sleeves": {k: round(v, 2) for k, v in sleeves.items()},
        "cards": round(cards, 2),
        "loans": round(loans, 2),
        "accounts": accounts,
        "unmapped": unmapped,
    }


# ---------- person normalization ----------


def _norm_schedule(ctx: _Ctx, raw: Any, path: str) -> dict | None:
    raw = _dict(ctx, raw, path)
    freq = raw.get("frequency")
    if freq not in PERIODS_PER_YEAR:
        ctx.err(f"{path}.frequency", f"unknown pay frequency {freq!r} (biweekly | semimonthly)")
        return None
    anchor = None
    days: list[int] = []
    if freq == "biweekly":
        anchor = _date(ctx, raw.get("anchor"), f"{path}.anchor", required=True)
        if anchor is None:
            return None
    else:
        days_raw = raw.get("days")
        if not isinstance(days_raw, list) or not days_raw:
            ctx.err(f"{path}.days", "semimonthly schedule needs `days`, e.g. [15, -1]")
            return None
        for i, d in enumerate(days_raw):
            if isinstance(d, bool) or not isinstance(d, int) or not (d == -1 or 1 <= d <= 31):
                ctx.err(f"{path}.days[{i}]", f"pay day must be 1..31 or -1, got {d!r}")
                return None
            days.append(d)
    return {"frequency": freq, "anchor": anchor, "days": days}


def _norm_deductions(ctx: _Ctx, raw: Any, path: str) -> list[dict]:
    out = []
    for i, d in enumerate(_list(ctx, raw, path)):
        p = f"{path}[{i}]"
        if not isinstance(d, dict):
            ctx.err(p, "expected a mapping")
            continue
        per = d.get("per", "paycheck")
        if per not in ("paycheck", "month"):
            ctx.err(f"{p}.per", f"per must be paycheck or month, got {per!r}")
            continue
        sleeve = d.get("sleeve")
        if sleeve is not None and sleeve not in SLEEVES:
            ctx.err(f"{p}.sleeve", f"unknown sleeve {sleeve!r}")
            continue
        pretax = bool(d.get("pretax", False))
        paycheck = d.get("paycheck")
        if per == "month":
            if paycheck is None:
                paycheck = 1
            elif isinstance(paycheck, bool) or not isinstance(paycheck, int) or paycheck < 1:
                ctx.err(f"{p}.paycheck", "paycheck must be a 1-based integer")
                continue
        else:
            paycheck = None
        out.append(
            {
                "label": str(d.get("label") or f"Deduction {i + 1}"),
                "amount": _num(ctx, d.get("amount"), f"{p}.amount", 0.0, minimum=0),
                "per": per,
                "paycheckOfMonth": paycheck,
                "pretax": pretax,
                "ficaExempt": bool(d.get("fica_exempt", pretax)),
                "sleeve": sleeve,
            }
        )
    return out


def _norm_withholding(ctx: _Ctx, raw: Any, path: str) -> dict:
    raw = _dict(ctx, raw, path)
    filing = raw.get("filing", "single")
    if filing not in DEFAULT_FEDERAL_STD:
        ctx.err(f"{path}.filing", f"filing must be single or joint, got {filing!r}")
        filing = "single"
    state = raw.get("state", "none")
    if state not in STATES:
        ctx.err(f"{path}.state", f"unknown state {state!r} ({' | '.join(STATES)})")
        state = "none"
    sp = _dict(ctx, raw.get("state_payroll"), f"{path}.state_payroll")
    cap = _num(ctx, sp.get("annual_cap"), f"{path}.state_payroll.annual_cap", None, minimum=0)
    ytd_raw = _dict(ctx, sp.get("ytd"), f"{path}.state_payroll.ytd")
    ytd = {
        str(y): _num(ctx, v, f"{path}.state_payroll.ytd.{y}", 0.0, minimum=0)
        for y, v in ytd_raw.items()
    }
    return {
        "filing": filing,
        "federalStd": _num(
            ctx, raw.get("federal_std"), f"{path}.federal_std", DEFAULT_FEDERAL_STD[filing], 0
        ),
        "state": state,
        "stateStd": _num(
            ctx, raw.get("state_std"), f"{path}.state_std", DEFAULT_STATE_STD[state], 0
        ),
        "statePayroll": {
            "flatPerPaycheck": _num(
                ctx, sp.get("flat_per_paycheck"), f"{path}.state_payroll.flat_per_paycheck", 0.0, 0
            ),
            "rate": _num(ctx, sp.get("rate"), f"{path}.state_payroll.rate", 0.0, 0),
            "annualCap": cap,
            "ytd": ytd,
        },
        "ssWageBase": _num(
            ctx, raw.get("ss_wage_base"), f"{path}.ss_wage_base", DEFAULT_SS_WAGE_BASE, 0
        ),
    }


def _norm_match(ctx: _Ctx, raw: Any, path: str) -> dict:
    if raw is None:
        return {"type": "none"}
    raw = _dict(ctx, raw, path)
    kind = raw.get("type", "none")
    if kind not in MATCH_TYPES:
        ctx.err(f"{path}.type", f"unknown match type {kind!r} ({' | '.join(MATCH_TYPES)})")
        return {"type": "none"}
    if kind == "flat":
        return {"type": "flat", "pct": _num(ctx, raw.get("pct"), f"{path}.pct", 0.0, 0)}
    if kind == "threshold":
        return {
            "type": "threshold",
            "minPct": _num(ctx, raw.get("min_pct"), f"{path}.min_pct", 0.0, 0),
            "pct": _num(ctx, raw.get("pct"), f"{path}.pct", 0.0, 0),
        }
    if kind == "tiered":
        tiers = []
        for i, t in enumerate(_list(ctx, raw.get("tiers"), f"{path}.tiers")):
            if not isinstance(t, dict):
                ctx.err(f"{path}.tiers[{i}]", "expected a mapping")
                continue
            tiers.append(
                {
                    "rate": _num(ctx, t.get("rate"), f"{path}.tiers[{i}].rate", 0.0, 0),
                    "upToPct": _num(ctx, t.get("up_to_pct"), f"{path}.tiers[{i}].up_to_pct", 0.0, 0),
                }
            )
        return {"type": "tiered", "tiers": tiers}
    return {"type": "none"}


def _month_of_year(ctx: _Ctx, value: Any, path: str, default: int = 1) -> int | None:
    value = default if value is None else value
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 12:
        ctx.err(path, f"month must be 1..12, got {value!r}")
        return None
    return value


def _enabled(ctx: _Ctx, value: Any, path: str) -> bool:
    if value is None:
        return True
    if not isinstance(value, bool):
        ctx.err(path, "enabled must be true or false")
        return True
    return value


def _note(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


def _norm_pay(ctx: _Ctx, raw: Any, path: str) -> dict:
    """Person-level pay settings every job uses unless it overrides them."""
    raw = _dict(ctx, raw, path)
    return {
        "schedule": (
            _norm_schedule(ctx, raw["schedule"], f"{path}.schedule")
            if raw.get("schedule") is not None
            else None
        ),
        "deductions": _norm_deductions(ctx, raw.get("deductions"), f"{path}.deductions"),
        "withholding": _norm_withholding(ctx, raw.get("withholding"), f"{path}.withholding"),
    }


def _norm_salary(ctx: _Ctx, raw: Any, path: str) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for i, s in enumerate(_list(ctx, raw, path)):
        p = f"{path}[{i}]"
        if not isinstance(s, dict):
            ctx.err(p, "expected a mapping")
            continue
        start = _month(ctx, s.get("from"), f"{p}.from", required=True)
        if start is None:
            continue
        if start in seen:
            ctx.err(f"{p}.from", f"another salary step already starts {start}")
            continue
        seen.add(start)
        if s.get("gross") is None:
            ctx.err(f"{p}.gross", "missing gross (annual salary)")
            continue
        out.append(
            {
                "from": start,
                "gross": _num(ctx, s.get("gross"), f"{p}.gross", 0.0, minimum=0),
                "enabled": _enabled(ctx, s.get("enabled"), f"{p}.enabled"),
                "note": _note(s.get("note")),
            }
        )
    return sorted(out, key=lambda s: s["from"])


def _norm_job(ctx: _Ctx, raw: Any, path: str, index: int, horizon_start: str) -> dict | None:
    """One entry of `jobs`. Pay settings (schedule, deductions, withholding)
    are null unless the job overrides the person's `pay`."""
    if not isinstance(raw, dict):
        ctx.err(path, "expected a mapping")
        return None
    start = _month(ctx, raw.get("start"), f"{path}.start")
    leave = _month(ctx, raw.get("leave"), f"{path}.leave")
    if start and leave and leave < start:
        ctx.err(f"{path}.leave", "leave is before start")
    vesting = None
    if raw.get("vesting") is not None:
        v = _dict(ctx, raw["vesting"], f"{path}.vesting")
        vesting = {
            "date": _date(ctx, v.get("date"), f"{path}.vesting.date", required=True),
            "unvestedStart": _num(ctx, v.get("unvested_start"), f"{path}.vesting.unvested_start", 0.0, 0),
        }
    hsa_employer = None
    if raw.get("hsa_employer") is not None:
        he = _dict(ctx, raw["hsa_employer"], f"{path}.hsa_employer")
        month = _month_of_year(ctx, he.get("month"), f"{path}.hsa_employer.month")
        if month is not None:
            hsa_employer = {
                "amount": _num(ctx, he.get("amount"), f"{path}.hsa_employer.amount", 0.0, 0),
                "month": month,
            }
    salary = _norm_salary(ctx, raw.get("salary"), f"{path}.salary")
    enabled = _enabled(ctx, raw.get("enabled"), f"{path}.enabled")
    on = [s for s in salary if s["enabled"]]
    if enabled and not on:
        ctx.warn(f"{path}.salary", "no enabled salary step: this job pays nothing")
    elif enabled and on[0]["from"] > max(start or "", horizon_start):
        ctx.warn(f"{path}.salary", f"the first salary step starts {on[0]['from']}; nothing is paid before it")
    return {
        "id": str(raw.get("id") or f"job-{index + 1}"),
        "employer": str(raw.get("employer") or f"Job {index + 1}"),
        "start": start,
        "leave": leave,
        "enabled": enabled,
        "note": _note(raw.get("note")),
        "salary": salary,
        "match": _norm_match(ctx, raw.get("match"), f"{path}.match"),
        "vesting": vesting,
        "hsaEmployer": hsa_employer,
        "schedule": (
            _norm_schedule(ctx, raw["schedule"], f"{path}.schedule")
            if raw.get("schedule") is not None
            else None
        ),
        "deductions": (
            _norm_deductions(ctx, raw["deductions"], f"{path}.deductions")
            if raw.get("deductions") is not None
            else None
        ),
        "withholding": (
            _norm_withholding(ctx, raw["withholding"], f"{path}.withholding")
            if raw.get("withholding") is not None
            else None
        ),
    }


def _norm_jobs(ctx: _Ctx, raw: Any, path: str, pay: dict, horizon_start: str) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for i, j in enumerate(_list(ctx, raw, path)):
        job = _norm_job(ctx, j, f"{path}[{i}]", i, horizon_start)
        if job is None:
            continue
        if job["id"] in seen:
            ctx.err(f"{path}[{i}].id", f"duplicate job id {job['id']!r}")
            continue
        seen.add(job["id"])
        if job["enabled"] and job["schedule"] is None and pay["schedule"] is None:
            ctx.err("pay.schedule", f"job {job['id']!r} has no pay schedule; set pay.schedule")
        out.append(job)
    return out


def _norm_phase(ctx: _Ctx, e: Any, p: str, channel: str) -> dict | None:
    if not isinstance(e, dict):
        ctx.err(p, "expected a mapping")
        return None
    raw_pace = e.get("pace")
    if raw_pace is False:  # YAML reads a bare `off` as a boolean
        raw_pace = "off"
    pace = PACE_ALIASES.get(raw_pace, raw_pace)
    if pace not in PACES[channel]:
        ctx.err(f"{p}.pace", f"unknown pace {raw_pace!r} for a {channel} stream ({' | '.join(PACES[channel])})")
        return None
    start = _month(ctx, e.get("from"), f"{p}.from", required=True)
    if start is None:
        return None
    out: dict = {"from": start, "pace": pace}
    if pace == "fixed":
        per = "month" if channel == "direct" else e.get("per", "paycheck")
        if per not in ("paycheck", "month"):
            ctx.err(f"{p}.per", f"per must be paycheck or month, got {per!r}")
            return None
        paycheck = None
        if per == "month" and channel == "payroll":
            paycheck = e.get("paycheck", 1)
            if isinstance(paycheck, bool) or not isinstance(paycheck, int) or paycheck < 1:
                ctx.err(f"{p}.paycheck", "paycheck must be a 1-based integer")
                return None
        out.update(
            amount=_num(ctx, e.get("amount"), f"{p}.amount", 0.0, 0),
            per=per,
            paycheckOfMonth=paycheck,
        )
    elif pace == "percent":
        out["pct"] = _num(ctx, e.get("pct"), f"{p}.pct", 0.0, 0)
    elif pace in ("even", "front_load"):
        share = _num(ctx, e.get("share"), f"{p}.share", 1.0, 0)
        if share > 1:
            ctx.err(f"{p}.share", "share must be between 0 and 1")
            share = 1.0
        out.update(share=share, capPct=_num(ctx, e.get("cap_pct"), f"{p}.cap_pct", 1.0, 0))
    elif pace == "lump":
        month = e.get("month", 1)
        if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
            ctx.err(f"{p}.month", f"month must be 1..12, got {month!r}")
            return None
        amount = e.get("amount")
        out.update(
            month=month,
            # `max` (or nothing) deposits whatever room the limit leaves.
            amount=None if amount in (None, "max") else _num(ctx, amount, f"{p}.amount", 0.0, 0),
        )
    return out


def _norm_contributions(ctx: _Ctx, raw: Any, path: str) -> list[dict]:
    """Contribution streams: {id, account, tax, channel, ytd, schedule}."""
    out: list[dict] = []
    seen: set[str] = set()
    for i, c in enumerate(_list(ctx, raw, path)):
        p = f"{path}[{i}]"
        if not isinstance(c, dict):
            ctx.err(p, "expected a mapping")
            continue
        account = c.get("account")
        if account not in ACCOUNTS:
            ctx.err(f"{p}.account", f"unknown account {account!r} ({' | '.join(ACCOUNTS)})")
            continue
        channel = c.get("channel", CHANNELS[account][0])
        if channel not in CHANNELS[account]:
            ctx.err(f"{p}.channel", f"a {account} stream must be {' or '.join(CHANNELS[account])}")
            continue
        tax = c.get("tax", "traditional")
        if tax not in ("traditional", "roth") or (account == "hsa" and tax != "traditional"):
            ctx.err(f"{p}.tax", f"tax must be traditional or roth (an HSA has none), got {tax!r}")
            continue
        default_id = f"hsa-{channel}" if account == "hsa" else f"{account}-{tax}"
        cid = str(c.get("id") or default_id)
        if cid in seen:
            ctx.err(f"{p}.id", f"duplicate contribution id {cid!r}")
            continue
        seen.add(cid)
        ytd = {
            str(y): _num(ctx, v, f"{p}.ytd.{y}", 0.0, 0)
            for y, v in _dict(ctx, c.get("ytd"), f"{p}.ytd").items()
        }
        ytd_from = c.get("ytd_from")
        if ytd_from is not None:
            try:
                if not isinstance(ytd_from, str) or not ytd_from:
                    raise re.error("not a string")
                re.compile(ytd_from)
            except re.error:
                ctx.err(f"{p}.ytd_from", f"ytd_from must be an account regex, got {ytd_from!r}")
                ytd_from = None
        schedule = []
        starts: set[str] = set()
        for j, e in enumerate(_list(ctx, c.get("schedule"), f"{p}.schedule")):
            phase = _norm_phase(ctx, e, f"{p}.schedule[{j}]", channel)
            if phase is None:
                continue
            if phase["from"] in starts:
                ctx.err(f"{p}.schedule[{j}].from", f"another change already starts {phase['from']}")
                continue
            starts.add(phase["from"])
            schedule.append(phase)
        out.append(
            {
                "id": cid,
                "account": account,
                "tax": tax,
                "channel": channel,
                "ytd": ytd,
                **({"ytdFrom": ytd_from} if ytd_from else {}),
                "schedule": sorted(schedule, key=lambda e: e["from"]),
            }
        )
    return out


def _norm_hsa_coverage(ctx: _Ctx, raw: Any, path: str) -> list[dict]:
    """HDHP coverage on the first of each month: [{from, tier}]."""
    out = []
    for i, e in enumerate(_list(ctx, raw, path)):
        p = f"{path}[{i}]"
        if not isinstance(e, dict):
            ctx.err(p, "expected a mapping")
            continue
        tier = e.get("tier")
        if tier not in HSA_TIERS:
            ctx.err(f"{p}.tier", f"tier must be one of {' | '.join(HSA_TIERS)}, got {tier!r}")
            continue
        start = _month(ctx, e.get("from"), f"{p}.from", required=True)
        if start:
            out.append({"from": start, "tier": tier})
    return sorted(out, key=lambda e: e["from"])


def _norm_year_limits(ctx: _Ctx, raw: Any, path: str) -> dict[str, dict[str, float]]:
    """`limits: { 2026: { k401, ira, hsa_self, hsa_family } }`. Only what the
    config gives; the page fills the rest from its bundled IRS table."""
    out: dict[str, dict[str, float]] = {}
    for y, row in _dict(ctx, raw, path).items():
        row = _dict(ctx, row, f"{path}.{y}")
        vals = {}
        for key, value in row.items():
            if key not in LIMIT_KEYS:
                ctx.err(f"{path}.{y}.{key}", f"unknown limit {key!r} ({' | '.join(LIMIT_KEYS)})")
                continue
            vals[LIMIT_KEYS[key]] = _num(ctx, value, f"{path}.{y}.{key}", 0.0, 0)
        out[str(y)] = vals
    return dict(sorted(out.items()))


def _horizon_years(start: str, months: int) -> list[str]:
    end = _add_months(start, months - 1)
    return [str(y) for y in range(int(start[:4]), int(end[:4]) + 1)]


def _norm_starting(
    ctx: _Ctx,
    raw: Any,
    path: str,
    asof: datetime.date,
    positions_fn,
) -> dict | None:
    raw = _dict(ctx, raw, path)
    source = raw.get("source", "static")
    unvested = _num(ctx, raw.get("unvested"), f"{path}.unvested", 0.0, 0)
    if source == "static":
        balances_raw = _dict(ctx, raw.get("balances"), f"{path}.balances")
        sleeves = {k: 0.0 for k in SLEEVES}
        for k, v in balances_raw.items():
            if k not in SLEEVES:
                ctx.err(f"{path}.balances.{k}", f"unknown sleeve {k!r}")
                continue
            n = _num(ctx, v, f"{path}.balances.{k}", 0.0)
            sleeves[k] = n
            if n < 0:
                ctx.warn(f"{path}.balances.{k}", "negative starting balance")
        bal_asof = _date(ctx, raw.get("asof") or raw.get("balances_asof"), f"{path}.asof")
        if bal_asof and (asof - datetime.date.fromisoformat(bal_asof)).days > STALE_STATIC_DAYS:
            ctx.warn(f"{path}.asof", f"static balances are from {bal_asof}; refresh them")
        return {
            "source": "static",
            "asof": bal_asof or asof.isoformat(),
            "sleeves": sleeves,
            "cards": _num(ctx, raw.get("cards"), f"{path}.cards", 0.0),
            "loans": _num(ctx, raw.get("loans"), f"{path}.loans", 0.0),
            "unvested": unvested,
            "accounts": [],
            "unmapped": [],
        }
    if source != "ledger":
        ctx.err(f"{path}.source", f"starting.source must be ledger or static, got {source!r}")
        return None
    rules: list[tuple[str, re.Pattern]] = []
    ok = True
    for i, r in enumerate(_list(ctx, raw.get("rules"), f"{path}.rules")):
        p = f"{path}.rules[{i}]"
        if not isinstance(r, dict):
            ctx.err(p, "expected a mapping")
            ok = False
            continue
        sleeve = r.get("sleeve")
        if sleeve not in SLEEVES:
            ctx.err(f"{p}.sleeve", f"unknown sleeve {sleeve!r}")
            ok = False
            continue
        try:
            rules.append((sleeve, re.compile(str(r.get("accounts") or ""))))
        except re.error as ex:
            ctx.err(f"{p}.accounts", f"bad regex: {ex}")
            ok = False
    patterns: dict[str, re.Pattern | None] = {}
    for key in ("cards", "loans"):
        value = raw.get(key)
        patterns[key] = None
        if value is None:
            continue
        try:
            patterns[key] = re.compile(str(value))
        except re.error as ex:
            ctx.err(f"{path}.{key}", f"bad regex: {ex}")
            ok = False
    if not ok:
        return None
    mapped = map_sleeves(rules, patterns["cards"], patterns["loans"], positions_fn())
    if not mapped["accounts"]:
        ctx.warn(f"{path}.rules", "no ledger account matched any sleeve rule")
    if mapped["unmapped"]:
        n = len(mapped["unmapped"])
        ctx.warn(
            f"{path}.rules",
            (
                "1 ledger position matches no sleeve rule and stays out of net worth"
                if n == 1
                else f"{n} ledger positions match no sleeve rule and stay out of net worth"
            ),
        )
    return {
        "source": "ledger",
        "asof": asof.isoformat(),
        **mapped,
        "unvested": unvested,
    }


def _norm_cash(ctx: _Ctx, raw: Any, path: str) -> dict:
    raw = _dict(ctx, raw, path)
    earmarks = []
    for i, e in enumerate(_list(ctx, raw.get("earmarks"), f"{path}.earmarks")):
        if not isinstance(e, dict):
            ctx.err(f"{path}.earmarks[{i}]", "expected a mapping")
            continue
        earmarks.append(
            {
                "label": str(e.get("label") or f"Earmark {i + 1}"),
                "amount": _num(ctx, e.get("amount"), f"{path}.earmarks[{i}].amount", 0.0, 0),
            }
        )
    payoff_raw = raw.get("card_payoff")
    payoff: dict[str, float] = {}
    if payoff_raw is None:
        payoff = {"checking": 1.0}
    else:
        for k, v in _dict(ctx, payoff_raw, f"{path}.card_payoff").items():
            if k not in CASH_SLEEVES:
                ctx.err(f"{path}.card_payoff.{k}", f"card payoff sleeve must be one of {CASH_SLEEVES}")
                continue
            payoff[k] = _num(ctx, v, f"{path}.card_payoff.{k}", 0.0, 0)
        if payoff and abs(sum(payoff.values()) - 1) > 1e-6:
            ctx.err(f"{path}.card_payoff", "card_payoff shares must sum to 1")
    dca = raw.get("dca_months", 12)
    if isinstance(dca, bool) or not isinstance(dca, int) or dca < 1:
        ctx.err(f"{path}.dca_months", "dca_months must be a whole number of at least 1")
        dca = 12
    return {
        "buffer": _num(ctx, raw.get("buffer"), f"{path}.buffer", 0.0, 0),
        "efMonths": _num(ctx, raw.get("ef_months"), f"{path}.ef_months", 6.0, 0),
        "earmarks": earmarks,
        "dcaMonths": dca,
        "cardPayoff": payoff,
    }


#: Keys of the old schema, with what replaced them.
LEGACY_KEYS = {
    "job": "`job:` became `jobs:` (a list) plus `pay:`; see runway.example.yaml",
    "k401": "`k401:` became `contributions:` streams",
    "ira": "`ira:` became an `ira` stream in `contributions:`",
    "k401_limits": "`k401_limits:` became `limits: { <year>: { k401: ... } }`",
}
#: Settings `defaults:` shares with every person. A person may override any of
#: them; `overrides` in the payload lists the leaves a person sets itself.
SHARED_KEYS = ("returns", "limits", "play_cap", "spread_through")
#: Person keys that are not part of the editable plan body.
_NOT_BODY = ("scenarios", "starting", "sleeve_info", "not_modeled", "include", "file")


def _norm_spread(ctx: _Ctx, value: Any, path: str) -> str:
    value = "year_end" if value is None else value
    if value not in ("horizon", "year_end"):
        ctx.err(path, "spread_through must be horizon or year_end")
        return "year_end"
    return value


def _norm_returns(ctx: _Ctx, raw: Any, path: str) -> dict:
    raw = _dict(ctx, raw, path)
    return {k: _num(ctx, raw.get(k), f"{path}.{k}", d) for k, d in DEFAULT_RETURNS.items()}


def norm_shared(ctx: _Ctx, defaults: dict) -> dict:
    """The shared `defaults:` settings, normalized like a person's."""
    return {
        "returns": _norm_returns(ctx, defaults.get("returns"), "defaults.returns"),
        "limits": _norm_year_limits(ctx, defaults.get("limits"), "defaults.limits"),
        "playCap": _num(ctx, defaults.get("play_cap"), "defaults.play_cap", DEFAULT_PLAY_CAP, 0),
        "spreadThrough": _norm_spread(ctx, defaults.get("spread_through"), "defaults.spread_through"),
    }


def person_overrides(raw: dict) -> list[str]:
    """Dotted paths of the shared settings a person mapping sets itself."""
    out: list[str] = []
    if isinstance(raw.get("returns"), dict):
        out += [f"returns.{k}" for k in raw["returns"] if k in DEFAULT_RETURNS]
    if isinstance(raw.get("limits"), dict):
        for y, row in raw["limits"].items():
            if isinstance(row, dict):
                out += [f"limits.{y}.{LIMIT_KEYS[k]}" for k in row if k in LIMIT_KEYS]
    out += [k for k in ("play_cap", "spread_through") if raw.get(k) is not None]
    return [{"play_cap": "playCap", "spread_through": "spreadThrough"}.get(p, p) for p in out]


def _resolve_body(ctx: _Ctx, merged: dict, horizon: dict) -> dict:
    """The editable plan of one person (or one scenario of a person):
    everything except starting balances, scenarios and display text."""
    birth_year = merged.get("birth_year")
    if birth_year is not None and (isinstance(birth_year, bool) or not isinstance(birth_year, int)):
        ctx.err("birth_year", f"birth_year must be a year, got {birth_year!r}")
        birth_year = None
    pay = _norm_pay(ctx, merged.get("pay"), "pay")
    jobs = _norm_jobs(ctx, merged.get("jobs"), "jobs", pay, horizon["start"])
    contributions = _norm_contributions(ctx, merged.get("contributions"), "contributions")
    if any(c["account"] == "hsa" for c in contributions):
        lists = [("pay.deductions", pay["deductions"])] + [
            (f"jobs[{i}].deductions", j["deductions"] or []) for i, j in enumerate(jobs)
        ]
        for path, deductions in lists:
            for i, d in enumerate(deductions):
                if d["sleeve"] == "hsa":
                    ctx.err(f"{path}[{i}]", "HSA is set in both contributions and a paycheck deduction; keep one")

    spending = _dict(ctx, merged.get("spending"), "spending")
    spend_monthly = _num(ctx, spending.get("monthly"), "spending.monthly", None, 0)
    if spend_monthly is None:
        ctx.err("spending.monthly", "missing monthly spending")

    one_offs = []
    for i, o in enumerate(_list(ctx, merged.get("one_offs"), "one_offs")):
        if not isinstance(o, dict):
            ctx.err(f"one_offs[{i}]", "expected a mapping")
            continue
        month = _month(ctx, o.get("month"), f"one_offs[{i}].month", required=True)
        if month:
            item = {
                "month": month,
                "amount": _num(ctx, o.get("amount"), f"one_offs[{i}].amount", 0.0),
                "label": str(o.get("label") or "One-off"),
            }
            if o.get("id") is not None:
                item = {"id": str(o["id"]), **item}
            one_offs.append(item)

    return {
        "label": str(merged.get("label") or merged.get("name") or merged.get("id")),
        "birthYear": birth_year,
        "pay": pay,
        "jobs": jobs,
        "contributions": contributions,
        "limits": _norm_year_limits(ctx, merged.get("limits"), "limits"),
        "hsaCoverage": _norm_hsa_coverage(ctx, merged.get("hsa_coverage"), "hsa_coverage"),
        "spendingMonthly": spend_monthly,
        "oneOffs": sorted(one_offs, key=lambda o: o["month"]),
        "cash": _norm_cash(ctx, merged.get("cash"), "cash"),
        "returns": _norm_returns(ctx, merged.get("returns"), "returns"),
        "playCap": _num(ctx, merged.get("play_cap"), "play_cap", DEFAULT_PLAY_CAP, 0),
        "spreadThrough": _norm_spread(ctx, merged.get("spread_through"), "spread_through"),
    }


def _scenario_list(ctx: _Ctx, raw: Any) -> list[tuple[int, str, str, dict]]:
    """(index, id, label, patch) per valid entry of `scenarios`."""
    out = []
    seen: set[str] = {"plan"}
    for i, s in enumerate(_list(ctx, raw, "scenarios")):
        p = f"scenarios[{i}]"
        if not isinstance(s, dict):
            ctx.err(p, "expected a mapping")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            ctx.err(f"{p}.id", "missing scenario id")
            continue
        if sid in seen:
            ctx.err(f"{p}.id", f"duplicate scenario id {sid!r} (`plan` is the base)")
            continue
        seen.add(sid)
        if "job" in s or "start" in s:
            ctx.err(p, "scenario `job:`/`start:` became `patch: { jobs: [...] }`; see runway.example.yaml")
            continue
        patch = s.get("patch") or {}
        if not isinstance(patch, dict):
            ctx.err(f"{p}.patch", "expected a mapping")
            continue
        bad = [k for k in patch if k in _NOT_BODY or k == "id"]
        if bad:
            ctx.err(f"{p}.patch", f"a scenario cannot change {', '.join(map(str, bad))}")
            continue
        out.append((i, sid, str(s.get("label") or sid), patch))
    return out


def resolve_person(
    raw: dict,
    *,
    index: int,
    defaults: dict,
    horizon: dict,
    positions_fn,
    contributions_fn=None,
) -> tuple[dict | None, list[dict], list[dict]]:
    """Normalize one merged person mapping (include already applied).

    Merge order: defaults < the person mapping; each scenario's patch is then
    applied over that merge. Returns (person or None, errors, warnings). A
    broken scenario reports errors but keeps the person.
    """
    pid = raw.get("id")
    ctx = _Ctx(pid if isinstance(pid, str) else None, f"people[{index}]")
    if not isinstance(pid, str) or not pid:
        ctx.err("id", "missing person id")
        return None, ctx.errors, ctx.warnings
    for key, why in LEGACY_KEYS.items():
        if key in raw:
            ctx.err(key, why)
    if ctx.errors:
        return None, ctx.errors, ctx.warnings

    asof = datetime.date.fromisoformat(horizon["asof"])
    merged = _deep_merge(defaults, {k: v for k, v in raw.items() if k != "scenarios"})
    body = _resolve_body(ctx, merged, horizon)
    fill_ledger_ytd(ctx, body["contributions"], asof, contributions_fn)
    starting = _norm_starting(ctx, merged.get("starting"), "starting", asof, positions_fn)
    if ctx.errors or starting is None:
        return None, ctx.errors, ctx.warnings

    earmark_total = sum(e["amount"] for e in body["cash"]["earmarks"])
    if earmark_total > starting["sleeves"]["reserve"]:
        ctx.warn("cash.earmarks", "earmarks are larger than the starting reserve")

    plan_body = {k: v for k, v in merged.items() if k not in _NOT_BODY}
    scenarios: list[dict] = []
    errors = list(ctx.errors)
    warnings = list(ctx.warnings)
    for i, sid, label, patch in _scenario_list(ctx, raw.get("scenarios")):
        sctx = _Ctx(pid, f"{ctx.base}.scenarios[{i}].patch")
        sbody = _resolve_body(sctx, apply_patch(plan_body, patch), horizon)
        fill_ledger_ytd(sctx, sbody["contributions"], asof, contributions_fn)
        errors += sctx.errors
        # Skip warnings the base already reported for the same field.
        base_known = {(w["path"], w["message"]) for w in ctx.warnings}
        warnings += [
            w
            for w in sctx.warnings
            if (w["path"].replace(sctx.base, ctx.base, 1), w["message"]) not in base_known
        ]
        if not sctx.errors:
            scenarios.append({"id": sid, "label": label, "person": sbody})
    errors += [e for e in ctx.errors if e not in errors]

    person = {
        "id": pid,
        **body,
        "name": body["label"],
        "status": "ok",
        "overrides": person_overrides(raw),
        "scenarios": scenarios,
        "starting": starting,
    }
    if isinstance(merged.get("sleeve_info"), list):
        person["sleeveInfo"] = _jsonable(merged["sleeve_info"])
    if isinstance(merged.get("not_modeled"), list):
        person["notModeled"] = [str(s) for s in merged["not_modeled"]]
    return person, errors, warnings


# ---------- top level ----------


def _horizon(raw: dict, defaults: dict, ctx: _Ctx, today: datetime.date) -> dict:
    asof_s = _date(ctx, raw.get("asof"), "asof") or today.isoformat()
    asof = datetime.date.fromisoformat(asof_s)
    start = _month(ctx, raw.get("start"), "start") or asof.strftime("%Y-%m")
    months_raw = raw.get("months", raw.get("horizon_months", DEFAULT_MONTHS))
    if isinstance(months_raw, bool) or not isinstance(months_raw, int) or not 1 <= months_raw <= 120:
        ctx.err("months", "months must be a whole number between 1 and 120")
        months_raw = DEFAULT_MONTHS
    if start == asof.strftime("%Y-%m"):
        days = calendar.monthrange(asof.year, asof.month)[1]
        default_frac = round((days - asof.day) / days, 4)
    else:
        default_frac = 1.0
    frac = _num(ctx, raw.get("first_month_spend_fraction"), "first_month_spend_fraction", default_frac, 0)
    if frac > 1:
        ctx.err("first_month_spend_fraction", "must be between 0 and 1")
        frac = default_frac
    spread = raw.get("spread_through", defaults.get("spread_through", "year_end"))
    if spread not in ("horizon", "year_end"):
        ctx.err("spread_through", "spread_through must be horizon or year_end")
        spread = "year_end"
    lookahead = raw.get("reserve_lookahead_months", defaults.get("reserve_lookahead_months", DEFAULT_LOOKAHEAD))
    if isinstance(lookahead, bool) or not isinstance(lookahead, int) or lookahead < 0:
        ctx.err("reserve_lookahead_months", "must be a whole number of months")
        lookahead = DEFAULT_LOOKAHEAD
    play_cap = _num(ctx, raw.get("play_cap", defaults.get("play_cap")), "play_cap", DEFAULT_PLAY_CAP, 0)
    return {
        "asof": asof_s,
        "start": start,
        "months": months_raw,
        "firstMonthSpendFraction": frac,
        "spreadThrough": spread,
        "reserveLookahead": lookahead,
        "playCap": play_cap,
    }


#: Keys under `defaults` that are horizon settings, not person fields.
_HORIZON_DEFAULT_KEYS = ("reserve_lookahead_months",)


def include_paths(raw: dict) -> list[str]:
    """The `include:` paths of a parsed runway.yaml, in people order."""
    out = []
    for entry in raw.get("people") or []:
        if isinstance(entry, dict):
            inc = entry.get("include") or entry.get("file")
            if isinstance(inc, str):
                out.append(inc)
    return out


def config_version(ledger_file_path: str) -> str:
    """Fingerprint of runway.yaml and every file it includes. A save sends
    the version it was edited against; a mismatch means the files changed
    underneath."""
    path = runway_config_path(ledger_file_path)
    h = hashlib.sha256()
    if path.is_file():
        data = path.read_bytes()
        h.update(data)
        raw, _ = read_raw_config(path)
        root = ledger_root(ledger_file_path).resolve()
        for rel in include_paths(raw):
            target = (root / rel).resolve()
            h.update(b"\0" + rel.encode())
            if target.is_relative_to(root) and target.is_file():
                h.update(target.read_bytes())
    return h.hexdigest()[:16]


def build_runway_data(
    *,
    ledger,
    entries,
    ledger_file_path: str,
    today: datetime.date,
    raw: dict | None = None,
    includes: dict[str, dict] | None = None,
) -> dict:
    """Everything the /runway page loads.

    `people` holds only fully resolved people. `roster` lists every
    configured person with a status (ok | locked | missing | error) so the
    page can still show a locked partner file as an option.

    `raw` and `includes` (include path -> mapping) stand in for the files on
    disk, so a save can validate its result before writing it.
    """
    path = runway_config_path(ledger_file_path)
    top = _Ctx(None)
    if raw is None:
        raw, top_errors = read_raw_config(path)
        top.errors.extend(top_errors)
    defaults_raw = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
    horizon = _horizon(raw, defaults_raw, top, today)
    person_defaults = {k: v for k, v in defaults_raw.items() if k not in _HORIZON_DEFAULT_KEYS}
    shared = norm_shared(top, defaults_raw)

    root = ledger_root(ledger_file_path)
    positions_cache: list = []

    def positions_fn() -> list[tuple[str, str, float]]:
        if not positions_cache:
            positions_cache.append(
                ledger_positions(ledger, entries, datetime.date.fromisoformat(horizon["asof"]))
            )
        return positions_cache[0]

    contributions_cache: dict[str, dict[str, float]] = {}

    def contributions_fn(pattern: str) -> dict[str, float]:
        if pattern not in contributions_cache:
            contributions_cache[pattern] = ledger_contributions(
                entries, pattern, datetime.date.fromisoformat(horizon["asof"])
            )
        return contributions_cache[pattern]

    people: list[dict] = []
    roster: list[dict] = []
    errors = list(top.errors)
    warnings = list(top.warnings)
    seen_ids: set[str] = set()
    people_raw = raw.get("people")
    if people_raw is not None and not isinstance(people_raw, list):
        errors.append({"personId": None, "path": "people", "message": "people must be a list"})
        people_raw = []
    for i, entry in enumerate(people_raw or []):
        base = f"people[{i}]"
        if not isinstance(entry, dict):
            errors.append({"personId": None, "path": base, "message": "expected a mapping"})
            continue
        inline = dict(entry)
        include = inline.pop("include", None) or inline.pop("file", None)
        inline.pop("file", None)
        hint_id = inline.get("id") if isinstance(inline.get("id"), str) else None
        hint_label = inline.get("label") or inline.get("name") or hint_id
        merged = inline
        if include is not None:
            if includes is not None and include in includes:
                data, message, status = includes[include], None, "ok"
            else:
                data, message, status = resolve_include(root, include)
            if data is None:
                pid = hint_id
                errors.append({"personId": pid, "path": f"{base}.include", "message": message})
                roster.append(
                    {
                        "id": pid or f"person-{i + 1}",
                        "label": str(hint_label or include),
                        "status": status,
                        "file": str(include),
                        "message": message,
                    }
                )
                continue
            merged = _deep_merge(data, inline)
        pid = merged.get("id")
        if isinstance(pid, str) and pid in seen_ids:
            errors.append({"personId": pid, "path": f"{base}.id", "message": f"duplicate person id {pid!r}"})
            continue
        person, p_errors, p_warnings = resolve_person(
            merged,
            index=i,
            defaults=person_defaults,
            horizon=horizon,
            positions_fn=positions_fn,
            contributions_fn=contributions_fn,
        )
        errors.extend(p_errors)
        warnings.extend(p_warnings)
        label = str(merged.get("label") or merged.get("name") or pid or f"Person {i + 1}")
        if person is None:
            message = p_errors[0]["message"] if p_errors else "invalid person"
            roster.append(
                {
                    "id": pid if isinstance(pid, str) and pid else f"person-{i + 1}",
                    "label": label,
                    "status": "error",
                    "file": str(include) if include else None,
                    "message": message,
                }
            )
            continue
        seen_ids.add(person["id"])
        files = [path] + ([root / include] if include else [])
        person["readOnly"] = not all(os.access(f, os.W_OK) for f in files if f.exists())
        people.append(person)
        roster.append(
            {
                "id": person["id"],
                "label": person["label"],
                "status": "ok",
                "file": str(include) if include else None,
                "message": None,
            }
        )

    if errors or warnings:
        log.info("runway.yaml: %d errors, %d warnings", len(errors), len(warnings))
    return {
        "asof": horizon["asof"],
        "fromConfig": bool(raw),
        "start": horizon["start"],
        "months": horizon["months"],
        "firstMonthSpendFraction": horizon["firstMonthSpendFraction"],
        "spreadThrough": horizon["spreadThrough"],
        "reserveLookahead": horizon["reserveLookahead"],
        "playCap": horizon["playCap"],
        "defaults": _jsonable(defaults_raw),
        "shared": shared,
        "version": config_version(ledger_file_path),
        "people": people,
        "roster": roster,
        "errors": errors,
        "warnings": warnings,
    }
