"""Merge logic for /plan_grid.

Produces the day-by-day grid the planner page renders. Combines:
  - cleared (*) and scheduled (!) transactions from the .bean file (via Fava)
  - Plans and Transfers from plan/plans.jsonl + plan/transfers.jsonl
  - CC payment projections from plan/cc-cards.json
  - Past-plan match status (realized / unrealized / superseded)

This is mirrored on the client (lib/plan/merge.ts) for instant updates as the
user types; the server response is the source of truth.
"""

import datetime
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from typing import Optional

from beancount.core import data

from . import store
from .cc_cycle import (
    SETTLEMENT_GRACE_DAYS,
    Cycle,
    active_cycle,
    cycle_payment_window,
)
from .cc_projection import project_payments
from .models import CCCardRecord, Plan, Transfer

GridEntry = dict  # kind, id, amount, description, state?, transferId?, pastState?
DayRow = dict  # date, entries: dict[account, list[GridEntry]], balances, total
Bank = dict  # account, displayName, startingBalance


# ---------- helpers ----------


_SAFE_FORMULA = re.compile(r"^[\d+\-*/.\s()]+$")


def eval_amount(raw: Optional[str]) -> Decimal:
    """Evaluate a plan amount string. Supports formulas with `=` prefix.

    Returns 0 for empty / unparseable values (matching client `parseAmount`).
    """
    if raw is None or raw == "":
        return Decimal("0")
    if isinstance(raw, str) and raw.startswith("="):
        expr = raw[1:].strip()
        if not _SAFE_FORMULA.match(expr):
            return Decimal("0")
        try:
            result = eval(expr, {"__builtins__": {}}, {})  # noqa: S307
            return Decimal(str(result))
        except Exception:
            return Decimal("0")
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return Decimal("0")


_QUANT = Decimal("0.01")


def _decimal_str(d: Decimal) -> str:
    if not isinstance(d, Decimal):
        try:
            d = Decimal(str(d))
        except (InvalidOperation, ValueError):
            return "0.00"
    try:
        q = d.quantize(_QUANT)
    except InvalidOperation:
        q = d
    return format(q, "f")


def _short_payee(payee: Optional[str]) -> str:
    if not payee:
        return ""
    words = payee.split()[:2]
    return " ".join(words)


def _date_iter(start: datetime.date, end: datetime.date):
    cur = start
    while cur <= end:
        yield cur
        cur = cur + datetime.timedelta(days=1)


def display_name_from_account(account: str) -> str:
    leaf = account.split(":")[-1]
    if account.startswith("Assets:Saving:"):
        return f"{leaf} (Saving)"
    return leaf


def _credit_balance_on(
    ledger,
    filtered,
    conversion,
    fava_options,
    account: str,
    on_date: datetime.date,
) -> Decimal:
    """The .bean-derived balance owed on a credit card as a positive number.

    Beancount stores liabilities as negative when owed (you owe → negative posting).
    We negate so 'currentBalance = $1500' means 'you owe $1500'. Returns 0 if
    the ledger balance is positive (you have a credit on the card).
    """
    from fava.beans.abc import Transaction as FavaTransaction
    from fava.core.inventory import SimpleCounterInventory

    try:
        entries = ledger.account_journal(
            filtered,
            account,
            conversion,
            with_children=fava_options.account_journal_include_children,
        )
    except Exception:
        return Decimal("0")
    latest = Decimal("0")
    for e in entries:
        if not isinstance(e[1], FavaTransaction):
            continue
        if e[1].date > on_date:
            continue
        if not isinstance(e[3], SimpleCounterInventory):
            continue
        latest = e[3].get("USD", Decimal("0"))
    owed = -latest
    if owed < 0:
        return Decimal("0")
    return owed


# ---------- paid-this-cycle ----------


def compute_active_cycles(
    cc_records: dict[str, CCCardRecord],
    today: datetime.date,
) -> dict[str, Cycle]:
    """Per card: the cycle whose due date is the next paymentDueDay >= today.

    Skips cards missing dueDay — those don't have a cycle the planner can
    anchor to. `statementCloseDay` is optional (cc_cycle falls back to a
    30-day rolling window). `lastClosedDate`, when present, overrides the
    arithmetic close-date (banks occasionally shift due to weekends).
    """
    out: dict[str, Cycle] = {}
    for path, rec in cc_records.items():
        if rec.paymentDueDay is None:
            continue
        last_closed: Optional[datetime.date] = None
        if rec.lastClosedDate:
            try:
                last_closed = datetime.date.fromisoformat(rec.lastClosedDate)
            except ValueError:
                last_closed = None
        out[path] = active_cycle(
            today, rec.statementCloseDay, rec.paymentDueDay, last_closed
        )
    return out


