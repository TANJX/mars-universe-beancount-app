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
            the inline keys.
  fire      `config/fire.yaml`: when a runway person's id matches a fire
            person, missing fields (label, gross salary, work state, monthly
            spending, birth year, 401k limit) are inherited instead of
            duplicated.
  ledger    `starting.source: ledger` fills starting balances from the ledger
            at `asof`, mapping each account to a sleeve by ordered regex rules.

The output is camelCase (see `build_runway_data`). Errors drop a person;
warnings keep it. Balances are never logged.
"""

from __future__ import annotations

import calendar
import datetime
import logging
import re
from pathlib import Path
from typing import Any

import yaml

from . import store
from .fire import _query, _usd

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
#: fire.yaml `work_state` -> runway withholding state.
FIRE_STATE = {
    "ny_from_nj": "ny_nonresident",
    "ny": "ny",
    "nj": "nj",
    "none": "none",
}
MATCH_TYPES = ("none", "flat", "threshold", "tiered")
#: Accepted election mode spellings. `max` and `per_paycheck` are the UI names.
ELECTION_MODES = {
    "fixed": "fixed",
    "per_paycheck": "fixed",
    "percent": "percent",
    "max_spread": "max_spread",
    "max": "max_spread",
}
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


def _norm_job(ctx: _Ctx, raw: Any, path: str, default_employer: str) -> dict | None:
    raw = _dict(ctx, raw, path)
    gross = raw.get("gross_annual")
    if gross is None:
        ctx.err(f"{path}.gross_annual", "missing gross_annual")
        return None
    schedule = _norm_schedule(ctx, raw.get("schedule"), f"{path}.schedule")
    raise_raw = raw.get("raise")
    raise_ = None
    if raise_raw is not None:
        rr = _dict(ctx, raise_raw, f"{path}.raise")
        month = rr.get("month")
        if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
            ctx.err(f"{path}.raise.month", f"raise month must be 1..12, got {month!r}")
        else:
            raise_ = {"month": month, "pct": _num(ctx, rr.get("pct"), f"{path}.raise.pct", 0.0)}
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
        month = he.get("month", 1)
        if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
            ctx.err(f"{path}.hsa_employer.month", f"month must be 1..12, got {month!r}")
        else:
            hsa_employer = {
                "amount": _num(ctx, he.get("amount"), f"{path}.hsa_employer.amount", 0.0, 0),
                "month": month,
            }
    hsa_tier = raw.get("hsa_coverage")
    if hsa_tier is not None and hsa_tier not in HSA_TIERS:
        ctx.err(f"{path}.hsa_coverage", f"hsa_coverage must be one of {' | '.join(HSA_TIERS)}")
        hsa_tier = None
    job = {
        "employer": str(raw.get("employer") or default_employer),
        "grossAnnual": _num(ctx, gross, f"{path}.gross_annual", 0.0, minimum=0),
        "raise": raise_,
        "schedule": schedule,
        "deductions": _norm_deductions(ctx, raw.get("deductions"), f"{path}.deductions"),
        "withholding": _norm_withholding(ctx, raw.get("withholding"), f"{path}.withholding"),
        "match": _norm_match(ctx, raw.get("match"), f"{path}.match"),
        "vesting": vesting,
        "hsaEmployer": hsa_employer,
        "hsaTier": hsa_tier,
    }
    return job if schedule is not None else None


def _norm_elections(ctx: _Ctx, raw: Any, path: str) -> list[dict]:
    out = []
    for i, e in enumerate(_list(ctx, raw, path)):
        p = f"{path}[{i}]"
        if not isinstance(e, dict):
            ctx.err(p, "expected a mapping")
            continue
        mode = ELECTION_MODES.get(e.get("mode"))
        if mode is None:
            ctx.err(f"{p}.mode", f"unknown election mode {e.get('mode')!r} (fixed | percent | max_spread)")
            continue
        start = _month(ctx, e.get("from"), f"{p}.from", required=True)
        if start is None:
            continue
        if mode == "fixed":
            out.append(
                {
                    "from": start,
                    "mode": "fixed",
                    "pretax": _num(ctx, e.get("pretax"), f"{p}.pretax", 0.0, 0),
                    "roth": _num(ctx, e.get("roth"), f"{p}.roth", 0.0, 0),
                }
            )
        elif mode == "percent":
            out.append(
                {
                    "from": start,
                    "mode": "percent",
                    "pretaxPct": _num(ctx, e.get("pretax_pct"), f"{p}.pretax_pct", 0.0, 0),
                    "rothPct": _num(ctx, e.get("roth_pct"), f"{p}.roth_pct", 0.0, 0),
                }
            )
        else:
            out.append(
                {
                    "from": start,
                    "mode": "max_spread",
                    "capPct": _num(ctx, e.get("cap_pct"), f"{p}.cap_pct", 1.0, 0),
                    "rothShare": _num(ctx, e.get("roth_share"), f"{p}.roth_share", 0.0, 0),
                }
            )
    return sorted(out, key=lambda e: e["from"])


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


def _norm_limits(
    ctx: _Ctx, raw: Any, path: str, years: list[str], fire_limit: Any
) -> tuple[dict[str, float], bool]:
    """Per-year 401k limits for every horizon year. Returns (limits,
    inherited_from_fire)."""
    given = {
        str(y): _num(ctx, v, f"{path}.{y}", 0.0, minimum=0)
        for y, v in _dict(ctx, raw, path).items()
    }
    inherited = False
    if not given and isinstance(fire_limit, int | float) and not isinstance(fire_limit, bool):
        given = {y: float(fire_limit) for y in years}
        inherited = True
    if not given:
        # Nothing configured: the page falls back to its bundled IRS table.
        return {}, False
    out = dict(given)
    for y in years:
        if y in out:
            continue
        earlier = [k for k in sorted(out) if k < y]
        prev = earlier[-1] if earlier else min(out)
        out[y] = out[prev]
        ctx.warn(path, f"No 401k limit for {y}; reusing {prev}")
    return dict(sorted(out.items())), inherited


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


def resolve_person(
    raw: dict,
    *,
    index: int,
    defaults: dict,
    fire_config: dict,
    horizon: dict,
    positions_fn,
) -> tuple[dict | None, list[dict], list[dict]]:
    """Normalize one merged person mapping (include already applied).

    Merge order: defaults < fire.yaml inherited < the person mapping.
    Returns (person or None, errors, warnings).
    """
    pid = raw.get("id")
    ctx = _Ctx(pid if isinstance(pid, str) else None, f"people[{index}]")
    if not isinstance(pid, str) or not pid:
        ctx.err("id", "missing person id")
        return None, ctx.errors, ctx.warnings

    asof = datetime.date.fromisoformat(horizon["asof"])
    years = _horizon_years(horizon["start"], horizon["months"])
    merged = _deep_merge(defaults, raw)

    # fire.yaml inheritance, only for fields the runway config leaves out.
    inherited: list[str] = []
    fire_people = [p for p in (fire_config.get("people") or []) if isinstance(p, dict)]
    fire_person = next((p for p in fire_people if p.get("id") == pid), None)
    if fire_person:
        candidates: list[tuple[tuple[str, ...], str, Any]] = []
        if fire_person.get("name"):
            candidates.append((("label",), "label", fire_person["name"]))
        ws = fire_person.get("work_state")
        if ws in FIRE_STATE:
            candidates.append(
                (("job", "withholding", "state"), "job.withholding.state", FIRE_STATE[ws])
            )
        by = fire_person.get("birth_year")
        if isinstance(by, int) and not isinstance(by, bool):
            candidates.append((("birth_year",), "birthYear", by))
        gross = _fire_gross(fire_person, int(horizon["start"][:4]))
        if gross is not None:
            candidates.append((("job", "gross_annual"), "job.grossAnnual", gross))
        spending = fire_person.get("spending")
        if isinstance(spending, dict):
            total = sum(v for v in spending.values() if isinstance(v, int | float))
            candidates.append((("spending", "monthly"), "spendingMonthly", round(total / 12, 2)))
        for path, label, value in candidates:
            if not _has_path(merged, path):
                _set_path(merged, path, value)
                inherited.append(label)

    label = merged.get("label") or merged.get("name") or pid
    job = _norm_job(ctx, merged.get("job"), "job", "Current job")

    k401_raw = _dict(ctx, merged.get("k401"), "k401")
    limits_raw = k401_raw.get("limits", merged.get("k401_limits"))
    fire_limit = (fire_config.get("assumptions") or {}).get("k401_limit")
    limits, limits_inherited = _norm_limits(ctx, limits_raw, "k401.limits", years, fire_limit)
    if limits_inherited:
        inherited.append("k401.limits")
    ytd = {
        str(y): _num(ctx, v, f"k401.ytd.{y}", 0.0, 0)
        for y, v in _dict(ctx, k401_raw.get("ytd"), "k401.ytd").items()
    }
    elections = _norm_elections(ctx, k401_raw.get("elections"), "k401.elections")

    contributions = _norm_contributions(ctx, merged.get("contributions"), "contributions")
    year_limits = _norm_year_limits(ctx, merged.get("limits"), "limits")
    hsa_coverage = _norm_hsa_coverage(ctx, merged.get("hsa_coverage"), "hsa_coverage")
    birth_year = merged.get("birth_year")
    if birth_year is not None and (isinstance(birth_year, bool) or not isinstance(birth_year, int)):
        ctx.err("birth_year", f"birth_year must be a year, got {birth_year!r}")
        birth_year = None
    # The old keys still work, but one account may not be described both ways:
    # the money would be counted twice.
    streamed = {c["account"] for c in contributions}
    if "k401" in streamed and elections:
        ctx.err("k401.elections", "401k is set in both contributions and k401.elections; keep one")
    if "ira" in streamed and merged.get("ira") is not None:
        ctx.err("ira", "IRA is set in both contributions and ira; keep one")

    spending = _dict(ctx, merged.get("spending"), "spending")
    spend_monthly = _num(ctx, spending.get("monthly"), "spending.monthly", None, 0)
    if spend_monthly is None:
        ctx.err("spending.monthly", "missing monthly spending")

    ira = None
    if merged.get("ira") is not None:
        ira_raw = _dict(ctx, merged["ira"], "ira")
        month = ira_raw.get("month", 1)
        if isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12:
            ctx.err("ira.month", f"IRA month must be 1..12, got {month!r}")
        else:
            ira = {"amount": _num(ctx, ira_raw.get("amount"), "ira.amount", 0.0, 0), "month": month}

    one_offs = []
    for i, o in enumerate(_list(ctx, merged.get("one_offs"), "one_offs")):
        if not isinstance(o, dict):
            ctx.err(f"one_offs[{i}]", "expected a mapping")
            continue
        month = _month(ctx, o.get("month"), f"one_offs[{i}].month", required=True)
        if month:
            one_offs.append(
                {
                    "month": month,
                    "amount": _num(ctx, o.get("amount"), f"one_offs[{i}].amount", 0.0),
                    "label": str(o.get("label") or "One-off"),
                }
            )

    if "hsa" in streamed and job is not None:
        for i, d in enumerate(job["deductions"]):
            if d["sleeve"] == "hsa":
                ctx.err(
                    f"job.deductions[{i}]",
                    "HSA is set in both contributions and a paycheck deduction; keep one",
                )

    cash = _norm_cash(ctx, merged.get("cash"), "cash")

    returns_raw = _dict(ctx, merged.get("returns"), "returns")
    returns = {
        k: _num(ctx, returns_raw.get(k), f"returns.{k}", default)
        for k, default in DEFAULT_RETURNS.items()
    }

    scenarios = _norm_scenarios(ctx, merged, job)
    starting = _norm_starting(ctx, merged.get("starting"), "starting", asof, positions_fn)

    if ctx.errors or job is None or starting is None:
        return None, ctx.errors, ctx.warnings

    earmark_total = sum(e["amount"] for e in cash["earmarks"])
    if earmark_total > starting["sleeves"]["reserve"]:
        ctx.warn("cash.earmarks", "earmarks are larger than the starting reserve")

    person = {
        "id": pid,
        "label": str(label),
        "name": str(label),
        "status": "ok",
        "job": job,
        # Streams into the 401k, IRA and HSA. `k401` and `ira` below are the
        # older shape; the page converts whatever is still written that way.
        "contributions": contributions,
        "limits": year_limits,
        "hsaCoverage": hsa_coverage,
        "birthYear": birth_year,
        "k401": {"limits": limits, "ytd": ytd, "elections": elections},
        "spendingMonthly": spend_monthly,
        "ira": ira,
        "oneOffs": sorted(one_offs, key=lambda o: o["month"]),
        "cash": cash,
        "returns": returns,
        "scenarios": scenarios,
        "starting": starting,
        "inherited": inherited,
    }
    if isinstance(merged.get("sleeve_info"), list):
        person["sleeveInfo"] = _jsonable(merged["sleeve_info"])
    if isinstance(merged.get("not_modeled"), list):
        person["notModeled"] = [str(s) for s in merged["not_modeled"]]
    return person, ctx.errors, ctx.warnings


def _fire_gross(fire_person: dict, start_year: int) -> float | None:
    """First enabled job's latest enabled salary step with year <= start."""
    for job in fire_person.get("jobs") or []:
        if not isinstance(job, dict) or job.get("enabled") is False:
            continue
        steps = [
            s
            for s in job.get("salary") or []
            if isinstance(s, dict)
            and s.get("enabled") is not False
            and isinstance(s.get("year"), int)
            and s["year"] <= start_year
            and isinstance(s.get("gross"), int | float)
        ]
        if steps:
            return float(max(steps, key=lambda s: s["year"])["gross"])
        return None
    return None


