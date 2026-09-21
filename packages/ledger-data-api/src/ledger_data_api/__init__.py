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

from . import portfolio, store
from .merge import (
    _credit_balance_on,
    build_grid_response,
    display_name_from_account,
)
from .models import CCCardRecord, Plan, PlanSettings, Transfer

#: Account buckets the card-balance overlay scans when `card_balance.accounts`
#: is absent from ui.yaml. Universal beancount taxonomy only — anything
#: ledger-specific (an investment sleeve's cash leaf, say) is configured, not
#: shipped.
DEFAULT_BALANCE_ACCOUNTS = ["Assets:Checking", "Assets:Saving", "Liabilities:Credit"]


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
        plans = store.list_plans(ledger_path)
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
            plans=plans,
            transfers=transfers,
            cc_records=cc_records,
            settings=settings,
            start_date=start_date,
            end_date=end_date,
            ledger_file_path=ledger_path,
        )
        return json.dumps(result, default=str)

    @extension_endpoint(methods=["POST"])
    def plan_save(self):
        data = request.json or {}
        plan = Plan.from_dict(
            {
                "id": data.get("id") or store.new_id(),
                "date": data["date"],
                "account": data["account"],
                "amount": data.get("amount", ""),
                "description": data.get("description", ""),
                "state": data.get("state"),
                "transferId": data.get("transferId"),
                "createdAt": data.get("createdAt") or "",
                "updatedAt": data.get("updatedAt") or "",
                "ccCardRef": data.get("ccCardRef"),
                "ccCycleMonth": data.get("ccCycleMonth"),
            }
        )
        saved = store.save_plan(self._ledger_path(), plan)
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
        today = datetime.date.today()
        out: list[dict] = []
        for path in sorted(g.ledger.accounts.keys()):
            if not path.startswith("Liabilities:Credit:"):
                continue
            rec = records.get(path)
            is_configured = bool(
                rec and rec.paymentDueDay is not None and rec.fundingAccount
            )
            has_inputs = bool(rec and rec.statementBalance)
            derived_curr = _credit_balance_on(
                g.ledger,
                g.filtered,
                g.conversion,
                g.ledger.fava_options,
                path,
                today,
            )
            out.append(
                {
                    "accountPath": path,
                    "displayName": display_name_from_account(path),
                    "isConfigured": is_configured,
                    "hasMonthlyInputs": has_inputs,
                    "fundingAccount": rec.fundingAccount if rec else None,
                    "statementCloseDay": rec.statementCloseDay if rec else None,
                    "paymentDueDay": rec.paymentDueDay if rec else None,
                    "statementBalance": rec.statementBalance if rec else None,
                    "currentBalance": format(
                        derived_curr.quantize(Decimal("0.01")), "f"
                    ),
                    "lastClosedDate": rec.lastClosedDate if rec else None,
                    "minimumPaymentOnly": rec.minimumPaymentOnly if rec else None,
                    "updatedAt": rec.updatedAt if rec else None,
                }
            )
        return json.dumps(out)

    @extension_endpoint(methods=["POST"])
    def cc_card_save(self):
        data = request.json or {}
        account_path = data.get("accountPath")
        if not account_path:
            return json.dumps({"status": "error", "message": "missing accountPath"})
        record = CCCardRecord.from_dict(account_path, data)
        store.save_cc_card_record(self._ledger_path(), record)
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
        """Atomically replace the override plan-set for one (card, cycle) pair.

        Body: { cardAccountPath, cycleMonth, plans: [Plan, ...] }

        Each incoming plan that lacks an `id` gets a fresh ulid; existing
        plans for the same (ref, cycle) but missing from the incoming set
        are deleted. The full update is appended in one write to plans.jsonl.
        """
        data = request.json or {}
        card_path = data.get("cardAccountPath")
        cycle = data.get("cycleMonth")
        if not card_path or not cycle:
            return json.dumps(
                {"status": "error", "message": "missing cardAccountPath / cycleMonth"}
            )
        raw_plans = data.get("plans") or []
        if not isinstance(raw_plans, list):
            return json.dumps({"status": "error", "message": "plans must be a list"})

        plans: list[Plan] = []
        for raw in raw_plans:
            if not isinstance(raw, dict):
                continue
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
                        "ccCycleMonth": cycle,
                    }
                )
            )

        saved = store.replace_cc_override(self._ledger_path(), card_path, cycle, plans)
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
