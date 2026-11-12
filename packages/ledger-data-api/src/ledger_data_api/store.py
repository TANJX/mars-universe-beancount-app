"""Disk read/write helpers for the planner's persistence layer.

File layout under <ledger_dir>/plan/:
    plans.jsonl           one event per line: {"op": "save"|"delete", ...}
    transfers.jsonl       one event per line: same shape
    cc-cards.json         atomic JSON object keyed by account path
    cc-expected.json      atomic JSON object keyed by account path (at most one
                          expected statement per card)
    settings.json         atomic JSON object

Read-only here, under <ledger_dir>/statements/billing/credit/:
    <CardName>.jsonl      closed card statements, written by the fetch command

Plus user-facing config under <ledger_dir>/config/:
    ui.yaml               UI customization (branding, accounts, merchants, sidebar)
"""

import datetime
import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional
from uuid import uuid4

import yaml

from . import billing
from .billing import Statement
from .models import CCCardRecord, ExpectedStatement, Plan, PlanSettings, Transfer

log = logging.getLogger(__name__)

PLAN_LOCK = threading.RLock()
"""Held around every read-modify-write that touches both plans.jsonl and
cc-expected.json (promotion, expected save/delete). Re-entrant so the
reconcile step can call the expected-statement writers while holding it."""


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid4().hex


def plan_dir(ledger_file_path: str) -> Path:
    return Path(ledger_file_path).parent / "plan"


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


# ---------- plans / transfers (JSONL append + reduce) ----------