def _norm_scenarios(ctx: _Ctx, merged: dict, job: dict | None) -> list[dict]:
    """`stay` first, then each job switch. A switch job inherits every field
    of the current job except employer and vesting (a new employer's vesting
    starts over)."""
    current_raw = merged.get("job") if isinstance(merged.get("job"), dict) else {}
    inherit_base = {k: v for k, v in current_raw.items() if k not in ("employer", "vesting")}
    out: list[dict] = []
    seen: set[str] = set()
    for i, s in enumerate(_list(ctx, merged.get("scenarios"), "scenarios")):
        p = f"scenarios[{i}]"
        if not isinstance(s, dict):
            ctx.err(p, "expected a mapping")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            ctx.err(f"{p}.id", "missing scenario id")
            continue
        if sid in seen:
            ctx.err(f"{p}.id", f"duplicate scenario id {sid!r}")
            continue
        seen.add(sid)
        if sid == "stay":
            out.append({"id": "stay", "label": str(s.get("label") or "Stay"), "start": None, "job": None})
            continue
        sjob = _dict(ctx, s.get("job"), f"{p}.job")
        start = _month(ctx, sjob.get("start", s.get("start")), f"{p}.job.start", required=True)
        merged_job = _deep_merge(inherit_base, {k: v for k, v in sjob.items() if k != "start"})
        if "vesting" not in sjob:
            merged_job["vesting"] = None
        new_job = _norm_job(ctx, merged_job, f"{p}.job", "New job")
        if new_job is None or start is None:
            continue
        out.append({"id": sid, "label": str(s.get("label") or sid), "start": start, "job": new_job})
    if not any(s["id"] == "stay" for s in out):
        out.insert(0, {"id": "stay", "label": "Stay", "start": None, "job": None})
    else:
        out.sort(key=lambda s: s["id"] != "stay")
    return out


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
_HORIZON_DEFAULT_KEYS = ("spread_through", "reserve_lookahead_months", "play_cap")


def build_runway_data(
    *,
    ledger,
    entries,
    ledger_file_path: str,
    fire_config: dict,
    today: datetime.date,
) -> dict:
    """Everything the /runway page loads.

    `people` holds only fully resolved people. `roster` lists every
    configured person with a status (ok | locked | missing | error) so the
    page can still show a locked partner file as an option.
    """
    path = runway_config_path(ledger_file_path)
    raw, top_errors = read_raw_config(path)
    top = _Ctx(None)
    top.errors.extend(top_errors)
    defaults_raw = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
    horizon = _horizon(raw, defaults_raw, top, today)
    person_defaults = {k: v for k, v in defaults_raw.items() if k not in _HORIZON_DEFAULT_KEYS}

    root = ledger_root(ledger_file_path)
    positions_cache: list = []

    def positions_fn() -> list[tuple[str, str, float]]:
        if not positions_cache:
            positions_cache.append(
                ledger_positions(ledger, entries, datetime.date.fromisoformat(horizon["asof"]))
            )
        return positions_cache[0]

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
            fire_config=fire_config or {},
            horizon=horizon,
            positions_fn=positions_fn,
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
        "people": people,
        "roster": roster,
        "errors": errors,
        "warnings": warnings,
    }
