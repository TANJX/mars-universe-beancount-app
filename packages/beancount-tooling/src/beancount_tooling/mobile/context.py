"""The snapshot's ``derived.context`` block: what the daily agent gathered
outside the ledger before composing the dashboard.

The agent writes ``config/dashboard/context.json`` (market moves, news, the
next weeks of the user's plan, and insights drawn from their planning docs);
``read_context`` validates it record by record and always returns the full
shape, so a spec can bind to ``/derived/context/...`` without a missing key::

    {
      "generatedAt": "ISO datetime" | null,
      "market": {
        "asOf": "ISO datetime" | null,
        "indices":  [{"symbol", "name", "price", "change", "changePct"}],
        "holdings": [{"symbol", "name", "changePct", "weight"}],
        "note": str | null,
      },
      "news":     [{"id", "title", "source", "url", "publishedAt", "relevance", "tags"}],
      "plan":     [{"id", "date", "title", "detail", "source", "status"}],
      "insights": [{"id", "kind", "title", "body", "date", "source", "amount"}],
    }

``changePct`` and ``weight`` are fractions (0.0123 is +1.23%). A missing or
unreadable file, or a section of the wrong type, reads as empty lists and
nulls; a record that does not match is dropped on its own, as is a repeated
``id`` within a list (the first wins). Lists stop at their limits. Never raises.

Numbers are allowed in the text fields here: plan and insight text quotes
figures from the user's own planning docs, and each record names its
``source``.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

#: Relative to the config directory.
CONTEXT_RELATIVE = Path("dashboard") / "context.json"

MAX_INDICES = 8
MAX_HOLDINGS = 15
MAX_NEWS = 8
MAX_PLAN = 20
MAX_INSIGHTS = 8
MAX_TAGS = 8

MAX_TITLE = 160
MAX_TEXT = 400  # body, relevance, detail, note
MAX_SOURCE = 200
MAX_NAME = 120
MAX_SYMBOL = 24
MAX_ID = 120
MAX_TAG = 40
MAX_URL = 2000

PLAN_STATUSES = frozenset({"upcoming", "due", "done", "open"})
INSIGHT_KINDS = frozenset({"plan", "decision", "risk", "opportunity", "reminder"})


class _Drop(Exception):
    """The record does not match; drop it."""


def empty_context() -> dict:
    return {
        "generatedAt": None,
        "market": {"asOf": None, "indices": [], "holdings": [], "note": None},
        "news": [],
        "plan": [],
        "insights": [],
    }


# ---------- field checks (raise _Drop on a mismatch) ----------


def _str(raw: dict, key: str, limit: int, *, required: bool = True) -> str:
    """A trimmed string, cut at ``limit``. ``required`` means present and
    non-empty; otherwise a missing or null value reads as ""."""
    v = raw.get(key)
    if v is None and not required:
        return ""
    if not isinstance(v, str):
        raise _Drop
    v = v.strip()
    if required and not v:
        raise _Drop
    return v[:limit].rstrip()


def _opt_str(raw: dict, key: str, limit: int) -> str | None:
    v = raw.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise _Drop
    v = v.strip()[:limit].rstrip()
    return v or None


def _opt_num(raw: dict, key: str) -> float | None:
    v = raw.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise _Drop
    return float(v)


def _parse_date(v) -> str | None:
    """``YYYY-MM-DD`` (an ISO datetime is cut to its date), or None."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    try:
        if len(v) == 10:
            return dt.date.fromisoformat(v).isoformat()
        return dt.datetime.fromisoformat(v).date().isoformat()
    except ValueError:
        return None


def _opt_date(raw: dict, key: str) -> str | None:
    v = raw.get(key)
    if v is None:
        return None
    d = _parse_date(v)
    if d is None:
        raise _Drop
    return d