def compute_paid_this_cycle(
    cc_records: dict[str, CCCardRecord],
    cycles: dict[str, Cycle],
    today: datetime.date,
    entries,
    grace_days: int = SETTLEMENT_GRACE_DAYS,
) -> dict[str, Decimal]:
    """Sum payment postings inside each card's cycle window.

    A *payment* on a credit-card liability account is a positive posting
    (beancount stores liability balances as negative when owed, so reducing
    debt = positive number) **whose transaction has an `Assets:*` offset**.
    The Assets-offset rule excludes merchant rebates, statement credits,
    and cash-back applied to the card — those are positive too, but their
    offset is `Income:*` or `Expenses:*`, not real money moving from a
    checking account. Treating them as paid would understate the payment
    still owed for the cycle.

    New spend (negative postings) is intentionally excluded — that accrues
    into the *next* statement, not this cycle.

    Window is `(cycle.start, min(today, cycle.end + grace)]`, matching
    `cycle_payment_window`. Both `*` cleared and `!` scheduled txns count —
    this stays consistent with `currentBalance`, which is derived from
    `account_journal` and includes both. The plan-vs-cleared matching in
    `annotate_past_state` is separately `*`-only, since a plan should only
    realize against an actual cleared txn (not against another forecast).
    """
    out: dict[str, Decimal] = {path: Decimal("0") for path in cc_records}
    if not cycles:
        return out

    earliest_start = min(c.start for c in cycles.values())
    # Precompute per-card payment window so we don't redo it per posting.
    windows = {
        path: cycle_payment_window(cycle, today, grace_days)
        for path, cycle in cycles.items()
    }

    for entry in entries:
        if not isinstance(entry, data.Transaction):
            continue
        if entry.flag not in ("*", "!"):
            continue
        if entry.date <= earliest_start:
            continue

        # Identify card-target postings (positive amount → reduces debt) and
        # check whether any other posting is to an Assets:* account
        # (= real money moved, not a rebate/credit).
        card_payments: list[tuple[str, Decimal]] = []
        has_asset_offset = False
        for p in entry.postings:
            account = p.account
            units = p.units
            if account.startswith("Assets:"):
                has_asset_offset = True
            if account in cycles and units is not None and units.number > 0:
                card_payments.append((account, units.number))

        if not card_payments or not has_asset_offset:
            continue

        for account, amount in card_payments:
            win_start, win_end = windows[account]
            if entry.date <= win_start or entry.date > win_end:
                continue
            out[account] = out.get(account, Decimal("0")) + amount

    return out


# ---------- structural CC payment detection ----------


# Bridge account used for two-leg CC payments: bank → bridge in one txn,
# bridge → card in a paired txn. Hardcoded to match the convention in this
# ledger; promote to settings if other ledgers use a different name.
_BRIDGE_ACCOUNT = "Assets:Pending-Transfer"


