"""Card statements for the planner: facts, intent, and how plans point at them.

- FACTS: closed statements, read from `statements/billing/credit/*.jsonl`
  (`billing.py`). Identity is (account, closing date). Never written here.
- INTENT: at most one EXPECTED statement per card (`cc-expected.json`), so a
  payment can be planned before the statement closes, plus override plans in
  `plans.jsonl` tagged with `ccStatementId`.

A card with at least one closed statement is in "statement mode". A card with
none is in "legacy mode" and everything keeps working off cc-cards.json
(`statementBalance`, `paymentDueDay`, `lastClosedDate`, `ccCycleMonth` tags).

This module owns:
- per-card state (`card_state`): active statement, cycle, next close/due;
- promotion (`reconcile_expected`): a newly closed statement claims the
  card's expected statement, and plans follow it;
- read-time resolution of a plan's statement (`resolve_plan_statements`);
- the validation behind the statement endpoints, kept free of Flask so it can
  be tested directly (`save_override`, `save_expected`, `delete_expected`,
  `save_plan_from_body`, `save_cc_card`, `statements_response`).
"""

import dataclasses
import datetime
import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from . import store
from .billing import Statement, _is_date
from .cc_cycle import (
    MIN_NEXT_CLOSE_GAP_DAYS,
    SETTLEMENT_GRACE_DAYS,
    STATEMENT_OVERDUE_DAYS,
    Cycle,
    predict_due,
    predict_next_close,
)
from .models import CCCardRecord, ExpectedStatement, Plan

log = logging.getLogger(__name__)

MAX_CARD_STATEMENTS = 12
"""How many closed statements a ccCards item carries (newest first)."""


class ApiError(Exception):
    """A request the endpoint must reject with HTTP 400. Nothing was written."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _date(value: str) -> datetime.date:
    return datetime.date.fromisoformat(value)


def _month(d: datetime.date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


# ---------- per-card state ----------


def effective_due(stmt: Statement, due_day: int | None) -> datetime.date:
    """The statement's due date, predicted from `due_day` when none is on file."""
    if stmt.dueDate:
        return _date(stmt.dueDate)
    return predict_due(_date(stmt.id), due_day)


@dataclass(frozen=True)
class CardState:
    account: str
    statements: list[Statement]  # closed, ascending; empty in legacy mode
    has_statements: bool
    active: Statement | None
    active_cycle: Cycle | None  # start = closing date, end = effective due
    expected: ExpectedStatement | None  # None in legacy mode
    next_close: datetime.date | None  # None in legacy mode
    next_due: datetime.date | None  # None in legacy mode


def card_state(
    account: str,
    statements: list[Statement],
    expected: ExpectedStatement | None,
    rec: CCCardRecord | None,
    today: datetime.date,
) -> CardState:
    """Where a card stands today.

    The active statement is the newest closed statement whose due date plus
    the settlement grace has not passed. None once it has (the gap before
    the next statement closes): nothing is locked then, only the forecast.
    """
    statements = sorted(statements, key=lambda s: s.id)
    if not statements:
        return CardState(account, [], False, None, None, None, None, None)

    due_day = rec.paymentDueDay if rec else None
    close_day = rec.statementCloseDay if rec else None
    grace = datetime.timedelta(days=SETTLEMENT_GRACE_DAYS)

    active: Statement | None = None
    cycle: Cycle | None = None
    for stmt in reversed(statements):
        due = effective_due(stmt, due_day)
        if today <= due + grace:
            active = stmt
            cycle = Cycle(start=_date(stmt.id), end=due, dueMonth=_month(due))
            break

    if expected is not None:
        next_close = _date(expected.id)
    else:
        next_close = predict_next_close([s.id for s in statements], close_day)
    if expected is not None and expected.dueDate and _is_date(expected.dueDate):
        next_due = _date(expected.dueDate)
    else:
        next_due = predict_due(next_close, due_day)

    return CardState(
        account=account,
        statements=statements,
        has_statements=True,
        active=active,
        active_cycle=cycle,
        expected=expected,
        next_close=next_close,
        next_due=next_due,
    )


def statement_expected_since(
    state: CardState, today: datetime.date, owed: Decimal
) -> datetime.date | None:
    """The predicted closing date once it is more than STATEMENT_OVERDUE_DAYS
    in the past with no record for it.

    `owed` is the ledger balance owed on the card (0 for a dormant or
    in-credit card): a card that owes nothing raises no signal. Always None
    in legacy mode.
    """
    if not state.has_statements or state.next_close is None:
        return None
    if owed <= 0:
        return None
    if today > state.next_close + datetime.timedelta(days=STATEMENT_OVERDUE_DAYS):
        return state.next_close
    return None


