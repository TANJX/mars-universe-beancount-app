"""Save /runway page edits back to config/runway.yaml (and included files).

The page edits normalized (camelCase) people. A save sends, for one person,
the edited plan and every scenario as normalized bodies, plus the shared
defaults. This module:

1. turns normalized bodies back into canonical YAML mappings (`denorm_*`),
2. diffs the edited canonical form against the canonical form of what is on
   disk now, giving edit operations (runway_patch.diff_ops),
3. replays those operations on a comment-preserving ruamel document, so only
   the changed values move and every comment stays,
4. re-resolves the result in memory and refuses the save on any error,
5. writes the touched files atomically.

A scenario is stored as a patch over the plan. Its patch is recomputed as
diff_patch(scenario, plan) and the stored patch is edited toward it the same
way, so a hand-written comment inside a patch survives too.
"""

from __future__ import annotations

import datetime
import difflib
import io
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

from . import runway
from .runway_patch import diff_ops, diff_patch

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SaveError(Exception):
    """A rejected save. `status` is the HTTP status; `issues` the resolver's
    errors when validation failed."""

    def __init__(self, message: str, status: int = 400, issues: list[dict] | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.issues = issues or []


# ---------- normalized -> canonical YAML ----------


def _clean(d: dict) -> dict:
    """Drop None values and empty lists/maps: canonical form omits defaults."""
    return {k: v for k, v in d.items() if v is not None and v != [] and v != {}}


def _schedule(s: dict | None) -> dict | None:
    if not s:
        return None
    if s.get("frequency") == "biweekly":
        return {"frequency": "biweekly", "anchor": s.get("anchor")}
    return {"frequency": s.get("frequency"), "days": list(s.get("days") or [])}


def _deduction(d: dict) -> dict:
    pretax = bool(d.get("pretax"))
    per = d.get("per", "paycheck")
    return _clean(
        {
            "label": d.get("label"),
            "amount": d.get("amount"),
            "per": per if per != "paycheck" else None,
            "paycheck": d.get("paycheckOfMonth") if per == "month" and d.get("paycheckOfMonth") != 1 else None,
            "pretax": True if pretax else None,
            "fica_exempt": d.get("ficaExempt") if d.get("ficaExempt", pretax) != pretax else None,
            "sleeve": d.get("sleeve"),
        }
    )


def _withholding(w: dict | None) -> dict | None:
    if not w:
        return None
    sp = w.get("statePayroll") or {}
    return _clean(
        {
            "filing": w.get("filing"),
            "federal_std": w.get("federalStd"),
            "state": w.get("state"),
            "state_std": w.get("stateStd"),
            "state_payroll": _clean(
                {
                    "flat_per_paycheck": sp.get("flatPerPaycheck"),
                    "rate": sp.get("rate"),
                    "annual_cap": sp.get("annualCap"),
                    "ytd": dict(sp.get("ytd") or {}),
                }
            ),
            "ss_wage_base": w.get("ssWageBase"),
        }
    )


def _match(m: dict | None) -> dict | None:
    kind = (m or {}).get("type", "none")
    if kind == "flat":
        return {"type": "flat", "pct": m.get("pct")}
    if kind == "threshold":
        return {"type": "threshold", "min_pct": m.get("minPct"), "pct": m.get("pct")}
    if kind == "tiered":
        tiers = [{"rate": t.get("rate"), "up_to_pct": t.get("upToPct")} for t in m.get("tiers") or []]
        return {"type": "tiered", "tiers": tiers}
    return None


def _job(j: dict) -> dict:
    vesting = j.get("vesting")
    he = j.get("hsaEmployer")
    return _clean(
        {
            "id": j.get("id"),
            "employer": j.get("employer"),
            "start": j.get("start"),
            "leave": j.get("leave"),
            "enabled": False if j.get("enabled") is False else None,
            "note": j.get("note") or None,
            "salary": [
                _clean(
                    {
                        "from": s.get("from"),
                        "gross": s.get("gross"),
                        "enabled": False if s.get("enabled") is False else None,
                        "note": s.get("note") or None,
                    }
                )
                for s in j.get("salary") or []
            ],
            "match": _match(j.get("match")),
            "vesting": (
                {"date": vesting.get("date"), "unvested_start": vesting.get("unvestedStart")} if vesting else None
            ),
            "hsa_employer": {"amount": he.get("amount"), "month": he.get("month")} if he else None,
            "schedule": _schedule(j.get("schedule")),
            "deductions": (
                [_deduction(d) for d in j["deductions"]] if j.get("deductions") is not None else None
            ),
            "withholding": _withholding(j.get("withholding")),
        }
    )


def _phase(p: dict, channel: str) -> dict:
    pace = p.get("pace")
    out: dict = {"from": p.get("from"), "pace": pace}
    if pace == "fixed":
        out["amount"] = p.get("amount")
        if channel == "payroll" and p.get("per") == "month":
            out["per"] = "month"
            if p.get("paycheckOfMonth") not in (None, 1):
                out["paycheck"] = p.get("paycheckOfMonth")
    elif pace == "percent":
        out["pct"] = p.get("pct")
    elif pace in ("even", "front_load"):
        if p.get("share", 1) != 1:
            out["share"] = p.get("share")
        if p.get("capPct", 1) != 1:
            out["cap_pct"] = p.get("capPct")
    elif pace == "lump":
        out["month"] = p.get("month")
        out["amount"] = "max" if p.get("amount") is None else p.get("amount")
    return out


def _contribution(c: dict) -> dict:
    account = c.get("account")
    channel = c.get("channel") or runway.CHANNELS.get(account, ("payroll",))[0]
    return _clean(
        {
            "id": c.get("id"),
            "account": account,
            "tax": c.get("tax") if account != "hsa" else None,
            "channel": channel if account == "hsa" and channel != "payroll" else None,
            # Years filled from the ledger (`ytd_from`) are not hand values.
            "ytd": {str(k): v for k, v in (c.get("ytd") or {}).items() if str(k) not in (c.get("ytdLedger") or {})},
            "ytd_from": c.get("ytdFrom"),
            "schedule": [_phase(p, channel) for p in c.get("schedule") or []],
        }
    )


_LIMIT_YAML = {v: k for k, v in runway.LIMIT_KEYS.items()}


def _limits(limits: dict | None) -> dict:
    out = {}
    for y, row in (limits or {}).items():
        vals = {_LIMIT_YAML[k]: v for k, v in (row or {}).items() if k in _LIMIT_YAML and v is not None}
        if vals:
            out[_year_key(y)] = vals
    return out


def _year_key(y: Any) -> Any:
    """Years are int keys in YAML (`2028:`)."""
    try:
        return int(y)
    except (TypeError, ValueError):
        return y


def _cash(c: dict) -> dict:
    return _clean(
        {
            "buffer": c.get("buffer"),
            "ef_months": c.get("efMonths"),
            "earmarks": [{"label": e.get("label"), "amount": e.get("amount")} for e in c.get("earmarks") or []],
            "dca_months": c.get("dcaMonths"),
            "card_payoff": {k: v for k, v in (c.get("cardPayoff") or {}).items() if v},
        }
    )


def denorm_body(b: dict) -> dict:
    """A normalized plan body (runway._resolve_body) as a canonical person
    mapping. normalize(denorm(x)) == x for anything the resolver produced."""
    pay = b.get("pay") or {}
    return _clean(
        {
            "label": b.get("label"),
            "birth_year": b.get("birthYear"),
            "pay": _clean(
                {
                    "schedule": _schedule(pay.get("schedule")),
                    "deductions": [_deduction(d) for d in pay.get("deductions") or []],
                    "withholding": _withholding(pay.get("withholding")),
                }
            ),
            "jobs": [_job(j) for j in b.get("jobs") or []],
            "hsa_coverage": [{"from": c.get("from"), "tier": c.get("tier")} for c in b.get("hsaCoverage") or []],
            "contributions": [_contribution(c) for c in b.get("contributions") or []],
            "limits": _limits(b.get("limits")),
            "spending": {"monthly": b.get("spendingMonthly")},
            "one_offs": [
                _clean({"id": o.get("id"), "month": o.get("month"), "amount": o.get("amount"), "label": o.get("label")})
                for o in b.get("oneOffs") or []
            ],
            "cash": _cash(b.get("cash") or {}),
            "returns": dict(b.get("returns") or {}),
            "play_cap": b.get("playCap"),
            "spread_through": b.get("spreadThrough"),
        }
    )


def denorm_shared(s: dict) -> dict:
    return _clean(
        {
            "returns": dict(s.get("returns") or {}),
            "limits": _limits(s.get("limits")),
            "play_cap": s.get("playCap"),
            "spread_through": s.get("spreadThrough"),
        }
    )


def _pick_shared(canon: dict, overrides: list[str]) -> dict:
    """`canon` with the shared settings cut down to the person's overrides
    (dotted payload paths such as `returns.equity`, `limits.2028.k401`)."""
    out = {k: v for k, v in canon.items() if k not in runway.SHARED_KEYS}
    ov = set(overrides)
    returns = {k: v for k, v in (canon.get("returns") or {}).items() if f"returns.{k}" in ov}
    if returns:
        out["returns"] = returns
    limits: dict = {}
    for y, row in (canon.get("limits") or {}).items():
        keep = {k: v for k, v in row.items() if f"limits.{y}.{runway.LIMIT_KEYS[k]}" in ov}
        if keep:
            limits[y] = keep
    if limits:
        out["limits"] = limits
    for key, payload in (("play_cap", "playCap"), ("spread_through", "spreadThrough")):
        if payload in ov and key in canon:
            out[key] = canon[key]
    return out


# ---------- ruamel documents ----------


def _yaml() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.width = 4096
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def _to_node(value: Any) -> Any:
    """Plain data -> ruamel nodes. Small mappings and scalar lists go inline
    (flow style), matching how the config is hand-written."""
    if isinstance(value, dict):
        m = CommentedMap()
        for k, v in value.items():
            m[k] = _to_node(v)
        if all(not isinstance(v, dict | list) or _inline_list(v) for v in value.values()) and len(value) <= 6:
            m.fa.set_flow_style()
        return m
    if isinstance(value, list):
        s = CommentedSeq(_to_node(v) for v in value)
        if _inline_list(value):
            s.fa.set_flow_style()
        return s
    if isinstance(value, str) and DATE_RE.match(value):
        try:
            return datetime.date.fromisoformat(value)
        except ValueError:
            return value
    return value


def _inline_list(v: Any) -> bool:
    return isinstance(v, list) and all(not isinstance(x, dict | list) for x in v)


def _same_key(a: Any, b: Any) -> bool:
    return str(a) == str(b) or (a is not None and b is not None and str(_year_key(a)) == str(_year_key(b)))


def _find_key(m: dict, key: Any) -> Any:
    for k in m:
        if _same_key(k, key):
            return k
    return None


def _step(node: Any, seg: Any, create: bool) -> Any:
    if isinstance(seg, dict):
        if not isinstance(node, list):
            raise SaveError(f"expected a list at {seg}")
        for item in node:
            if isinstance(item, dict) and str(item.get(seg["key"])) == str(seg["value"]):
                return item
        raise SaveError(f"no item with {seg['key']} {seg['value']!r}")
    if not isinstance(node, dict):
        raise SaveError(f"expected a mapping at {seg!r}")
    k = _find_key(node, seg)
    if k is None:
        if not create:
            return None
        _insert(node, _year_key(seg) if isinstance(seg, str) and seg.isdigit() else seg, CommentedMap())
        k = _find_key(node, seg)
    elif node[k] is None and create:
        node[k] = CommentedMap()
    return node[k]


def apply_ops(doc: CommentedMap, ops: list[dict]) -> None:
    """Replay diff_ops operations on a ruamel mapping, in place."""
    for op in ops:
        path = op["path"]
        if op["op"] == "append":
            parent = doc
            for seg in path[:-1]:
                parent = _step(parent, seg, create=True)
            last = path[-1] if path else None
            target = _step(parent, last, create=False) if last is not None else parent
            if target is None or not isinstance(target, list):
                target = CommentedSeq()
                parent[_find_key(parent, last) or last] = target
            target.append(_to_node(op["value"]))
            continue
        if not path:
            raise SaveError("cannot replace the whole document")
        parent = doc
        for seg in path[:-1]:
            parent = _step(parent, seg, create=op["op"] == "set")
            if parent is None:
                break
        if parent is None:
            continue
        last = path[-1]
        if isinstance(last, dict):
            idx = next(
                (
                    i
                    for i, item in enumerate(parent)
                    if isinstance(item, dict) and str(item.get(last["key"])) == str(last["value"])
                ),
                None,
            )
            if op["op"] == "delete":
                if idx is not None:
                    del parent[idx]
            elif idx is not None:
                parent[idx] = _to_node(op["value"])
            else:
                parent.append(_to_node(op["value"]))
            continue
        k = _find_key(parent, last)
        if op["op"] == "delete":
            if k is not None:
                del parent[k]
        elif k is not None:
            parent[k] = _to_node(op["value"])
        else:
            key = _year_key(last) if isinstance(last, str) and last.isdigit() else last
            _insert(parent, key, _to_node(op["value"]))


def _dump(y: YAML, doc: Any) -> str:
    buf = io.StringIO()
    y.dump(doc, buf)
    return buf.getvalue()


_WS = re.compile(r"\s+")
_INNER = re.compile(r"([\[{])\s+|\s+([\]}])")


def _norm_line(line: str) -> str:
    """A line with whitespace that ruamel does not preserve squeezed out
    (padding inside flow braces, comment alignment)."""
    return _INNER.sub(lambda m: m.group(1) or m.group(2), _WS.sub(" ", line.strip()))


def keep_layout(original: str, dumped: str) -> str:
    """`dumped` with every line that only differs from `original` in
    whitespace put back as it was, so a save leaves untouched lines alone."""
    a = original.splitlines(keepends=True)
    b = dumped.splitlines(keepends=True)
    sm = difflib.SequenceMatcher(None, [_norm_line(x) for x in a], [_norm_line(x) for x in b], autojunk=False)
    padded = "{ " in original
    out: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(a[i1:i2])
        else:
            out.extend(_pad_flow(x) if padded else x for x in b[j1:j2])
    return "".join(out)


def _pad_flow(line: str) -> str:
    """`{a: 1}` -> `{ a: 1 }` (and the same for brackets), outside quotes and
    comments, matching a hand-written file's style."""
    out: list[str] = []
    quote: str | None = None
    for i, ch in enumerate(line):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] == " "):
            out.append(line[i:])
            break
        elif ch in "}]" and out and out[-1] not in " {[":
            out.append(" ")
        out.append(ch)
        if ch in "{[" and i + 1 < len(line) and line[i + 1] not in " }]\n":
            out.append(" ")
    return "".join(out)