def find_cc_payment_offsets(entries) -> dict[tuple[str, str, str], str]:
    """Map cleared bank-side postings to the CC card they pay.

    Catches two patterns:

    A. **Direct payment** — one transaction with both legs:
         Assets:Checking:X    -N
         Liabilities:Credit:Y +N

    B. **Bridged payment** via `_BRIDGE_ACCOUNT`:
         Txn 1 (cleared `*`):  Assets:Checking:X      -N
                               Assets:Pending-Transfer +N
         Txn 2 (any flag):     Assets:Pending-Transfer -N
                               Liabilities:Credit:Y    +N

       Same-date, exact-amount pairing through the bridge. The bank-side
       cleared entry is what gets tagged so the grid can show "→ Robinhood".

    Returns `{(date_iso, bank_account, bank_amount_str): card_account}`.
    Used by the row-build step to badge cleared bank txns even when there's
    no plan or override claiming them. Independent of `paidThisCycle` math.
    """
    from collections import defaultdict

    out: dict[tuple[str, str, str], str] = {}

    # Pattern A: direct (single-txn) card payment.
    for entry in entries:
        if not isinstance(entry, data.Transaction):
            continue
        if entry.flag != "*":
            continue
        bank_legs = []
        card_legs = []
        for p in entry.postings:
            if p.units is None:
                continue
            n = p.units.number
            if (
                p.account.startswith("Assets:")
                and p.account != _BRIDGE_ACCOUNT
                and n < 0
            ):
                bank_legs.append((p.account, n))
            elif p.account.startswith("Liabilities:Credit:") and n > 0:
                card_legs.append(p.account)
        if not bank_legs or not card_legs:
            continue
        # 1:1 zip — when sizes mismatch, extra bank legs are unmatched (they
        # may be regular spend, not card-paying).
        for (bank_acct, bank_amt), card_acct in zip(bank_legs, card_legs):
            key = (entry.date.isoformat(), bank_acct, _decimal_str(bank_amt))
            out[key] = card_acct

    # Pattern B: bridged payment.
    # Index by (date, |amount|): bank-side has bridge +N, card-side has bridge −N.
    bank_side: dict[tuple[str, Decimal], list[tuple[str, Decimal]]] = defaultdict(
        list
    )
    card_side: dict[tuple[str, Decimal], list[str]] = defaultdict(list)

    for entry in entries:
        if not isinstance(entry, data.Transaction):
            continue
        if entry.flag not in ("*", "!"):
            continue
        bridge_legs = [
            p
            for p in entry.postings
            if p.account == _BRIDGE_ACCOUNT and p.units is not None
        ]
        if not bridge_legs:
            continue
        for bridge in bridge_legs:
            bridge_amt = bridge.units.number
            key = (entry.date.isoformat(), abs(bridge_amt))
            if entry.flag == "*" and bridge_amt > 0:
                # Bank side: bridge in (+), other Assets:* leg out (−).
                for p in entry.postings:
                    if p is bridge:
                        continue
                    if (
                        p.units is not None
                        and p.units.number < 0
                        and p.account.startswith("Assets:")
                        and p.account != _BRIDGE_ACCOUNT
                    ):
                        bank_side[key].append((p.account, p.units.number))
            elif bridge_amt < 0:
                # Card side: bridge out (−), Liabilities:Credit:* in (+).
                for p in entry.postings:
                    if p is bridge:
                        continue
                    if (
                        p.units is not None
                        and p.units.number > 0
                        and p.account.startswith("Liabilities:Credit:")
                    ):
                        card_side[key].append(p.account)

    for key, banks in bank_side.items():
        cards = card_side.get(key, [])
        if not cards:
            continue
        for (bank_acct, bank_amt), card_acct in zip(banks, cards):
            tag_key = (key[0], bank_acct, _decimal_str(bank_amt))
            # Don't overwrite a Pattern-A direct match (more authoritative).
            out.setdefault(tag_key, card_acct)

    return out


# ---------- auto-clear pending ----------


def auto_clear_pending(
    ledger_file_path: str,
    plans: list[Plan],
    cleared_amounts_by_date_account: dict[tuple[str, str], list[Decimal]],
    day_tolerance: int = 1,
    amount_tolerance: Decimal = Decimal("0.50"),
) -> list[Plan]:
    """For each plan with state='pending' that matches a cleared txn within
    tolerance, write a save event clearing the state and return the updated
    list. Idempotent: the next pass finds no pending plans matching.
    """
    if not any(p.state == "pending" for p in plans):
        return plans
    out: list[Plan] = []
    for p in plans:
        if p.state != "pending":
            out.append(p)
            continue
        plan_amount = eval_amount(p.amount)
        try:
            plan_date = datetime.date.fromisoformat(p.date)
        except ValueError:
            out.append(p)
            continue
        matched = False
        for delta in range(-day_tolerance, day_tolerance + 1):
            d = (plan_date + datetime.timedelta(days=delta)).isoformat()
            for amt in cleared_amounts_by_date_account.get((d, p.account), []):
                if abs(amt - plan_amount) <= amount_tolerance:
                    matched = True
                    break
            if matched:
                break
        if matched:
            cleared_plan = Plan(
                id=p.id,
                date=p.date,
                account=p.account,
                amount=p.amount,
                description=p.description,
                state=None,
                transferId=p.transferId,
                createdAt=p.createdAt,
                updatedAt=p.updatedAt,
                ccCardRef=p.ccCardRef,
                ccCycleMonth=p.ccCycleMonth,
            )
            store.save_plan(ledger_file_path, cleared_plan)
            out.append(cleared_plan)
        else:
            out.append(p)
    return out