# ---------- promotion ----------


def promotions(
    expected: dict[str, ExpectedStatement],
    statements: dict[str, list[Statement]],
) -> dict[str, tuple[str, str]]:
    """account -> (expected id, claiming closed id).

    A closed statement newer than the expected statement's `afterId` claims
    it, however far apart the two dates are. With several such statements the
    earliest one claims. With no `afterId`, any closed statement claims.

    One exception: when the `afterId` statement itself is no longer on record
    (it was voided), a statement that closed well before the expected one
    (more than MIN_NEXT_CLOSE_GAP_DAYS earlier) is the corrected copy of that
    previous statement, not the next cycle, and does not claim.
    """
    out: dict[str, tuple[str, str]] = {}
    for account, exp in expected.items():
        ids = sorted(s.id for s in statements.get(account, []))
        if exp.afterId:
            after_gone = exp.afterId not in ids
            ids = [i for i in ids if i > exp.afterId]
            if after_gone:
                floor = (
                    _date(exp.id) - datetime.timedelta(days=MIN_NEXT_CLOSE_GAP_DAYS)
                ).isoformat()
                ids = [i for i in ids if i >= floor]
        if ids:
            out[account] = (exp.id, ids[0])
    return out


@dataclass
class StatementData:
    statements: dict[str, list[Statement]]
    expected: dict[str, ExpectedStatement]  # after promotion (claimed ones removed)
    plans: list[Plan]  # after re-pointing
    promoted: dict[str, tuple[str, str]]
    persisted: bool  # False when a needed write failed: the mapping is virtual


def reconcile_expected(
    ledger_file_path: str | None,
    plans: list[Plan],
    expected: dict[str, ExpectedStatement],
    statements: dict[str, list[Statement]],
) -> StatementData:
    """Let newly closed statements claim expected statements.

    Every override plan pointing at a claimed expected id is re-pointed to
    the closed id, and the expected record is dropped. The returned state
    always reflects that. On disk it is persisted in one step under
    `store.PLAN_LOCK`: plan events first (one write), then the record
    deletes, so a crash in between is finished by the next call. A failed
    write (the NAS replica mounts journal/plan read-only) is logged and
    leaves the mapping virtual: the same result is recomputed on every read.
    Never raises; a second call writes nothing.
    """
    promoted = promotions(expected, statements)
    if not promoted:
        return StatementData(statements, dict(expected), list(plans), {}, True)

    mapped: list[Plan] = []
    for p in plans:
        claim = promoted.get(p.ccCardRef) if p.ccCardRef else None
        if claim is not None and p.ccStatementId == claim[0]:
            p = dataclasses.replace(p, ccStatementId=claim[1])
        mapped.append(p)
    remaining = {a: e for a, e in expected.items() if a not in promoted}

    persisted = True
    if ledger_file_path is not None:
        try:
            _persist_promotions(ledger_file_path, promoted)
        except OSError as ex:
            persisted = False
            log.warning(
                "could not persist statement promotion (%s); mapping at read time",
                type(ex).__name__,
            )
    return StatementData(statements, remaining, mapped, promoted, persisted)


def _persist_promotions(
    ledger_file_path: str, promoted: dict[str, tuple[str, str]]
) -> None:
    with store.PLAN_LOCK:
        # Re-read inside the lock: a concurrent call may have done the work.
        disk_expected = store.list_expected_statements(ledger_file_path)
        todo = {
            account: claim
            for account, claim in promoted.items()
            if account in disk_expected and disk_expected[account].id == claim[0]
        }
        if not todo:
            return
        events: list[dict] = []
        now = store.now_iso()
        for p in store.list_plans(ledger_file_path):
            claim = todo.get(p.ccCardRef) if p.ccCardRef else None
            if claim is None or p.ccStatementId != claim[0]:
                continue
            if claim[0] == claim[1]:
                continue  # closed on the predicted date: already points at it
            moved = dataclasses.replace(p, ccStatementId=claim[1], updatedAt=now)
            events.append({"op": "save", **moved.to_dict()})
        store.append_plan_events(ledger_file_path, events)
        for account in sorted(todo):
            store.promote_expected_statement(ledger_file_path, account, *todo[account])


