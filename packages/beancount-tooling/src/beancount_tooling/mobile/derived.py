"""The snapshot's ``derived`` block: values the dashboard binds to directly.

The agent-written dashboard (a json-render spec) may only point at data, never
write a number itself. Anything a component needs that is not already a plain
field of the snapshot is computed here, once, so every spec reads the same
value:

- ``paceDelta``: flexible spend month to date minus the usual spend by today
  (negative means under usual).
- ``needsYou``: card statements due within 21 days and key dates within 30
  days, soonest first.
- ``cardsDue``: open card statements (statement over 1) sorted by due date.
- ``cashProjection``: projected cash for every day from ``asOf`` to the plan
  horizon, stepping at each plan event's running balance.
- ``stale``: accounts whose latest fetch was a SKIP, from
  ``statements/fetch-status.jsonl`` (empty when that file is absent).
- ``freshness``: when the data is from and which ledger commit built it
  (``ledgerDirty`` is null when git is unavailable).
- ``findings``: what the daily reconcile run found (forecast drift, settled
  or opened items, skips), from the agent-written
  ``config/dashboard/findings.json`` (empty when that file is absent or
  invalid). This is where a reconcile amount lives so a spec can bind to it
  instead of typing it.
- ``context``: market moves, news, the plan for the coming weeks and
  insights from the user's planning docs, from the agent-written
  ``config/dashboard/context.json`` (see ``context.py``; every key is always
  present, empty when the file is absent or a section is invalid).

``build_derived`` only reads the snapshot dict (plus the fetch-status,
findings and context files), so the CLI and the Fava endpoint produce the same block from
the same snapshot.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

from beancount_tooling.mobile.context import read_context

FETCH_STATUS_RELATIVE = Path("statements") / "fetch-status.jsonl"
#: Relative to the config directory.
FINDINGS_RELATIVE = Path("dashboard") / "findings.json"
FINDING_KINDS = frozenset({"drift", "settled", "opened", "statement", "skip", "note"})
MAX_FINDINGS = 50
MAX_FINDING_TITLE = 200

#: Card statements due within this many days of ``asOf`` go to ``needsYou``.
CARD_WINDOW_DAYS = 21
#: Key dates within this many days of ``asOf`` go to ``needsYou``.
KEY_DATE_WINDOW_DAYS = 30

MINUS = "−"


def _num(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def _date(iso) -> dt.date | None:
    if not isinstance(iso, str):
        return None
    try:
        return dt.date.fromisoformat(iso[:10])
    except ValueError:
        return None


def usd(n: float, digits: int = 0) -> str:
    """``$1,234`` style, with a true minus sign for negatives."""
    s = f"{abs(n):,.{digits}f}"
    return f"{MINUS if n < 0 else ''}${s}"


def cards_due(snapshot: dict) -> list[dict]:
    """Open card statements (statement over 1), soonest due first."""
    accounts = (snapshot.get("cards") or {}).get("accounts") or []
    out = []
    for c in accounts:
        if not isinstance(c, dict) or not _date(c.get("due")):
            continue
        statement = _num(c.get("statement"))
        if statement <= 1:
            continue
        out.append(
            {
                "name": c.get("displayName") or c.get("name") or "",
                "due": c["due"],
                "statement": statement,
                "fundedBy": c.get("fundedBy") or None,
            }
        )
    out.sort(key=lambda c: c["due"])
    return out


def needs_you(snapshot: dict, due: list[dict], asof: dt.date) -> list[dict]:
    """Card statements due soon and key dates coming up, soonest first."""
    items = []
    for c in due:
        d = _date(c["due"])
        if d is not None and (d - asof).days <= CARD_WINDOW_DAYS:
            items.append(
                {
                    "date": c["due"],
                    "title": f"{c['name']} statement",
                    "detail": f"{usd(c['statement'], 2)} from {c['fundedBy'] or 'checking'}",
                    "kind": "card",
                }
            )
    for k in snapshot.get("keyDates") or []:
        if not isinstance(k, dict):
            continue
        d = _date(k.get("date"))
        if d is not None and (d - asof).days <= KEY_DATE_WINDOW_DAYS:
            items.append(
                {
                    "date": k["date"],
                    "title": k.get("label") or "",
                    "detail": k.get("note") or "",
                    "kind": "date",
                }
            )
    items.sort(key=lambda i: i["date"])
    return items


def cash_projection(snapshot: dict, asof: dt.date) -> list[dict]:
    """Daily projected cash from ``asOf`` through the plan horizon. Each day
    takes the running balance of the last plan event on or before it."""
    plan = snapshot.get("plan") or {}
    end = _date(plan.get("horizon")) or asof
    by_date: dict[str, float] = {}
    for e in plan.get("events") or []:
        if isinstance(e, dict) and isinstance(e.get("date"), str):
            by_date[e["date"]] = _num(e.get("balance"))
    bal = _num(plan.get("startCash"))
    pts = []
    d = asof
    while d <= end:
        iso = d.isoformat()
        if iso in by_date:
            bal = by_date[iso]
        pts.append({"date": iso, "balance": bal})
        d += dt.timedelta(days=1)
    return pts


def read_stale(ledger_dir: Path | None) -> list[dict]:
    """Accounts whose most recent fetch record is a SKIP.

    ``statements/fetch-status.jsonl`` holds one JSON object per line with at
    least ``account`` and ``status`` (``"SKIP"`` or anything else, such as
    ``"OK"``), plus an optional ``reason``. Later lines win, so a successful
    fetch after a SKIP clears it. A missing or unreadable file means no stale
    accounts; malformed lines are skipped.
    """
    if ledger_dir is None:
        return []
    path = Path(ledger_dir) / FETCH_STATUS_RELATIVE
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    latest: dict[str, dict] = {}
    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        account = rec.get("account")
        if not isinstance(account, str) or not account:
            continue
        # Re-insert so dict order follows the latest record per account.
        latest.pop(account, None)
        latest[account] = rec
    return [
        {"account": account, "reason": str(rec.get("reason") or "skipped")}
        for account, rec in latest.items()
        if str(rec.get("status", "")).upper() == "SKIP"
    ]


def _finding(raw) -> dict | None:
    """One findings record, normalized, or None when it does not match
    ``{"id": str, "kind": FINDING_KINDS, "title": str, "amount" / "from" /
    "to": number|null, "account": str|null, "date": "YYYY-MM-DD"|null}``."""
    if not isinstance(raw, dict):
        return None
    fid, kind, title = raw.get("id"), raw.get("kind"), raw.get("title")
    if not isinstance(fid, str) or not fid.strip():
        return None
    if kind not in FINDING_KINDS:
        return None
    if not isinstance(title, str) or not title.strip():
        return None
    out = {"id": fid.strip(), "kind": kind, "title": title.strip()[:MAX_FINDING_TITLE]}
    for key in ("amount", "from", "to"):
        v = raw.get(key)
        if v is None:
            out[key] = None
        elif isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            out[key] = float(v)
        else:
            return None
    account = raw.get("account")
    if account is not None and not isinstance(account, str):
        return None
    out["account"] = account or None
    date = raw.get("date")
    if date is not None and (
        not isinstance(date, str) or len(date) != 10 or _date(date) is None
    ):
        return None
    out["date"] = date
    return out


def read_findings(config_dir: Path | None) -> list[dict]:
    """The agent's reconcile findings from ``<config>/dashboard/findings.json``.

    The file is a JSON list of records (see ``_finding``). A missing,
    unreadable or non-list file gives ``[]``; a record that does not match is
    dropped, as is a repeated ``id`` (the first wins). Never raises."""
    if config_dir is None:
        return []
    try:
        doc = json.loads((Path(config_dir) / FINDINGS_RELATIVE).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return []
    if not isinstance(doc, list):
        return []
    out, seen = [], set()
    for raw in doc:
        f = _finding(raw)
        if f is None or f["id"] in seen:
            continue
        seen.add(f["id"])
        out.append(f)
        if len(out) >= MAX_FINDINGS:
            break
    return out


def freshness(snapshot: dict) -> dict:
    meta = snapshot.get("meta") or {}
    dirty = meta.get("ledgerDirty")
    return {
        "asOf": str(snapshot.get("asOf") or meta.get("asOf") or ""),
        "generatedAt": str(meta.get("generatedAt") or ""),
        "ledgerCommit": meta.get("ledgerCommit") or None,
        # None means unknown (no git), which is not the same as clean.
        "ledgerDirty": dirty if isinstance(dirty, bool) else None,
    }


def build_derived(
    snapshot: dict, ledger_dir: Path | None = None, *, config_dir: Path | None = None
) -> dict:
    """The ``derived`` block for a built snapshot (see the module docstring).

    ``config_dir`` defaults to ``<ledger_dir>/config`` when ``ledger_dir`` is
    given."""
    if config_dir is None and ledger_dir is not None:
        config_dir = Path(ledger_dir) / "config"
    asof = _date(snapshot.get("asOf")) or dt.date.today()
    flex = (snapshot.get("spend") or {}).get("flex") or {}
    due = cards_due(snapshot)
    return {
        "paceDelta": round(_num(flex.get("mtd")) - _num(flex.get("usualByToday")), 2),
        "needsYou": needs_you(snapshot, due, asof),
        "cardsDue": due,
        "cashProjection": cash_projection(snapshot, asof),
        "stale": read_stale(ledger_dir),
        "freshness": freshness(snapshot),
        "findings": read_findings(config_dir),
        "context": read_context(config_dir),
    }
