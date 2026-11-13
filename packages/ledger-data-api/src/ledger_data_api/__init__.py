import datetime
import json
from collections import namedtuple
from decimal import Decimal

from beanquery.query import run_query  # type: ignore
from fava.beans.abc import Transaction
from fava.context import g
from fava.core.inventory import SimpleCounterInventory
from fava.ext import FavaExtensionBase, extension_endpoint
from fava.helpers import FavaAPIError
from flask import request

from . import cc_statements, fire, portfolio, runway, runway_write, store
from .cc_statements import ApiError
from .merge import (
    _credit_balance_on,
    build_grid_response,
    display_name_from_account,
)
from .models import PlanSettings, Transfer

#: Account buckets the card-balance overlay scans when `card_balance.accounts`
#: is absent from ui.yaml. Universal beancount taxonomy only — anything
#: ledger-specific (an investment sleeve's cash leaf, say) is configured, not
#: shipped.
DEFAULT_BALANCE_ACCOUNTS = ["Assets:Checking", "Assets:Saving", "Liabilities:Credit"]


def _bad_request(message: str):
    """A rejected request: HTTP 400 with the reason (nothing was written)."""
    return json.dumps({"status": "error", "message": message}), 400


class LedgerDataApi(FavaExtensionBase):
    """Endpoints-only Fava extension. No report page (Mars Dashboard SPA retired)."""

    def _ui_config(self) -> dict:
        return store.read_ui_config(self._ledger_path())

    def _config_list(self, section: str, key: str, default: list[str]) -> list[str]:
        """Read a list of account paths from ui.yaml, falling back to `default`."""
        block = self._ui_config().get(section)
        if not isinstance(block, dict):
            return list(default)
        values = block.get(key)
        if not isinstance(values, list):
            return list(default)
        cleaned = [v for v in values if isinstance(v, str) and v]
        return cleaned or list(default)

    def excluded_accounts(self) -> list[str]:
        """Accounts the planner hides. Configured in ui.yaml under `planner`."""
        return self._config_list("planner", "excluded_accounts", [])

    @extension_endpoint
    def get_balance(self):
        account = request.args.get("account")
        patterns = self._config_list(
            "card_balance", "accounts", DEFAULT_BALANCE_ACCOUNTS
        )
        # Patterns are interpolated into BQL, so anything that could close the
        # string literal is dropped rather than escaped.
        matches = " OR ".join(
            f'account ~ "{p}"' for p in patterns if '"' not in p and "\\" not in p
        )
        if not matches:
            return json.dumps({})
        query = (
            f"SELECT account WHERE ({matches}) "
            "AND NOT close_date(account) GROUP BY account"
        )
        _, rrows = self.exec_query(query)
        # get all accounts that match the query
        accounts = [row.account for row in rrows if account in row.account.lower()]
        results = {}
        for account in accounts:
            # get the last entry where the date is today or earlier
            entries = self.get_account_entries(account)
            current_date = datetime.datetime.now().date() + datetime.timedelta(days=1)
            last_entry = next(
                (entry for entry in reversed(entries) if entry[0] <= current_date), None
            )
            if last_entry:
                balance = float(last_entry[1])
            else:
                balance = 0
            results[account] = balance
        return json.dumps(results)

    def exec_query(self, query):
        try:
            rtypes, rrows = run_query(g.filtered.entries, self.ledger.options, query)
        except Exception as ex:
            raise FavaAPIError(f"failed to execute query {query}: {ex}") from ex

        # convert to legacy beancount.query format for backwards compat
        result_row = namedtuple("ResultRow", [col.name for col in rtypes])
        rtypes = [(t.name, t.datatype) for t in rtypes]
        rrows = [result_row(*row) for row in rrows]

        return rtypes, rrows

    def get_account_entries(self, account):
        entries = g.ledger.account_journal(
            g.filtered,
            account,
            g.conversion,
            with_children=g.ledger.fava_options.account_journal_include_children,
        )
        result = [
            (entry[1].date, entry[3].get("USD", Decimal("0")))
            for entry in entries
            if isinstance(entry[1], Transaction)
            and isinstance(entry[3], SimpleCounterInventory)
        ]
        # shift the entry date by 1 day
        return [(entry[0] + datetime.timedelta(days=1), entry[1]) for entry in result]

    def _ledger_path(self) -> str:
        return g.ledger.beancount_file_path

    @extension_endpoint
    def plan_grid(self):
        start = request.args.get("start")
        end = request.args.get("end")

        start_date = (
            datetime.datetime.strptime(start, "%Y-%m-%d").date() if start else None
        )
        end_date = datetime.datetime.strptime(end, "%Y-%m-%d").date() if end else None

        ledger_path = self._ledger_path()
        # Plans + closed statements + the expected statement per card, read
        # as one snapshot. Loading them also lets a newly closed statement
        # claim the expected one (plans follow); on a read-only mount that
        # mapping stays in memory.
        data = cc_statements.load_statement_data(ledger_path)
        transfers = store.list_transfers(ledger_path)
        cc_records = store.list_cc_card_records(ledger_path)
        settings = store.get_plan_settings(ledger_path)

        result = build_grid_response(
            ledger=g.ledger,
            filtered=g.filtered,
            conversion=g.conversion,
            fava_options=g.ledger.fava_options,
            exec_query=self.exec_query,
            excluded_accounts=set(self.excluded_accounts()),
            plans=data.plans,
            transfers=transfers,
            cc_records=cc_records,
            settings=settings,
            start_date=start_date,
            end_date=end_date,
            ledger_file_path=ledger_path,
            statements=data.statements,
            expected=data.expected,
        )
        return json.dumps(result, default=str)

    @extension_endpoint(methods=["POST"])
    def plan_save(self):
        # Card tags (ccCardRef / ccCycleMonth / ccStatementId) absent from
        # the body keep their stored value, so an inline edit cannot strip them.
        saved = cc_statements.save_plan_from_body(
            self._ledger_path(), request.json or {}
        )
        return json.dumps({"id": saved.id})

    @extension_endpoint(methods=["POST"])
    def plan_delete(self):
        data = request.json or {}
        plan_id = data.get("id")
        if not plan_id:
            return json.dumps({"status": "error", "message": "missing id"})
        store.delete_plan(self._ledger_path(), plan_id)
        return json.dumps({})

    @extension_endpoint(methods=["POST"])
    def transfer_save(self):
        data = request.json or {}
        transfer = Transfer.from_dict(
            {
                "id": data.get("id") or store.new_id(),
                "date": data["date"],
                "fromAccount": data["fromAccount"],
                "toAccount": data["toAccount"],
                "amount": data.get("amount", ""),
                "description": data.get("description", ""),
                "state": data.get("state"),
                "createdAt": data.get("createdAt") or "",
                "updatedAt": data.get("updatedAt") or "",
            }
        )
        saved = store.save_transfer(self._ledger_path(), transfer)
        return json.dumps({"id": saved.id})

    @extension_endpoint(methods=["POST"])
    def transfer_delete(self):
        data = request.json or {}
        tid = data.get("id")
        if not tid:
            return json.dumps({"status": "error", "message": "missing id"})
        store.delete_transfer(self._ledger_path(), tid)
        return json.dumps({})

    @extension_endpoint
    def cc_cards(self):
        ledger_path = self._ledger_path()
        records = store.list_cc_card_records(ledger_path)
        data = cc_statements.load_statement_data(ledger_path)
        today = datetime.date.today()
        out: list[dict] = []
        for path in sorted(g.ledger.accounts.keys()):
            if not path.startswith("Liabilities:Credit:"):
                continue
            rec = records.get(path)
            account = g.ledger.accounts.get(path)
            is_closed = getattr(account, "close_date", None) is not None
            # Statements of a closed account are ignored (as in plan_grid).
            state = cc_statements.card_state(
                path,
                [] if is_closed else data.statements.get(path, []),
                data.expected.get(path),
                rec,
                today,
            )
            is_configured = bool(
                rec and rec.paymentDueDay is not None and rec.fundingAccount
            )
            has_inputs = bool(rec and rec.statementBalance) or state.has_statements
            derived_curr = _credit_balance_on(
                g.ledger,
                g.filtered,
                g.conversion,
                g.ledger.fava_options,
                path,
                today,
            )
            statement_balance = rec.statementBalance if rec else None
            last_closed_date = rec.lastClosedDate if rec else None
            if state.has_statements:
                # Facts replace the typed values (kept under the old names so
                # an older web build still reads them).
                statement_balance = (
                    state.active.statementBalance if state.active else None
                )
                last_closed_date = state.statements[-1].id
            out.append(
                {
                    "accountPath": path,
                    "displayName": display_name_from_account(path),
                    "isConfigured": is_configured,
                    "hasMonthlyInputs": has_inputs,
                    "fundingAccount": rec.fundingAccount if rec else None,
                    "statementCloseDay": rec.statementCloseDay if rec else None,
                    "paymentDueDay": rec.paymentDueDay if rec else None,
                    "statementBalance": statement_balance,
                    "currentBalance": format(
                        derived_curr.quantize(Decimal("0.01")), "f"
                    ),
                    "lastClosedDate": last_closed_date,
                    "minimumPaymentOnly": rec.minimumPaymentOnly if rec else None,
                    "updatedAt": rec.updatedAt if rec else None,
                    **cc_statements.card_statement_fields(
                        state, rec, today, derived_curr
                    ),
                    # Amounts need the cycle's payments; plan_grid has them.
                    "lockedAmount": None,
                    "lockedSource": None,
                    "overrideTotal": None,
                    "computedForecast": None,
                }
            )
        return json.dumps(out)

    @extension_endpoint
    def cc_statements(self):
        """Every closed statement of one card (newest first) plus its
        expected statement. Query: `account`."""
        try:
            payload = cc_statements.statements_response(
                self._ledger_path(), request.args.get("account") or ""
            )
        except ApiError as ex:
            return _bad_request(ex.message)
        return json.dumps(payload)

    @extension_endpoint(methods=["POST"])
    def cc_expected_save(self):
        """Create or update a card's expected (not yet closed) statement.

        Body: { accountPath, id?, dueDate?, estimatedBalance? }. Missing id /
        dueDate are predicted on create and kept on update.
        """
        try:
            saved = cc_statements.save_expected(self._ledger_path(), request.json or {})
        except ApiError as ex:
            return _bad_request(ex.message)
        return json.dumps({"expected": cc_statements.expected_payload(saved)})

    @extension_endpoint(methods=["POST"])
    def cc_expected_delete(self):
        """Body: { accountPath }. Refused while override plans point at it."""
        try:
            cc_statements.delete_expected(self._ledger_path(), request.json or {})
        except ApiError as ex:
            return _bad_request(ex.message)
        return json.dumps({})

    @extension_endpoint(methods=["POST"])
    def cc_card_save(self):
        data = request.json or {}
        account_path = data.get("accountPath")
        if not account_path:
            return json.dumps({"status": "error", "message": "missing accountPath"})
        # In statement mode the typed statementBalance / lastClosedDate are
        # ignored (the stored ones are kept); legacy cards save as before.
        cc_statements.save_cc_card(self._ledger_path(), data)
        return json.dumps({})

    @extension_endpoint(methods=["POST"])
    def cc_card_delete(self):
        data = request.json or {}
        account_path = data.get("accountPath")
        if not account_path:
            return json.dumps({"status": "error", "message": "missing accountPath"})
        store.delete_cc_card_record(self._ledger_path(), account_path)
        return json.dumps({})

    @extension_endpoint(methods=["POST"])
    def cc_override_save(self):
        """Atomically replace the override plan-set for one card statement.

        Body: { cardAccountPath, statementId? | cycleMonth?, plans: [Plan, ...] }

        `statementId` is a strict foreign key: a closed statement id or the
        expected statement id of that card, else HTTP 400 and nothing is
        written. `cycleMonth` is the legacy key, accepted only for a card
        with no statement records.

        Each incoming plan that lacks an `id` gets a fresh id; existing
        plans for the same statement but missing from the incoming set are
        deleted. The full update is appended in one write to plans.jsonl.
        """
        try:
            saved = cc_statements.save_override(self._ledger_path(), request.json or {})
        except ApiError as ex:
            return _bad_request(ex.message)
        return json.dumps({"plans": [p.to_dict() for p in saved]})

    @extension_endpoint
    def plan_settings(self):
        settings = store.get_plan_settings(self._ledger_path())
        return json.dumps(settings.to_dict())

    @extension_endpoint(methods=["POST"])
    def plan_settings_save(self):
        data = request.json or {}
        settings = PlanSettings.from_dict(data)
        store.save_plan_settings(self._ledger_path(), settings)
        return json.dumps({})

    @extension_endpoint
    def get_ui_config(self):
        return json.dumps(self._ui_config())

    @extension_endpoint
    def portfolio(self):
        """Holdings, value-vs-cost series, contribution room and realized P/L.

        `asof` (default today) bounds every figure: the ledger carries
        future-dated forecast transactions, including investment buys, so an
        unbounded walk reports trades that have not happened yet.
        """
        raw_asof = request.args.get("asof")
        try:
            asof = (
                datetime.date.fromisoformat(raw_asof)
                if raw_asof
                else datetime.date.today()
            )
        except ValueError as ex:
            raise FavaAPIError(f"invalid asof date {raw_asof!r}") from ex

        payload = portfolio.build_portfolio(
            ledger=g.ledger,
            entries=g.ledger.all_entries,
            ui_config=self._ui_config(),
            asof=asof,
        )
        return json.dumps(payload)

    @extension_endpoint
    def fire_data(self):
        """Everything the /fire page loads: ledger snapshot, fire.yaml, scenarios."""
        asof = datetime.date.today()
        path = self._ledger_path()
        return json.dumps(
            {
                "snapshot": fire.build_snapshot(
                    ledger=g.ledger,
                    entries=g.ledger.all_entries,
                    ui_config=self._ui_config(),
                    asof=asof,
                ),
                "config": fire.read_fire_config(path),
                "scenarios": fire.list_scenarios(path),
            }
        )

    @extension_endpoint
    def runway_data(self):
        """Everything the /runway page loads: config/runway.yaml resolved per
        person (includes, scenario patches, ledger starting balances)."""
        return json.dumps(
            runway.build_runway_data(
                ledger=g.ledger,
                entries=g.ledger.all_entries,
                ledger_file_path=self._ledger_path(),
                today=datetime.date.today(),
            )
        )

    @extension_endpoint(methods=["POST"])
    def runway_save(self):
        """Write /runway page edits back to runway.yaml (and the person's
        included file). 409 when the files changed since the page loaded,
        422 with `issues` when the result would not validate."""
        try:
            result = runway_write.save(
                ledger=g.ledger,
                entries=g.ledger.all_entries,
                ledger_file_path=self._ledger_path(),
                today=datetime.date.today(),
                body=request.json or {},
            )
        except runway_write.SaveError as ex:
            return json.dumps({"status": "error", "message": ex.message, "issues": ex.issues}), ex.status
        result["version"] = runway.config_version(self._ledger_path())
        return json.dumps(result)

    @extension_endpoint(methods=["POST"])
    def fire_scenario_save(self):
        saved = fire.save_scenario(self._ledger_path(), request.json or {})
        return json.dumps(saved)

    @extension_endpoint(methods=["POST"])
    def fire_scenario_delete(self):
        data = request.json or {}
        fire.delete_scenario(self._ledger_path(), str(data.get("id", "")))
        return json.dumps({})