def load_statement_data(
    ledger_file_path: str, plans: list[Plan] | None = None
) -> StatementData:
    """Statements + expected statements + plans, reconciled. Safe on reads.

    The three are read as one snapshot under `store.PLAN_LOCK`, the lock a
    promotion holds while it rewrites plans and drops the expected record. A
    caller must not pass a plan list it read earlier: a promotion persisted
    in between would leave those plans pointing at an expected id that no
    longer exists (`plans` is for tests and in-memory callers only).
    """
    with store.PLAN_LOCK:
        statements = store.list_statements(ledger_file_path)
        expected = store.list_expected_statements(ledger_file_path)
        if plans is None:
            plans = store.list_plans(ledger_file_path)
        return reconcile_expected(ledger_file_path, plans, expected, statements)


def promoted_to(
    ledger_file_path: str, data: StatementData, account: str, statement_id: str
) -> str | None:
    """The closed statement id that claimed `statement_id` when that id is a
    card's promoted expected statement: promoted by this very read, or by an
    earlier one (remembered in cc-expected.json). None otherwise."""
    claim = data.promoted.get(account)
    if claim is None:
        claim = store.list_promotions(ledger_file_path).get(account)
    if claim is not None and claim[0] == statement_id:
        return claim[1]
    return None


# ---------- which statement a plan belongs to ----------


def _expected_due(state: CardState) -> datetime.date | None:
    return state.next_due if state.expected is not None else None


def resolve_plan_statements(
    plans: list[Plan],
    states: dict[str, CardState],
    cc_records: dict[str, CCCardRecord],
) -> dict[str, tuple[str | None, str]]:
    """plan id -> (statement id, kind) for every plan tagged with a card.

    kind:
    - "closed" / "expected": the plan overrides that statement.
    - "legacy": a due-month row with no statement to map to. It still
      suppresses, by the old due-month join, projections that have no
      statement record.
    - "orphan": points at nothing (unknown or voided statement id). A plain
      plan that suppresses nothing.

    A legacy row (only `ccCycleMonth`) on a statement-mode card maps to a
    statement when exactly one statement of the card (closed or expected) is
    due in that month. Read-time only: nothing is rewritten.
    """
    out: dict[str, tuple[str | None, str]] = {}
    for p in plans:
        if not p.ccCardRef:
            continue
        state = states.get(p.ccCardRef)
        if state is None or not state.has_statements:
            out[p.id] = (None, "legacy" if p.ccCycleMonth else "orphan")
            continue
        if p.ccStatementId:
            if any(s.id == p.ccStatementId for s in state.statements):
                out[p.id] = (p.ccStatementId, "closed")
            elif state.expected is not None and state.expected.id == p.ccStatementId:
                out[p.id] = (p.ccStatementId, "expected")
            else:
                out[p.id] = (None, "orphan")
            continue
        if not p.ccCycleMonth:
            out[p.id] = (None, "orphan")
            continue
        rec = cc_records.get(p.ccCardRef)
        due_day = rec.paymentDueDay if rec else None
        candidates: list[tuple[str, str]] = [
            (s.id, "closed")
            for s in state.statements
            if _month(effective_due(s, due_day)) == p.ccCycleMonth
        ]
        exp_due = _expected_due(state)
        if exp_due is not None and _month(exp_due) == p.ccCycleMonth:
            candidates.append((state.expected.id, "expected"))
        out[p.id] = candidates[0] if len(candidates) == 1 else (None, "legacy")
    return out


# ---------- payloads ----------


def statement_payload(stmt: Statement, due_day: int | None) -> dict:
    return {
        "kind": "closed",
        "account": stmt.account,
        "id": stmt.id,
        "statementBalance": stmt.statementBalance,
        "dueDate": stmt.dueDate,
        "minimumPayment": stmt.minimumPayment,
        "source": stmt.source,
        "capturedAt": stmt.capturedAt,
        "effectiveDueDate": effective_due(stmt, due_day).isoformat(),
    }


def expected_payload(e: ExpectedStatement) -> dict:
    return {
        "kind": "expected",
        "account": e.account,
        "id": e.id,
        "dueDate": e.dueDate,
        "estimatedBalance": e.estimatedBalance,
        "afterId": e.afterId,
        "createdAt": e.createdAt,
        "updatedAt": e.updatedAt,
    }