#: Top-level person keys in schema order; a new key goes before the first
#: existing key that follows it, not after trailing comments at the end.
PERSON_ORDER = (
    "id", "label", "birth_year", "pay", "jobs", "hsa_coverage", "contributions", "limits",
    "spending", "one_offs", "cash", "returns", "play_cap", "spread_through", "scenarios",
    "starting", "sleeve_info", "not_modeled",
)


def _insert(m: CommentedMap, key: Any, value: Any) -> None:
    if key in PERSON_ORDER and any(k in PERSON_ORDER for k in m):
        rank = PERSON_ORDER.index(key)
        for pos, k in enumerate(m):
            if k in PERSON_ORDER and PERSON_ORDER.index(k) > rank:
                m.insert(pos, key, value)
                return
    m[key] = value


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        if path.exists():
            os.chmod(tmp, path.stat().st_mode & 0o7777)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ---------- save ----------


def _plain(node: Any) -> Any:
    """ruamel nodes -> plain data, as yaml.safe_load would give."""
    import yaml

    return yaml.safe_load(_dump(_yaml(), node)) if node is not None else None


def save(
    *,
    ledger,
    entries,
    ledger_file_path: str,
    today: datetime.date,
    body: dict,
) -> dict:
    """Apply one save request. Returns {"status": "ok", "written": [...]}.

    body = {
      version,                       # from runway_data; stale -> 409
      person?: {                     # one person's edits, when any
        id, plan, overrides,         # normalized plan body, shared paths it sets
        scenarios: [{id, label, person}],   # all of them, in display order
      },
      shared?: {...}                 # normalized shared defaults, when edited
    }
    """
    path = runway.runway_config_path(ledger_file_path).resolve()
    if body.get("version") != runway.config_version(ledger_file_path):
        raise SaveError("runway.yaml changed since the page loaded; reload to see it", status=409)
    current = runway.build_runway_data(
        ledger=ledger, entries=entries, ledger_file_path=ledger_file_path, today=today
    )
    y = _yaml()
    main_text = path.read_text(encoding="utf-8")
    originals: dict[Path, str] = {path: main_text}
    main = y.load(main_text)
    if not isinstance(main, CommentedMap):
        raise SaveError("runway.yaml must be a mapping")
    root = runway.ledger_root(ledger_file_path)
    touched: dict[Path, Any] = {}

    shared = body.get("shared")
    if shared is not None:
        ops = diff_ops(denorm_shared(shared), denorm_shared(current["shared"]))
        if ops:
            if not isinstance(main.get("defaults"), dict):
                main["defaults"] = CommentedMap()
            apply_ops(main["defaults"], ops)
            touched[path] = main

    edit = body.get("person")
    if edit is not None:
        pid = edit.get("id")
        saved = next((p for p in current["people"] if p["id"] == pid), None)
        if saved is None:
            raise SaveError(f"person {pid!r} cannot be saved (locked, missing or invalid)")
        if saved.get("readOnly"):
            raise SaveError(f"{saved['label']}'s file is read-only")
        entry = next(
            (e for e in main.get("people") or [] if isinstance(e, dict) and _entry_id(e, root) == pid),
            None,
        )
        if entry is None:
            raise SaveError(f"person {pid!r} is not in runway.yaml")
        include = entry.get("include") or entry.get("file")
        inc_path = (root / include).resolve() if include else None
        inc_doc = None
        if inc_path:
            originals[inc_path] = inc_path.read_text(encoding="utf-8")
            inc_doc = y.load(originals[inc_path])

        def target_for(top_key: str) -> tuple[Path, CommentedMap]:
            """Inline keys beside `include` win, so write them there."""
            if inc_doc is None or top_key in entry:
                return path, entry
            return inc_path, inc_doc  # type: ignore[return-value]

        plan = edit.get("plan") or {}
        new_plan = _pick_shared(denorm_body(plan), edit.get("overrides") or [])
        old_plan = _pick_shared(denorm_body(saved), saved.get("overrides") or [])
        for op in diff_ops(new_plan, old_plan):
            file, doc = target_for(op["path"][0])
            apply_ops(doc, [op])
            touched[file] = main if file == path else doc

        # Scenarios: patches over the plan, compared in canonical form.
        new_base, old_base = denorm_body(plan), denorm_body(saved)
        new_list = [
            {"id": s["id"], "label": s.get("label") or s["id"], "patch": diff_patch(denorm_body(s["person"]), new_base)}
            for s in edit.get("scenarios") or []
        ]
        old_list = [
            {"id": s["id"], "label": s["label"], "patch": diff_patch(denorm_body(s["person"]), old_base)}
            for s in saved.get("scenarios") or []
        ]
        ops = diff_ops({"scenarios": new_list}, {"scenarios": old_list})
        if ops:
            file, doc = target_for("scenarios")
            if not isinstance(doc.get("scenarios"), list):
                doc["scenarios"] = CommentedSeq()
            apply_ops(doc, ops)
            _reorder(doc["scenarios"], [s["id"] for s in new_list])
            touched[file] = main if file == path else doc

    if not touched:
        return {"status": "ok", "written": []}

    # Validate the result in memory before anything is written.
    raw = _plain(main) or {}
    includes = {}
    for e in raw.get("people") or []:
        inc = isinstance(e, dict) and (e.get("include") or e.get("file"))
        if inc and (root / inc).resolve() in touched:
            includes[inc] = _plain(touched[(root / inc).resolve()]) or {}
    result = runway.build_runway_data(
        ledger=ledger,
        entries=entries,
        ledger_file_path=ledger_file_path,
        today=today,
        raw=raw,
        includes=includes,
    )
    before = {(e["path"], e["message"]) for e in current["errors"]}
    new_errors = [e for e in result["errors"] if (e["path"], e["message"]) not in before]
    if new_errors:
        raise SaveError("the edits do not validate; nothing was saved", status=422, issues=new_errors)

    written = []
    for file, doc in touched.items():
        _atomic_write(file, keep_layout(originals[file], _dump(y, doc)))
        written.append(str(file.relative_to(root.resolve())) if file.is_relative_to(root.resolve()) else file.name)
    return {"status": "ok", "written": sorted(written)}


def _entry_id(entry: dict, root: Path) -> str | None:
    if isinstance(entry.get("id"), str):
        return entry["id"]
    inc = entry.get("include") or entry.get("file")
    if isinstance(inc, str):
        data, _, _ = runway.resolve_include(root, inc)
        if data and isinstance(data.get("id"), str):
            return data["id"]
    return None


def _reorder(seq: CommentedSeq, ids: list[str]) -> None:
    """Put scenarios in the page's order, keeping each item's node (and its
    comments)."""
    rank = {sid: i for i, sid in enumerate(ids)}
    items = list(seq)
    ordered = sorted(items, key=lambda x: rank.get(str(x.get("id")) if isinstance(x, dict) else "", len(ids)))
    if [id(x) for x in ordered] != [id(x) for x in items]:
        seq[:] = ordered


__all__ = ["SaveError", "apply_ops", "denorm_body", "denorm_shared", "save"]
