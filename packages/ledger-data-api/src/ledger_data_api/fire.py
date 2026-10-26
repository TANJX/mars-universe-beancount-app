"""FIRE explorer: ledger snapshot, per-user plan config, saved scenarios.

The web app's /fire page projects a path to financial independence. It needs
three inputs, each from a different place:

  snapshot   live from the ledger: net worth split into buckets (cash, each
             investment tax treatment, other assets, card debt, loans) plus
             trailing-12-month cleared income and expenses by category.
  config     `config/fire.yaml` beside `config/ui.yaml`: the forward-looking
             assumptions the ledger cannot know (salary curve, partner, life
             events, retirement spend). Per-user and private by nature, so it
             lives in the data repo, never here.
  scenarios  `<ledger dir>/plan/fire-scenarios.json`: named override sets the
             page saves so two plans can be compared side by side.

Investment buckets reuse the `investments.sleeves[].tax` annotations from
ui.yaml, so the page and /portfolio agree on what is Roth vs taxable.
"""

from __future__ import annotations

import datetime
import logging
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import yaml
from beanquery.query import run_query  # type: ignore

from . import store

log = logging.getLogger(__name__)

#: Tax treatments the page knows how to bucket. Anything else under
#: Assets:Investment falls back to taxable.
TAX_BUCKETS = ("taxable", "roth", "traditional", "401k", "roth-401k", "hsa")


def _usd(inventory) -> Decimal:
    """USD amount of a converted beanquery inventory cell."""
    if inventory is None:
        return Decimal(0)
    total = Decimal(0)
    for pos in inventory:
        if pos.units.currency == "USD":
            total += pos.units.number
    return total


def _query(ledger, entries, sql: str):
    _types, rows = run_query(entries, ledger.options, sql)
    return rows


def _sleeve_tax(ui_config: dict) -> list[tuple[str, str]]:
    """(account prefix, tax) pairs, longest prefix first so leaves win."""
    sleeves = ((ui_config.get("investments") or {}).get("sleeves")) or []
    pairs = [
        (s["account"], s.get("tax") or "taxable")
        for s in sleeves
        if isinstance(s, dict) and isinstance(s.get("account"), str)
    ]
    return sorted(pairs, key=lambda p: -len(p[0]))


def _bucket(account: str, sleeves: list[tuple[str, str]]) -> str:
    if account.startswith(("Assets:Checking", "Assets:Saving")):
        return "cash"
    if account.startswith("Assets:Investment"):
        for prefix, tax in sleeves:
            if account == prefix or account.startswith(prefix + ":"):
                return tax if tax in TAX_BUCKETS else "taxable"
        return "taxable"
    if account.startswith("Assets"):
        return "otherAssets"
    if account.startswith("Liabilities:Credit"):
        return "cardDebt"
    if account.startswith("Liabilities:Loan"):
        return "loans"
    return "otherLiabilities"


def build_snapshot(ledger, entries, ui_config: dict, asof: datetime.date) -> dict:
    sleeves = _sleeve_tax(ui_config)
    end = asof.isoformat()
    start = (asof - datetime.timedelta(days=365)).isoformat()

    buckets: dict[str, Decimal] = defaultdict(Decimal)
    rows = _query(
        ledger,
        entries,
        "SELECT account, convert(value(sum(position)), 'USD') AS usd "
        f"WHERE account ~ '^(Assets|Liabilities)' AND date <= {end} "
        "GROUP BY account",
    )
    for account, inv in rows:
        amount = _usd(inv)
        if amount:
            buckets[_bucket(account, sleeves)] += amount

    def flows(root: str) -> list[dict]:
        out = []
        for cat, inv in _query(
            ledger,
            entries,
            "SELECT root(account, 2) AS cat, sum(convert(position, 'USD')) AS usd "
            f"WHERE account ~ '^{root}:' AND flag = '*' "
            f"AND date > {start} AND date <= {end} GROUP BY cat",
        ):
            amount = _usd(inv)
            if amount:
                # Income is credit-normal; flip it so both lists read positive.
                value = -amount if root == "Income" else amount
                out.append({"category": cat.split(":", 1)[1], "amount": float(value)})
        return sorted(out, key=lambda r: -r["amount"])

    return {
        "asof": end,
        "buckets": {k: float(v) for k, v in buckets.items()},
        "expenses": flows("Expenses"),
        "income": flows("Income"),
    }


# ---------- config/fire.yaml ----------


def fire_config_path(ledger_file_path: str) -> Path:
    return store.ui_config_path(ledger_file_path).with_name("fire.yaml")


def read_fire_config(ledger_file_path: str) -> dict:
    """Read config/fire.yaml. {} when absent or malformed (the page then
    falls back to its bundled defaults and says so)."""
    path = fire_config_path(ledger_file_path)
    if not path.exists():
        return {}
    try:
        with path.open("r") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as ex:
        log.warning("fire.yaml at %s is malformed: %s", path, ex)
        return {}
    return data if isinstance(data, dict) else {}


# ---------- scenarios ----------


def _scenarios_path(ledger_file_path: str) -> Path:
    return store.plan_dir(ledger_file_path) / "fire-scenarios.json"


def list_scenarios(ledger_file_path: str) -> list[dict]:
    data = store._read_json_object(_scenarios_path(ledger_file_path), {})
    items = [v for v in data.values() if isinstance(v, dict)]
    return sorted(items, key=lambda s: s.get("updatedAt", ""))


def save_scenario(ledger_file_path: str, scenario: dict) -> dict:
    path = _scenarios_path(ledger_file_path)
    data = store._read_json_object(path, {})
    sid = scenario.get("id") or store.new_id()
    saved = {
        "id": sid,
        "name": str(scenario.get("name") or "Untitled"),
        "overrides": scenario.get("overrides") or {},
        "updatedAt": store.now_iso(),
    }
    data[sid] = saved
    store._write_json_atomic(path, data)
    return saved


def delete_scenario(ledger_file_path: str, scenario_id: str) -> None:
    path = _scenarios_path(ledger_file_path)
    data = store._read_json_object(path, {})
    if data.pop(scenario_id, None) is not None:
        store._write_json_atomic(path, data)