def card_statement_fields(
    state: CardState,
    rec: CCCardRecord | None,
    today: datetime.date,
    owed: Decimal,
    limit: int | None = MAX_CARD_STATEMENTS,
) -> dict:
    """The statement keys of a ccCards item (all null / empty in legacy mode)."""
    due_day = rec.paymentDueDay if rec else None
    newest_first = list(reversed(state.statements))
    if limit is not None:
        newest_first = newest_first[:limit]
    since = statement_expected_since(state, today, owed)
    return {
        "hasStatements": state.has_statements,
        "activeStatement": (
            statement_payload(state.active, due_day) if state.active else None
        ),
        "expectedStatement": (
            expected_payload(state.expected) if state.expected else None
        ),
        "statements": [statement_payload(s, due_day) for s in newest_first],
        "nextCloseDate": state.next_close.isoformat() if state.next_close else None,
        "nextDueDate": state.next_due.isoformat() if state.next_due else None,
        "statementExpectedSince": since.isoformat() if since else None,
    }


# ---------- endpoint logic (no Flask) ----------


def _load(ledger_file_path: str, account: str, today: datetime.date):
    data = load_statement_data(ledger_file_path)
    cc_records = store.list_cc_card_records(ledger_file_path)
    state = card_state(
        account,
        data.statements.get(account, []),
        data.expected.get(account),
        cc_records.get(account),
        today,
    )
    return data, cc_records, state


def statements_response(
    ledger_file_path: str, account: str, today: datetime.date | None = None
) -> dict:
    """GET cc_statements: every closed statement of a card, newest first."""
    if not account:
        raise ApiError("missing account")
    today = today or datetime.date.today()
    _, cc_records, state = _load(ledger_file_path, account, today)
    fields = card_statement_fields(
        state, cc_records.get(account), today, Decimal(0), limit=None
    )
    return {
        "account": account,
        "hasStatements": fields["hasStatements"],
        "statements": fields["statements"],
        "expectedStatement": fields["expectedStatement"],
    }


def _plans_from_body(raw_plans, card_path: str) -> list[Plan]:
    if not isinstance(raw_plans, list):
        raise ApiError("plans must be a list")
    plans: list[Plan] = []
    for raw in raw_plans:
        if not isinstance(raw, dict):
            continue
        if not raw.get("date") or not raw.get("account"):
            raise ApiError("each plan needs a date and an account")
        plans.append(
            Plan.from_dict(
                {
                    "id": raw.get("id") or store.new_id(),
                    "date": raw["date"],
                    "account": raw["account"],
                    "amount": raw.get("amount", ""),
                    "description": raw.get("description", ""),
                    "state": raw.get("state"),
                    "transferId": raw.get("transferId"),
                    "createdAt": raw.get("createdAt") or "",
                    "updatedAt": raw.get("updatedAt") or "",
                    "ccCardRef": card_path,
                }
            )
        )
    return plans


def save_override(
    ledger_file_path: str, body: dict, today: datetime.date | None = None
) -> list[Plan]:
    """POST cc_override_save: replace the override plan-set of one statement.

    Body: {cardAccountPath, statementId? | cycleMonth?, plans: [...]}.

    `statementId` is a strict foreign key: it must be a closed statement id
    or the expected statement id of that card (an expected id that has been
    promoted, by this request or an earlier read, is accepted and replaced
    by the closed id that claimed it).
    `cycleMonth` is accepted only for a card with no statement records.
    Raises ApiError, having written nothing, otherwise.
    """
    today = today or datetime.date.today()
    card_path = body.get("cardAccountPath")
    if not card_path or not isinstance(card_path, str):
        raise ApiError("missing cardAccountPath")
    statement_id = body.get("statementId")
    cycle_month = body.get("cycleMonth")
    if not statement_id and not cycle_month:
        raise ApiError("missing statementId / cycleMonth")
    plans = _plans_from_body(body.get("plans") or [], card_path)

    with store.PLAN_LOCK:
        data, cc_records, state = _load(ledger_file_path, card_path, today)
        if statement_id:
            known = {s.id for s in state.statements}
            if state.expected is not None:
                known.add(state.expected.id)
            if statement_id not in known:
                claimed_by = promoted_to(
                    ledger_file_path, data, card_path, statement_id
                )
                if claimed_by is not None:
                    statement_id = claimed_by
            if statement_id not in known:
                raise ApiError(f"unknown statement {statement_id} for {card_path}")
            resolved = resolve_plan_statements(
                data.plans, {card_path: state}, cc_records
            )
            existing_ids = {
                p.id
                for p in data.plans
                if p.ccCardRef == card_path
                and resolved.get(p.id, (None, ""))[0] == statement_id
            }
            return store.replace_cc_override(
                ledger_file_path,
                card_path,
                plans,
                statement_id=statement_id,
                existing_ids=existing_ids,
            )
        if state.has_statements:
            raise ApiError("card has statement records; statementId required")
        return store.replace_cc_override(
            ledger_file_path, card_path, plans, cycle_month=cycle_month
        )