# ---------- past-plan match status ----------


def annotate_past_state(
    plans_for_account: list[Plan],
    cleared_amounts_by_date_account: dict[tuple[str, str], list[Decimal]],
    today: datetime.date,
    day_tolerance: int = 1,
    amount_tolerance: Decimal = Decimal("0.50"),
) -> tuple[dict[str, str], dict[str, tuple[tuple[str, str], Decimal]]]:
    """Match plans to cleared txns; return (status_map, claim_map).

    `status_map[plan_id]` ∈ {"realized", "unrealized", "superseded"} for plans dated <= today.
    `claim_map[plan_id] = ((date_iso, account), cleared_amount)` for plans
    that matched a cleared txn (status realized OR superseded). Lets the
    row-build step look up which cleared bean entry each plan claimed —
    used to tag CC-payment cleared txns with their plan's card/cycle.

    Greedy match: each past plan claims the closest cleared amount within
    tolerance. Cleared entries can only be claimed once per account per day
    window. Today's plans are included so the row-build step can hide ones
    already realized by a same-day cleared bean txn.
    """
    status: dict[str, str] = {}
    claim: dict[str, tuple[tuple[str, str], Decimal]] = {}
    # Make a mutable copy so we can pop matched cleared amounts
    available = {k: list(v) for k, v in cleared_amounts_by_date_account.items()}
    today_iso = today.isoformat()
    past_plans = sorted(
        [p for p in plans_for_account if p.date <= today_iso], key=lambda p: p.date
    )

    for p in past_plans:
        plan_amount = eval_amount(p.amount)

        best_key = None
        best_diff = None
        plan_date = datetime.date.fromisoformat(p.date)
        for delta in range(-day_tolerance, day_tolerance + 1):
            d = (plan_date + datetime.timedelta(days=delta)).isoformat()
            key = (d, p.account)
            for amt in available.get(key, []):
                diff = abs(amt - plan_amount)
                if best_diff is None or diff < best_diff:
                    best_diff = diff
                    best_key = (key, amt)

        if best_key is None:
            status[p.id] = "unrealized"
            continue

        (matched_key, matched_amt) = best_key
        available[matched_key].remove(matched_amt)
        claim[p.id] = (matched_key, matched_amt)
        if best_diff is not None and best_diff <= amount_tolerance:
            status[p.id] = "realized"
        else:
            status[p.id] = "superseded"

    return status, claim


# ---------- main merge ----------