def _datetime(v) -> str | None:
    """An ISO date or datetime string as given (trimmed), or None when it does
    not parse."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    try:
        dt.datetime.fromisoformat(v)
    except ValueError:
        return None
    return v


def _url(raw: dict, key: str) -> str:
    v = _str(raw, key, MAX_URL + 1)
    if len(v) > MAX_URL or any(c.isspace() for c in v):
        raise _Drop
    try:
        parts = urlsplit(v)
    except ValueError:
        raise _Drop from None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise _Drop
    return v


def _tags(raw: dict) -> list[str]:
    v = raw.get("tags")
    if v is None:
        return []
    if not isinstance(v, list):
        raise _Drop
    out: list[str] = []
    for t in v:
        if isinstance(t, str) and (t := t.strip()[:MAX_TAG].rstrip()) and t not in out:
            out.append(t)
        if len(out) >= MAX_TAGS:
            break
    return out


def _enum(raw: dict, key: str, allowed: frozenset) -> str:
    v = raw.get(key)
    if v not in allowed:
        raise _Drop
    return v


# ---------- records ----------


def _index(raw: dict) -> dict:
    return {
        "symbol": _str(raw, "symbol", MAX_SYMBOL),
        "name": _str(raw, "name", MAX_NAME),
        "price": _opt_num(raw, "price"),
        "change": _opt_num(raw, "change"),
        "changePct": _opt_num(raw, "changePct"),
    }


def _holding(raw: dict) -> dict:
    return {
        "symbol": _str(raw, "symbol", MAX_SYMBOL),
        "name": _str(raw, "name", MAX_NAME),
        "changePct": _opt_num(raw, "changePct"),
        "weight": _opt_num(raw, "weight"),
    }


def _news(raw: dict) -> dict:
    return {
        "id": _str(raw, "id", MAX_ID),
        "title": _str(raw, "title", MAX_TITLE),
        "source": _str(raw, "source", MAX_SOURCE),
        "url": _url(raw, "url"),
        "publishedAt": _opt_date(raw, "publishedAt"),
        "relevance": _str(raw, "relevance", MAX_TEXT, required=False),
        "tags": _tags(raw),
    }


def _plan(raw: dict) -> dict:
    return {
        "id": _str(raw, "id", MAX_ID),
        "date": _opt_date(raw, "date"),
        "title": _str(raw, "title", MAX_TITLE),
        "detail": _str(raw, "detail", MAX_TEXT, required=False),
        "source": _str(raw, "source", MAX_SOURCE),
        "status": _enum(raw, "status", PLAN_STATUSES),
    }


def _insight(raw: dict) -> dict:
    return {
        "id": _str(raw, "id", MAX_ID),
        "kind": _enum(raw, "kind", INSIGHT_KINDS),
        "title": _str(raw, "title", MAX_TITLE),
        "body": _str(raw, "body", MAX_TEXT),
        "date": _opt_date(raw, "date"),
        "source": _str(raw, "source", MAX_SOURCE),
        "amount": _opt_num(raw, "amount"),
    }


def _records(raw, build, limit: int, key: str | None = "id") -> list[dict]:
    """Valid records of a list, in order, deduplicated on ``key`` (the first
    wins), up to ``limit``. Anything but a list reads as []."""
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            rec = build(item)
        except _Drop:
            continue
        if key is not None:
            if rec[key] in seen:
                continue
            seen.add(rec[key])
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def _market(raw) -> dict:
    market = empty_context()["market"]
    if not isinstance(raw, dict):
        return market
    market["asOf"] = _datetime(raw.get("asOf"))
    market["indices"] = _records(raw.get("indices"), _index, MAX_INDICES, "symbol")
    market["holdings"] = _records(raw.get("holdings"), _holding, MAX_HOLDINGS, "symbol")
    note = raw.get("note")
    if isinstance(note, str):
        market["note"] = note.strip()[:MAX_TEXT].rstrip() or None
    return market


def parse_context(doc) -> dict:
    """The context block for an already-parsed JSON document."""
    out = empty_context()
    if not isinstance(doc, dict):
        return out
    out["generatedAt"] = _datetime(doc.get("generatedAt"))
    out["market"] = _market(doc.get("market"))
    out["news"] = _records(doc.get("news"), _news, MAX_NEWS)
    out["plan"] = _records(doc.get("plan"), _plan, MAX_PLAN)
    out["insights"] = _records(doc.get("insights"), _insight, MAX_INSIGHTS)
    return out


def read_context(config_dir: Path | None) -> dict:
    """The agent's context from ``<config>/dashboard/context.json`` (see the
    module docstring). Always the full shape; never raises."""
    if config_dir is None:
        return empty_context()
    try:
        text = (Path(config_dir) / CONTEXT_RELATIVE).read_text(encoding="utf-8")
        doc = json.loads(text)
    except (OSError, UnicodeDecodeError, ValueError, RecursionError):
        return empty_context()
    return parse_context(doc)