def _money(value) -> str:
    try:
        d = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        raise ApiError("estimatedBalance is not a number") from None
    if isinstance(value, bool) or not d.is_finite():
        raise ApiError("estimatedBalance is not a number")
    return format(d.quantize(Decimal("0.01")), "f")


def save_expected(
    ledger_file_path: str, body: dict, today: datetime.date | None = None
) -> ExpectedStatement:
    """POST cc_expected_save: create or update a card's expected statement.

    Body: {accountPath, id?, dueDate?, estimatedBalance?}. On create, a
    missing id / dueDate is predicted. On update, a missing or null id /
    dueDate keeps the stored value; `estimatedBalance` absent keeps, null or
    "" clears, a string sets (it must be greater than 0: a forecast of
    nothing is expressed by skipping the statement, and a zero estimate would
    hide the forecast row that leads back here). When the id changes, plans
    pointing at the old id follow it.

    `expectId` (optional) is the expected statement the caller believes it is
    editing. When the card's expected statement is a different one, or is
    gone (it closed), the request is rejected instead of silently creating
    or editing another cycle's record.
    """
    today = today or datetime.date.today()
    account = body.get("accountPath")
    if not account or not isinstance(account, str):
        raise ApiError("missing accountPath")

    with store.PLAN_LOCK:
        data, cc_records, state = _load(ledger_file_path, account, today)
        if not state.has_statements:
            raise ApiError("card has no statement records yet")
        rec = cc_records.get(account)
        newest = state.statements[-1].id
        current = state.expected

        expect_id = body.get("expectId")
        if expect_id and (current is None or current.id != expect_id):
            closed_as = promoted_to(ledger_file_path, data, account, expect_id)
            if closed_as is not None:
                raise ApiError(
                    f"statement {expect_id} has closed ({closed_as}); "
                    "reopen it to plan the payment"
                )
            raise ApiError(
                f"expected statement {expect_id} is no longer current; reload"
            )

        new_id = body.get("id") or (current.id if current else None)
        if new_id is None:
            new_id = predict_next_close(
                [s.id for s in state.statements],
                rec.statementCloseDay if rec else None,
            ).isoformat()
        if not _is_date(new_id):
            raise ApiError("id must be a date (YYYY-MM-DD)")
        if new_id <= newest:
            raise ApiError(f"id must be after the last closed statement ({newest})")

        due = body.get("dueDate") or (current.dueDate if current else None)
        if due is None:
            due = predict_due(
                _date(new_id), rec.paymentDueDay if rec else None
            ).isoformat()
        if not _is_date(due):
            raise ApiError("dueDate must be a date (YYYY-MM-DD)")
        if due <= new_id:
            raise ApiError("dueDate must be after the closing date")

        estimate = current.estimatedBalance if current else None
        if "estimatedBalance" in body:
            raw = body["estimatedBalance"]
            estimate = None if raw is None or raw == "" else _money(raw)
            if estimate is not None and Decimal(estimate) <= 0:
                raise ApiError(
                    "estimatedBalance must be greater than 0 "
                    "(leave it blank to use the ledger forecast)"
                )

        if current is not None and current.id != new_id:
            now = store.now_iso()
            events = [
                {
                    "op": "save",
                    **dataclasses.replace(
                        p, ccStatementId=new_id, updatedAt=now
                    ).to_dict(),
                }
                for p in store.list_plans(ledger_file_path)
                if p.ccCardRef == account and p.ccStatementId == current.id
            ]
            store.append_plan_events(ledger_file_path, events)

        saved = ExpectedStatement(
            account=account,
            id=new_id,
            dueDate=due,
            estimatedBalance=estimate,
            afterId=current.afterId if current else newest,
            createdAt=current.createdAt if current else "",
        )
        return store.save_expected_statement(ledger_file_path, saved)