def build_grid_response(
    *,
    ledger,
    filtered,
    conversion,
    fava_options,
    exec_query,
    excluded_accounts: set[str],
    plans: list[Plan],
    transfers: list[Transfer],
    cc_records: dict[str, CCCardRecord],
    settings,
    start_date: Optional[datetime.date] = None,
    end_date: Optional[datetime.date] = None,
    today: Optional[datetime.date] = None,
    ledger_file_path: Optional[str] = None,
) -> dict:
    today = today or datetime.date.today()

    # 1. Pick the bank universe — open Assets:Checking + Assets:Saving accounts.
    # Skip explicitly-excluded ones, and skip accounts with a beancount `close`
    # directive (so closed accounts like Wells-Fargo / Chase-2023 / Citi don't
    # need to be hardcoded).
    def _is_closed(k: str) -> bool:
        ad = ledger.accounts.get(k)
        return ad is not None and getattr(ad, "close_date", None) is not None

    all_accounts = [
        k
        for k in ledger.accounts.keys()
        if (k.startswith("Assets:Checking") or k.startswith("Assets:Saving"))
        and k not in excluded_accounts
        and not _is_closed(k)
    ]

    # Per-account journal of (entry_date, eod_balance). Same shape as the SPA.
    from fava.beans.abc import Transaction as FavaTransaction
    from fava.core.inventory import SimpleCounterInventory

    account_entries: dict[str, list[tuple[datetime.date, Decimal]]] = {}
    for account in all_accounts:
        entries = ledger.account_journal(
            filtered,
            account,
            conversion,
            with_children=fava_options.account_journal_include_children,
        )
        result = [
            (e[1].date, e[3].get("USD", Decimal("0")))
            for e in entries
            if isinstance(e[1], FavaTransaction)
            and isinstance(e[3], SimpleCounterInventory)
        ]
        # +1 day shift to mean "balance available at start of this day" (matches SPA)
        shifted = [(d + datetime.timedelta(days=1), amt) for (d, amt) in result]
        if shifted:
            account_entries[account] = shifted
    accounts = sorted(account_entries.keys())

    # 2. Date range
    auto_end = today
    for plan in plans:
        if plan.date and plan.date > auto_end.isoformat():
            try:
                auto_end = max(auto_end, datetime.date.fromisoformat(plan.date))
            except ValueError:
                pass
    for tr in transfers:
        if tr.date and tr.date > auto_end.isoformat():
            try:
                auto_end = max(auto_end, datetime.date.fromisoformat(tr.date))
            except ValueError:
                pass
    # also extend for the latest scheduled txn date in account_entries
    for entries in account_entries.values():
        for d, _ in entries:
            if d > auto_end:
                auto_end = d

    if start_date is None:
        start_date = today - datetime.timedelta(days=15)
    if end_date is None:
        end_date = auto_end

    # 3. Pull all txns from BQL (with flag) for description + cleared-vs-scheduled
    query = """SELECT account, date, payee, position, flag WHERE account ~ "^Assets:Saving" OR account ~ "^Assets:Checking" """
    rtypes, rrows = exec_query(query)
    cleared_amounts_by_date_account: dict[tuple[str, str], list[Decimal]] = defaultdict(
        list
    )

    # entries_by_date_account is a list of (kind, amount, description)
    bean_entries_by_date_account: dict[tuple[str, str], list[GridEntry]] = defaultdict(
        list
    )
    for r in rrows:
        if r.account not in accounts:
            continue
        d = r.date.isoformat()
        flag = getattr(r, "flag", "*")
        kind = "scheduled" if flag == "!" else "cleared"
        amount = (
            r.position.units.number if r.position and r.position.units else Decimal("0")
        )
        bean_entries_by_date_account[(d, r.account)].append(
            {
                "id": f"bean-{r.account}-{d}-{len(bean_entries_by_date_account[(d, r.account)])}",
                "kind": kind,
                "amount": _decimal_str(amount),
                "description": _short_payee(r.payee),
            }
        )
        if kind == "cleared":
            cleared_amounts_by_date_account[(d, r.account)].append(amount)

    # 4. CC projections — derive live currentBalance from the .bean ledger.
    # The user's typed currentBalance (if any) is ignored; we use the ledger
    # balance because it reflects new spend without manual maintenance. The
    # tradeoff is importer lag, which is small relative to the forecast horizon.
    display_name_for = {p: display_name_from_account(p) for p in cc_records.keys()}
    derived_balances: dict[str, Decimal] = {}
    for path in cc_records:
        derived_balances[path] = _credit_balance_on(
            ledger, filtered, conversion, fava_options, path, today
        )

    # Per-card active cycle + paid-this-cycle. `paid_this_cycle[path]` is the
    # sum of cleared payment postings inside the cycle window — used in step 3
    # to net the `cc-locked` projection (`remaining = stmt − paid`), and
    # exposed on the payload for the modal to default `payTotal` correctly.
    cycles_by_card = compute_active_cycles(cc_records, today)
    paid_this_cycle = compute_paid_this_cycle(
        cc_records, cycles_by_card, today, filtered.entries
    )

    # Suppression: any plan with (ccCardRef, ccCycleMonth) overrides that
    # card+cycle's projection set. The override plans render as ordinary
    # plan entries; the projection rows for that cycle are skipped.
    suppressed_cycles: set[tuple[str, str]] = set()
    for p in plans:
        if p.ccCardRef and p.ccCycleMonth:
            suppressed_cycles.add((p.ccCardRef, p.ccCycleMonth))

    projections = project_payments(
        cc_records, display_name_for, today, derived_balances, paid_this_cycle
    )
    cc_entries_by_date_account: dict[tuple[str, str], list[GridEntry]] = defaultdict(
        list
    )
    floating_projections: list[dict] = []
    for proj in projections:
        if (proj.cardAccountPath, proj.cycleMonth) in suppressed_cycles:
            continue
        if proj.fundingAccount and proj.fundingAccount in accounts:
            cc_entries_by_date_account[(proj.date, proj.fundingAccount)].append(
                {
                    "id": f"cc-{proj.cardAccountPath}-{proj.kind}-{proj.date}",
                    "kind": proj.kind,
                    "amount": proj.amount,
                    "description": proj.displayName,
                    "ccCardRef": proj.cardAccountPath,
                    "ccCycleMonth": proj.cycleMonth,
                }
            )
        else:
            floating_projections.append(
                {
                    "cardAccountPath": proj.cardAccountPath,
                    "displayName": proj.displayName,
                    "date": proj.date,
                    "amount": proj.amount,
                    "kind": proj.kind,
                    "cycleMonth": proj.cycleMonth,
                }
            )

    # 4b. Auto-clear pending plans whose matching cleared txn has landed.
    # Side-effects on disk: a save event with state=null gets appended for
    # each match. Idempotent — next pass finds no pending plans matching.
    if ledger_file_path:
        plans = auto_clear_pending(
            ledger_file_path, plans, cleared_amounts_by_date_account
        )

    # 5. Plans + Transfer legs as plan entries
    plan_entries_by_date_account: dict[tuple[str, str], list[GridEntry]] = defaultdict(
        list
    )
    plans_for_status: list[Plan] = []
    for p in plans:
        if p.account not in accounts:
            continue
        plan_entries_by_date_account[(p.date, p.account)].append(
            {
                "id": p.id,
                "kind": "plan",
                "amount": p.amount,
                "description": p.description,
                "state": p.state,
                "transferId": p.transferId,
                "ccCardRef": p.ccCardRef,
                "ccCycleMonth": p.ccCycleMonth,
            }
        )
        plans_for_status.append(p)

    for tr in transfers:
        # Each transfer materializes as two legs.
        try:
            amt = Decimal(tr.amount) if tr.amount else Decimal("0")
        except Exception:
            amt = Decimal("0")
        if tr.fromAccount in accounts:
            plan_entries_by_date_account[(tr.date, tr.fromAccount)].append(
                {
                    "id": f"{tr.id}-from",
                    "kind": "plan",
                    "amount": _decimal_str(-amt),
                    "description": tr.description
                    or f"→ {display_name_from_account(tr.toAccount)}",
                    "state": tr.state,
                    "transferId": tr.id,
                }
            )
            plans_for_status.append(
                Plan(
                    id=f"{tr.id}-from",
                    date=tr.date,
                    account=tr.fromAccount,
                    amount=_decimal_str(-amt),
                    description=tr.description,
                    state=tr.state,
                    transferId=tr.id,
                    createdAt=tr.createdAt,
                    updatedAt=tr.updatedAt,
                )
            )
        if tr.toAccount in accounts:
            plan_entries_by_date_account[(tr.date, tr.toAccount)].append(
                {
                    "id": f"{tr.id}-to",
                    "kind": "plan",
                    "amount": _decimal_str(amt),
                    "description": tr.description
                    or f"← {display_name_from_account(tr.fromAccount)}",
                    "state": tr.state,
                    "transferId": tr.id,
                }
            )
            plans_for_status.append(
                Plan(
                    id=f"{tr.id}-to",
                    date=tr.date,
                    account=tr.toAccount,
                    amount=_decimal_str(amt),
                    description=tr.description,
                    state=tr.state,
                    transferId=tr.id,
                    createdAt=tr.createdAt,
                    updatedAt=tr.updatedAt,
                )
            )

    # 6. Past-plan match status (realized / unrealized / superseded) +
    # which cleared txn each plan claimed. We reverse the claim map for
    # CC-override plans to tag the matched cleared bean entry with the
    # card/cycle context — so the user sees "−$990.01 Inter-Entity Transfer
    # · Robinhood May 2026" rather than just the bare bank-side description.
    past_status, past_claim = annotate_past_state(
        plans_for_status, cleared_amounts_by_date_account, today
    )

    # plan_lookup is needed because plans_for_status mixes Plan records with
    # Transfer-leg synthetic Plans; we want only those carrying ccCardRef.
    plan_lookup = {p.id: p for p in plans_for_status}
    cc_match_by_cleared: dict[
        tuple[str, str, str], dict[str, Optional[str]]
    ] = {}

    # First, structural detection — catches CC payments that have no plan
    # behind them (deleted plans, ad-hoc payments). No `ccCycleMonth` since
    # we infer the card from posting structure, not from a typed plan.
    for key, card_path in find_cc_payment_offsets(filtered.entries).items():
        cc_match_by_cleared[key] = {
            "ccCardRef": card_path,
            "ccCycleMonth": None,
            "displayName": display_name_from_account(card_path),
        }

    # Plan-claim matches override (they carry the explicit cycleMonth the
    # user committed to). Same key shape, structural entry is replaced.
    for plan_id, ((d, account), amt) in past_claim.items():
        plan = plan_lookup.get(plan_id)
        if plan is None or not plan.ccCardRef:
            continue
        key = (d, account, _decimal_str(amt))
        cc_match_by_cleared[key] = {
            "ccCardRef": plan.ccCardRef,
            "ccCycleMonth": plan.ccCycleMonth,
            "displayName": display_name_from_account(plan.ccCardRef),
        }

    # 7. Build rows.
    # Bean balance from account_journal already includes cleared `*` and scheduled
    # `!` txns. Plan / Transfer / CC-projection effects are extra layers we apply
    # cumulatively per day so the balance shown reflects the full plan.
    rows: list[DayRow] = []
    todo_count = 0
    pending_count = 0
    plan_running: dict[str, Decimal] = {a: Decimal("0") for a in accounts}
    for cur in _date_iter(start_date, end_date):
        date_iso = cur.isoformat()
        row_entries: dict[str, list[GridEntry]] = {a: [] for a in accounts}
        balances: dict[str, str] = {}
        for account in accounts:
            # Bean balance: latest entry whose date <= cur (includes `*` and `!`).
            bean_balance = Decimal("0")
            for entry_date, amt in account_entries[account]:
                if entry_date <= cur:
                    bean_balance = amt
                else:
                    break

            # The balance shown on a row is the START-OF-DAY balance — what's
            # in the account *before* today's plans/projections apply. The
            # user reads "Checking $1,058 on 5/3, plan -$353 to Savings, Checking $705
            # on 5/4." Putting the post-plan balance on the same row as the
            # plan is confusing — feels like the math has already happened.
            balances[account] = _decimal_str(bean_balance + plan_running[account])

            # A plan that matched a cleared bean txn (same account, ±1 day, ±$0.50)
            # is hidden entirely — the cleared txn already represents it. Skipping
            # it here also keeps `plan_running` from double-counting the amount on
            # top of the bean balance.
            def _is_realized(ent: GridEntry) -> bool:
                return (
                    cur <= today
                    and ent.get("kind") == "plan"
                    and past_status.get(ent.get("id")) == "realized"
                )

            # Then accumulate today's deltas so tomorrow's row reflects them.
            for ent in plan_entries_by_date_account.get((date_iso, account), []):
                if _is_realized(ent):
                    continue
                plan_running[account] += eval_amount(ent.get("amount"))
            for ent in cc_entries_by_date_account.get((date_iso, account), []):
                plan_running[account] += eval_amount(ent.get("amount"))

            # Combine: bean entries + cc projections + plans (keep insertion order)
            combined: list[GridEntry] = []
            for bean_ent in bean_entries_by_date_account.get((date_iso, account), []):
                # If a CC-override plan claimed this cleared txn during
                # matching, tag the entry with the card/cycle so the UI can
                # render a "Robinhood May 2026" badge next to the bank-side
                # description.
                key = (date_iso, account, bean_ent.get("amount", ""))
                cc_meta = cc_match_by_cleared.get(key)
                if cc_meta is None:
                    combined.append(bean_ent)
                else:
                    tagged = dict(bean_ent)
                    tagged["matchedCcPlan"] = cc_meta
                    combined.append(tagged)
            combined.extend(cc_entries_by_date_account.get((date_iso, account), []))
            for ent in plan_entries_by_date_account.get((date_iso, account), []):
                if _is_realized(ent):
                    continue
                ent2 = dict(ent)
                if cur < today and ent.get("kind") == "plan":
                    state = past_status.get(ent.get("id"))
                    if state:
                        ent2["pastState"] = state
                combined.append(ent2)
            row_entries[account] = combined

            # Counts (future + today only — past doesn't get badge counted)
            if cur >= today:
                for ent in combined:
                    if ent.get("kind") != "plan":
                        continue
                    if ent.get("state") == "todo":
                        todo_count += 1
                    elif ent.get("state") == "pending":
                        pending_count += 1

        # Total = sum of bank balances (excluding ones flagged out)
        excluded = set(settings.bankPanel.get("excludedFromTotalBanks", []))
        total = sum(
            (Decimal(balances[a]) for a in accounts if a not in excluded), Decimal("0")
        )

        rows.append(
            {
                "date": date_iso,
                "entries": row_entries,
                "balances": balances,
                "total": _decimal_str(total),
            }
        )

    past_plan_count = sum(1 for p in plans_for_status if p.date < today.isoformat())

    # 8. Banks list with starting balance (one day before start_date)
    banks: list[Bank] = []
    for account in accounts:
        starting = Decimal("0")
        # The row at start_date reads "<= start_date" anyway, so the "starting"
        # we report is the balance up to start_date - 1.
        cutoff_minus_one = start_date - datetime.timedelta(days=1)
        for entry_date, amt in account_entries[account]:
            if entry_date <= cutoff_minus_one:
                starting = amt
            else:
                break
        banks.append(
            {
                "account": account,
                "displayName": display_name_from_account(account),
                "startingBalance": _decimal_str(starting),
            }
        )

    # 9. CC card merged shape (ledger × store). currentBalance is derived from
    # the .bean ledger, not stored. Cycle fields (paidThisCycle, remaining,
    # cycleStart/End/Month, statementBalanceStale) are computed in §4 above
    # and attached here so the modal can read them without round-tripping.
    cc_card_payload: list[dict] = []
    for path in sorted(ledger.accounts.keys()):
        if not path.startswith("Liabilities:Credit:"):
            continue
        rec = cc_records.get(path)
        is_configured = bool(
            rec and rec.paymentDueDay is not None and rec.fundingAccount
        )
        has_inputs = bool(rec and rec.statementBalance)
        derived_curr = _credit_balance_on(
            ledger, filtered, conversion, fava_options, path, today
        )

        cycle = cycles_by_card.get(path)
        paid = paid_this_cycle.get(path, Decimal("0"))
        stmt_dec = (
            Decimal(rec.statementBalance)
            if rec and rec.statementBalance
            else None
        )
        remaining = (
            max(Decimal("0"), stmt_dec - paid) if stmt_dec is not None else None
        )

        # Stale = the typed statement is for a close older than the active
        # cycle's start. Only meaningful when both pieces are present.
        stale = False
        if rec and rec.lastClosedDate and cycle is not None:
            try:
                last_closed = datetime.date.fromisoformat(rec.lastClosedDate)
                stale = last_closed < cycle.start
            except ValueError:
                stale = False

        cc_card_payload.append(
            {
                "accountPath": path,
                "displayName": display_name_from_account(path),
                "isConfigured": is_configured,
                "hasMonthlyInputs": has_inputs,
                "fundingAccount": rec.fundingAccount if rec else None,
                "statementCloseDay": rec.statementCloseDay if rec else None,
                "paymentDueDay": rec.paymentDueDay if rec else None,
                "statementBalance": rec.statementBalance if rec else None,
                "currentBalance": _decimal_str(derived_curr),
                "lastClosedDate": rec.lastClosedDate if rec else None,
                "minimumPaymentOnly": rec.minimumPaymentOnly if rec else None,
                "updatedAt": rec.updatedAt if rec else None,
                "paidThisCycle": _decimal_str(paid),
                "remaining": _decimal_str(remaining) if remaining is not None else None,
                "cycleStartDate": cycle.start.isoformat() if cycle else None,
                "cycleEndDate": cycle.end.isoformat() if cycle else None,
                "cycleMonth": cycle.dueMonth if cycle else None,
                "statementBalanceStale": stale,
            }
        )

    return {
        "banks": banks,
        "rows": rows,
        "ccCards": cc_card_payload,
        "floatingProjections": floating_projections,
        "pastPlanCount": past_plan_count,
        "todoCount": todo_count,
        "pendingCount": pending_count,
        "today": today.isoformat(),
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
    }