def _read_jsonl_reduce(path: Path) -> list[dict]:
    """Read a JSONL event log and reduce to the latest non-deleted state per id."""
    if not path.exists():
        return []
    state: dict[str, dict] = {}
    with path.open("r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            op = event.get("op")
            rid = event.get("id")
            if not rid:
                continue
            if op == "save":
                payload = {k: v for k, v in event.items() if k != "op"}
                state[rid] = payload
            elif op == "delete":
                state.pop(rid, None)
    return list(state.values())


def _append_jsonl(path: Path, event: dict) -> None:
    _ensure_dir(path.parent)
    with path.open("a") as f:
        f.write(json.dumps(event) + "\n")


def list_plans(ledger_file_path: str) -> list[Plan]:
    path = plan_dir(ledger_file_path) / "plans.jsonl"
    return [Plan.from_dict(d) for d in _read_jsonl_reduce(path)]


def save_plan(ledger_file_path: str, plan: Plan) -> Plan:
    if not plan.id:
        plan.id = new_id()
    if not plan.createdAt:
        plan.createdAt = now_iso()
    plan.updatedAt = now_iso()
    event = {"op": "save", **plan.to_dict()}
    path = plan_dir(ledger_file_path) / "plans.jsonl"
    _append_jsonl(path, event)
    return plan


def delete_plan(ledger_file_path: str, plan_id: str) -> None:
    event = {"op": "delete", "id": plan_id, "deletedAt": now_iso()}
    path = plan_dir(ledger_file_path) / "plans.jsonl"
    _append_jsonl(path, event)


def append_plan_events(ledger_file_path: str, events: list[dict]) -> None:
    """Append several plan events in one open-and-write."""
    if not events:
        return
    path = plan_dir(ledger_file_path) / "plans.jsonl"
    _ensure_dir(path.parent)
    with path.open("a") as f:
        f.write("".join(json.dumps(event) + "\n" for event in events))


def replace_cc_override(
    ledger_file_path: str,
    card_account_path: str,
    plans: list[Plan],
    *,
    statement_id: Optional[str] = None,
    cycle_month: Optional[str] = None,
    existing_ids: Optional[set[str]] = None,
) -> list[Plan]:
    """Atomically replace the override plan-set for one card statement.

    Exactly one of `statement_id` / `cycle_month` is given.

    `statement_id`: each plan is tagged with the statement and no cycle
    month. The set being replaced is `existing_ids`, supplied by the caller
    from the read-time resolution (it can include legacy rows that map to
    this statement).

    `cycle_month` (legacy, cards with no statement records): the set being
    replaced is every plan of the card tagged with that month and no
    statement id.

    Delete events for plans missing from the new set and save events for the
    new set go out in one write, so the on-disk view never shows a
    half-applied state.
    """
    if (statement_id is None) == (cycle_month is None):
        raise ValueError("exactly one of statement_id / cycle_month is required")
    if statement_id is not None:
        existing = set(existing_ids or ())
    else:
        existing = {
            p.id
            for p in list_plans(ledger_file_path)
            if p.ccCardRef == card_account_path
            and p.ccCycleMonth == cycle_month
            and p.ccStatementId is None
        }
    incoming_ids = {p.id for p in plans if p.id}

    saved: list[Plan] = []
    events: list[dict] = []
    for plan in plans:
        if not plan.id:
            plan.id = new_id()
        if not plan.createdAt:
            plan.createdAt = now_iso()
        plan.updatedAt = now_iso()
        plan.ccCardRef = card_account_path
        plan.ccCycleMonth = cycle_month
        plan.ccStatementId = statement_id
        events.append({"op": "save", **plan.to_dict()})
        saved.append(plan)

    for stale_id in sorted(existing - incoming_ids):
        events.append({"op": "delete", "id": stale_id, "deletedAt": now_iso()})

    append_plan_events(ledger_file_path, events)
    return saved


def list_transfers(ledger_file_path: str) -> list[Transfer]:
    path = plan_dir(ledger_file_path) / "transfers.jsonl"
    return [Transfer.from_dict(d) for d in _read_jsonl_reduce(path)]


def save_transfer(ledger_file_path: str, transfer: Transfer) -> Transfer:
    if not transfer.id:
        transfer.id = new_id()
    if not transfer.createdAt:
        transfer.createdAt = now_iso()
    transfer.updatedAt = now_iso()
    event = {"op": "save", **transfer.to_dict()}
    path = plan_dir(ledger_file_path) / "transfers.jsonl"
    _append_jsonl(path, event)
    return transfer


def delete_transfer(ledger_file_path: str, transfer_id: str) -> None:
    event = {"op": "delete", "id": transfer_id, "deletedAt": now_iso()}
    path = plan_dir(ledger_file_path) / "transfers.jsonl"
    _append_jsonl(path, event)


# ---------- cc-cards.json (atomic full-record JSON) ----------


def _read_json_object(path: Path, default) -> dict:
    if not path.exists():
        return default
    try:
        with path.open("r") as f:
            return json.load(f)
    except json.JSONDecodeError:
        return default


def _write_json_atomic(path: Path, data) -> None:
    _ensure_dir(path.parent)
    fd, tmp_path = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def list_cc_card_records(ledger_file_path: str) -> dict[str, CCCardRecord]:
    path = plan_dir(ledger_file_path) / "cc-cards.json"
    raw = _read_json_object(path, {})
    return {
        account_path: CCCardRecord.from_dict(account_path, payload)
        for account_path, payload in raw.items()
        if isinstance(payload, dict)
    }


def save_cc_card_record(ledger_file_path: str, record: CCCardRecord) -> CCCardRecord:
    record.updatedAt = now_iso()
    path = plan_dir(ledger_file_path) / "cc-cards.json"
    raw = _read_json_object(path, {})
    raw[record.accountPath] = record.to_storage_dict()
    _write_json_atomic(path, raw)
    return record


def delete_cc_card_record(ledger_file_path: str, account_path: str) -> None:
    path = plan_dir(ledger_file_path) / "cc-cards.json"
    raw = _read_json_object(path, {})
    if account_path in raw:
        del raw[account_path]
        _write_json_atomic(path, raw)


# ---------- card statements (facts, read-only) ----------


def statements_dir(ledger_file_path: str) -> Path:
    """<ledger_dir>/statements, sibling of journal/."""
    return Path(ledger_file_path).parent.parent / "statements"


def list_statements(ledger_file_path: str) -> dict[str, list[Statement]]:
    """Closed statements per card account, ascending by closing date."""
    return billing.read_all(statements_dir(ledger_file_path))


# ---------- cc-expected.json (atomic JSON, one expected statement per card) ----------


def _expected_path(ledger_file_path: str) -> Path:
    return plan_dir(ledger_file_path) / "cc-expected.json"


PROMOTED_KEY = "_promoted"
"""Reserved key in cc-expected.json: the last promotion per card, as
{account: {"from": expected id, "to": closed id, "at": timestamp}}. It lets a
request that still names the old expected id (a dialog opened before the
statement closed) be mapped to the closed statement that claimed it."""


def list_expected_statements(ledger_file_path: str) -> dict[str, ExpectedStatement]:
    raw = _read_json_object(_expected_path(ledger_file_path), {})
    if not isinstance(raw, dict):
        return {}
    out: dict[str, ExpectedStatement] = {}
    for account, payload in raw.items():
        if account == PROMOTED_KEY or not isinstance(payload, dict):
            continue
        rec = ExpectedStatement.from_dict(account, payload)
        if not billing._is_date(rec.id):
            continue
        out[account] = rec
    return out


def save_expected_statement(
    ledger_file_path: str, rec: ExpectedStatement
) -> ExpectedStatement:
    if not rec.createdAt:
        rec.createdAt = now_iso()
    rec.updatedAt = now_iso()
    path = _expected_path(ledger_file_path)
    with PLAN_LOCK:
        raw = _read_json_object(path, {})
        if not isinstance(raw, dict):
            raw = {}
        raw[rec.account] = rec.to_storage_dict()
        _write_json_atomic(path, raw)
    return rec


def delete_expected_statement(ledger_file_path: str, account: str) -> None:
    path = _expected_path(ledger_file_path)
    with PLAN_LOCK:
        raw = _read_json_object(path, {})
        if isinstance(raw, dict) and account in raw:
            del raw[account]
            _write_json_atomic(path, raw)


def promote_expected_statement(
    ledger_file_path: str, account: str, expected_id: str, closed_id: str
) -> None:
    """Drop a card's expected statement and remember which closed statement
    claimed it, in one atomic write."""
    path = _expected_path(ledger_file_path)
    with PLAN_LOCK:
        raw = _read_json_object(path, {})
        if not isinstance(raw, dict):
            raw = {}
        raw.pop(account, None)
        promoted = raw.get(PROMOTED_KEY)
        if not isinstance(promoted, dict):
            promoted = {}
        promoted[account] = {"from": expected_id, "to": closed_id, "at": now_iso()}
        raw[PROMOTED_KEY] = promoted
        _write_json_atomic(path, raw)


def list_promotions(ledger_file_path: str) -> dict[str, tuple[str, str]]:
    """account -> (expected id, closed id) of the card's last promotion."""
    raw = _read_json_object(_expected_path(ledger_file_path), {})
    promoted = raw.get(PROMOTED_KEY) if isinstance(raw, dict) else None
    if not isinstance(promoted, dict):
        return {}
    out: dict[str, tuple[str, str]] = {}
    for account, payload in promoted.items():
        if not isinstance(payload, dict):
            continue
        old, new = payload.get("from"), payload.get("to")
        if billing._is_date(old) and billing._is_date(new):
            out[account] = (old, new)
    return out


# ---------- settings.json ----------


def get_plan_settings(ledger_file_path: str) -> PlanSettings:
    path = plan_dir(ledger_file_path) / "settings.json"
    return PlanSettings.from_dict(_read_json_object(path, {}))


def save_plan_settings(ledger_file_path: str, settings: PlanSettings) -> PlanSettings:
    path = plan_dir(ledger_file_path) / "settings.json"
    _write_json_atomic(path, settings.to_dict())
    return settings


# ---------- ui.yaml ----------


def ui_config_path(ledger_file_path: str) -> Path:
    """Return the expected location of ui.yaml.

    Layout: <ledger_dir>/journal/journal.beancount → <ledger_dir>/config/ui.yaml.
    `ledger_file_path` points at the journal file; `.parent.parent` is the
    ledger root, sibling of `config/`.
    """
    return Path(ledger_file_path).parent.parent / "config" / "ui.yaml"


def read_ui_config(ledger_file_path: str) -> dict:
    """Read user UI config. Returns {} on absent / empty / malformed file.

    Malformed YAML is logged but does not raise — the web app falls back to
    bundled defaults so a typo can't take down the UI.
    """
    path = ui_config_path(ledger_file_path)
    if not path.exists():
        return {}
    try:
        with path.open("r") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as ex:
        log.warning("ui.yaml at %s is malformed: %s", path, ex)
        return {}
    if data is None:
        return {}
    if not isinstance(data, dict):
        log.warning(
            "ui.yaml at %s did not parse to a mapping (got %s)",
            path,
            type(data).__name__,
        )
        return {}
    return data