def delete_expected(
    ledger_file_path: str, body: dict, today: datetime.date | None = None
) -> None:
    """POST cc_expected_delete. Refused while override plans point at it;
    deleting a missing record is a no-op.

    With `onlyIfEmpty` true (the dialog was opened on a forecast row and
    closed without saving) the record is removed only when it carries nothing
    the owner entered: no override plans and no estimated balance. Otherwise
    it is kept, without an error."""
    today = today or datetime.date.today()
    account = body.get("accountPath")
    if not account or not isinstance(account, str):
        raise ApiError("missing accountPath")
    only_if_empty = body.get("onlyIfEmpty") is True
    with store.PLAN_LOCK:
        data, cc_records, state = _load(ledger_file_path, account, today)
        if state.expected is not None:
            if only_if_empty and state.expected.estimatedBalance is not None:
                return
            resolved = resolve_plan_statements(data.plans, {account: state}, cc_records)
            if any(
                p.ccCardRef == account
                and resolved.get(p.id, (None, ""))[1] == "expected"
                for p in data.plans
            ):
                if only_if_empty:
                    return
                raise ApiError(
                    "expected statement has override plans; reset them first"
                )
        store.delete_expected_statement(ledger_file_path, account)


_CC_TAG_KEYS = ("ccCardRef", "ccCycleMonth", "ccStatementId")


def save_plan_from_body(ledger_file_path: str, body: dict) -> Plan:
    """POST plan_save. A card tag whose key is absent from the body keeps the
    stored value (inline edits and the move dialog do not send tags, and must
    not strip them); a key that is present is used as given. No foreign-key
    check here."""
    plan_id = body.get("id") or store.new_id()
    tags = {k: body.get(k) for k in _CC_TAG_KEYS}
    if body.get("id") and any(k not in body for k in _CC_TAG_KEYS):
        stored = next(
            (p for p in store.list_plans(ledger_file_path) if p.id == plan_id), None
        )
        if stored is not None:
            for k in _CC_TAG_KEYS:
                if k not in body:
                    tags[k] = getattr(stored, k)
    plan = Plan.from_dict(
        {
            "id": plan_id,
            "date": body["date"],
            "account": body["account"],
            "amount": body.get("amount", ""),
            "description": body.get("description", ""),
            "state": body.get("state"),
            "transferId": body.get("transferId"),
            "createdAt": body.get("createdAt") or "",
            "updatedAt": body.get("updatedAt") or "",
            **tags,
        }
    )
    return store.save_plan(ledger_file_path, plan)


def save_cc_card(ledger_file_path: str, body: dict) -> CCCardRecord:
    """POST cc_card_save. For a card with statement records the typed
    `statementBalance` / `lastClosedDate` are no longer inputs: incoming
    values are ignored and the stored ones kept.

    The card's expected statement froze its predicted dates when it was
    created. When a day hint changes here, those dates are predicted again,
    unless override plans already sit on that statement."""
    account = body.get("accountPath")
    if not account or not isinstance(account, str):
        raise ApiError("missing accountPath")
    record = CCCardRecord.from_dict(account, body)
    with store.PLAN_LOCK:
        statements = store.list_statements(ledger_file_path).get(account)
        if not statements:
            return store.save_cc_card_record(ledger_file_path, record)
        stored = store.list_cc_card_records(ledger_file_path).get(account)
        record.statementBalance = stored.statementBalance if stored else None
        record.lastClosedDate = stored.lastClosedDate if stored else None
        hints_changed = (
            stored.statementCloseDay if stored else None
        ) != record.statementCloseDay or (
            stored.paymentDueDay if stored else None
        ) != record.paymentDueDay
        saved = store.save_cc_card_record(ledger_file_path, record)
        if hints_changed:
            _repredict_expected(ledger_file_path, account, saved, statements)
        return saved


def _repredict_expected(
    ledger_file_path: str,
    account: str,
    rec: CCCardRecord,
    statements: list[Statement],
) -> None:
    """Predict the expected statement's closing and due dates again from the
    card's day hints. Left alone when any override plan belongs to it (by id,
    or a legacy row of its due month), so a planned payment never moves."""
    exp = store.list_expected_statements(ledger_file_path).get(account)
    if exp is None:
        return
    due_month = exp.dueDate[:7] if exp.dueDate else None
    for p in store.list_plans(ledger_file_path):
        if p.ccCardRef != account:
            continue
        if p.ccStatementId == exp.id:
            return
        if not p.ccStatementId and p.ccCycleMonth and p.ccCycleMonth == due_month:
            return
    ids = sorted(s.id for s in statements)
    new_close = predict_next_close(ids, rec.statementCloseDay)
    new_due = predict_due(new_close, rec.paymentDueDay)
    if new_close.isoformat() == exp.id and new_due.isoformat() == exp.dueDate:
        return
    store.save_expected_statement(
        ledger_file_path,
        dataclasses.replace(exp, id=new_close.isoformat(), dueDate=new_due.isoformat()),
    )
