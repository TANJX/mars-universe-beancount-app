"""Robinhood (robinhood.com) investing fetcher: Individual, Roth IRA, Traditional IRA.

Robinhood offers no usable CSV export for investing activity (its account
activity report takes hours to generate), so this fetcher builds its own
cumulative CSV per account from the JSON the History page itself loads.

The browser logs in and opens the History page; the bearer token is taken from
one of the page's own requests to the API (held in memory only, never logged
or written) and the same read-only GET endpoints the page calls are paged
directly, filtered to one account. Each record keeps Robinhood's own id, so a
re-fetch is merged by id: new ids are appended, known ids must be unchanged.

CSV columns (COLUMNS): Id, Account, Date (New York), Time, Type, Symbol, Name,
Quantity, Price, Amount (cash effect on the account), Fees, Match (IRA match),
Counterparty (account number or bank name), TaxYear, Description, Detail (the
raw record as JSON, so rows can be re-classified without re-fetching).
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode, urlparse
from zoneinfo import ZoneInfo

from beancount_tooling.fetch import browser
from beancount_tooling.fetch.banks.base import Fetcher, StagedFile

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource

# ---------------------------------------------------------------------------
# Site constants (confirmed 2026-10-05 unless marked UNVERIFIED)
# ---------------------------------------------------------------------------

HISTORY_URL = "https://robinhood.com/account/history"
LOGIN_PATH = "/login"
EMAIL_LABEL = "Email"
PASSWORD_LABEL = re.compile(r"^Password")
LOGIN_SUBMIT_NAME = "Log In"  # exact: "Log in with passkeys" also matches loosely
KEEP_LOGGED_IN = re.compile(r"^Keep me logged in", re.IGNORECASE)
COOKIE_REJECT_NAME = "Reject all"
# New device: a dialog "Check your Robinhood app" (push approval) with
# "Send text instead". Code-entry wording is UNVERIFIED.
MFA_TEXT = re.compile(
    r"Check your Robinhood app|verification code|enter the code|verify",
    re.IGNORECASE,
)
REJECTED_TEXT = re.compile(  # UNVERIFIED
    r"unable to log in|(incorrect|invalid).{0,40}(email|password|credentials)",
    re.IGNORECASE,
)
# The History page's "Refine Results" bar is the logged-in marker.
LOGGED_IN_MARKER = re.compile(r"^Type$")

API = "https://api.robinhood.com"
BONFIRE = "https://bonfire.robinhood.com"
CASHIER = "https://cashier.robinhood.com"
PAGE_SIZE = 100
MAX_PAGES = 200
SETTLE_TIMEOUT_MS = 15_000
STEP_TIMEOUT_MS = 30_000
REQUEST_TIMEOUT_MS = 60_000
REQUEST_ATTEMPTS = 3

TIMEZONE = ZoneInfo("America/New_York")
BANK_LABEL = "Robinhood"

COLUMNS = (
    "Id",
    "Account",
    "Date",
    "Time",
    "Type",
    "Symbol",
    "Name",
    "Quantity",
    "Price",
    "Amount",
    "Fees",
    "Match",
    "Counterparty",
    "TaxYear",
    "Description",
    "Detail",
)
# A known id re-fetched with a different value in one of these columns means
# Robinhood re-dated or amended it: stop for that account (never re-stamp).
STABLE_COLUMNS = ("Date", "Type", "Symbol", "Quantity", "Amount")

CLOSED_ORDER_STATES = {"filled", "partially_filled", "cancelled", "canceled"}
SETTLED_DIVIDEND_STATES = {"paid", "reinvested"}


class RobinhoodStepError(browser.SiteStepError):
    """A site or API step failed. The message names the step, never a token."""

    def __init__(self, step: str, detail: str = ""):
        message = f"{BANK_LABEL}: step '{step}' failed (fetch/banks/robinhood.py)"
        if detail:
            message += f": {detail}"
        super().__init__(message)


class AmendedRows(RobinhoodStepError):
    def __init__(self, changes: list[str]):
        shown = "; ".join(changes[:5])
        more = f" (and {len(changes) - 5} more)" if len(changes) > 5 else ""
        super().__init__(
            "merge",
            f"{len(changes)} known row(s) changed upstream, not re-stamped: {shown}{more}",
        )


# ---------------------------------------------------------------------------
# Pure helpers: API records -> CSV rows
# ---------------------------------------------------------------------------


def _dec(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal(0)
    if isinstance(value, dict):
        value = value.get("amount")
    return Decimal(str(value))


def _num(value: Decimal) -> str:
    """Plain decimal text without exponent or trailing zeros ("0.12", "10")."""
    text = format(value.normalize(), "f")
    return text if text not in ("-0", "") else "0"


def _money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01'), ROUND_HALF_UP):f}"


def ny_datetime(timestamp: str) -> datetime:
    """An API timestamp (ISO, "Z" or offset) in New York time."""
    parsed = datetime.fromisoformat(timestamp)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TIMEZONE)
    return parsed.astimezone(TIMEZONE)


def _when(timestamp: str | None, fallback_date: str | None = None) -> tuple[str, str]:
    if timestamp:
        moment = ny_datetime(timestamp)
        return moment.date().isoformat(), moment.strftime("%H:%M:%S")
    return (fallback_date or "")[:10], ""


def _detail(record: dict) -> str:
    return json.dumps(record, separators=(",", ":"), sort_keys=True)


def _url_id(url: str | None) -> str:
    return (url or "").rstrip("/").rsplit("/", 1)[-1]


def _account_from_url(url: str | None) -> str:
    return _url_id(url)


@dataclass(frozen=True)
class Instrument:
    symbol: str
    name: str


def _row(**values: str) -> dict[str, str]:
    row = {c: "" for c in COLUMNS}
    row.update(values)
    return row


def rows_from_orders(
    orders: Iterable[dict], account: str, instruments: dict[str, Instrument]
) -> list[dict[str, str]]:
    """Filled (or partly filled, then closed) equity orders, one row per order."""
    rows = []
    for o in orders:
        if o.get("account_number_rhs", _account_from_url(o.get("account"))) != account:
            continue
        quantity = _dec(o.get("cumulative_quantity"))
        if o.get("state") not in CLOSED_ORDER_STATES or quantity <= 0:
            continue
        executions = o.get("executions") or []
        last = max(
            (e["timestamp"] for e in executions if e.get("timestamp")), default=None
        )
        day, time = _when(last or o.get("last_transaction_at") or o.get("updated_at"))
        instrument = instruments.get(
            o.get("instrument_id") or _url_id(o.get("instrument"))
        )
        fees = sum(
            (_dec(o.get(k)) for k in ("fees", "sec_fees", "taf_fees", "cat_fees")),
            Decimal(0),
        )
        notional = _dec(o.get("executed_notional")) or (
            quantity * _dec(o.get("average_price"))
        ).quantize(Decimal("0.01"))
        side = o.get("side")
        amount = -(notional + fees) if side == "buy" else notional - fees
        kind = o.get("type", "market")
        if o.get("is_ipo_access_order"):
            kind = "IPO"
        price = _dec(o.get("average_price"))
        name = instrument.name if instrument else ""
        description = (
            f"{name} {kind} {side} {_num(quantity)} "
            f"share{'' if quantity == 1 else 's'} at ${price.quantize(Decimal('0.01'), ROUND_HALF_UP)}"
        )
        rows.append(
            _row(
                Id=o["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="buy" if side == "buy" else "sell",
                Symbol=instrument.symbol if instrument else "",
                Name=name,
                Quantity=_num(quantity),
                Price=_num(price),
                Amount=_money(amount),
                Fees=_money(fees),
                Description=description,
                Detail=_detail(o),
            )
        )
    return rows


def rows_from_dividends(
    dividends: Iterable[dict], account: str, instruments: dict[str, Instrument]
) -> list[dict[str, str]]:
    rows = []
    for d in dividends:
        if d.get("account_number_rhs", _account_from_url(d.get("account"))) != account:
            continue
        if d.get("state") not in SETTLED_DIVIDEND_STATES:
            continue
        day, time = _when(d.get("paid_at"), d.get("payable_date"))
        instrument = instruments.get(_url_id(d.get("instrument")))
        name = instrument.name if instrument else ""
        prefix = "Early Dividends" if d.get("is_early_dividend") else "Dividend"
        rows.append(
            _row(
                Id=d["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="dividend",
                Symbol=instrument.symbol if instrument else "",
                Name=name,
                Quantity=_num(_dec(d.get("position"))),
                Price=_num(_dec(d.get("rate"))),
                Amount=_money(_dec(d.get("amount"))),
                Fees=_money(
                    _dec(d.get("withholding")) + _dec(d.get("nra_withholding"))
                ),
                Description=f"{prefix} from {name}",
                Detail=_detail(d),
            )
        )
    return rows


def rows_from_sweeps(sweeps: Iterable[dict], account: str) -> list[dict[str, str]]:
    rows = []
    for s in sweeps:
        if s.get("account_number") != account:
            continue
        amount = _dec(s.get("amount"))
        if s.get("direction") == "debit":
            amount = -amount
        interest = s.get("reason") == "interest_payment"
        day, time = _when(s.get("pay_date"))
        rows.append(
            _row(
                Id=s["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="interest" if interest else "other",
                Amount=_money(amount),
                Description="Interest" if interest else f"Sweep {s.get('reason', '')}",
                Detail=_detail(s),
            )
        )
    return rows


def rows_from_stock_loans(
    payments: Iterable[dict], account: str, instruments: dict[str, Instrument]
) -> list[dict[str, str]]:
    rows = []
    for p in payments:
        if p.get("account_number") != account:
            continue
        instrument = instruments.get(p.get("instrument_id", ""))
        name = instrument.name if instrument else p.get("symbol", "")
        day, time = _when(p.get("created_at"), p.get("record_date"))
        rows.append(
            _row(
                Id=p["id"],
                Account=account,
                Date=p.get("record_date") or day,
                Time=time,
                Type="stock_lending",
                Symbol=p.get("symbol", ""),
                Name=name,
                Amount=_money(_dec(p.get("amount"))),
                Description=f"{name} Stock Lending Payment",
                Detail=_detail(p),
            )
        )
    return rows


def rows_from_margin_interest(
    charges: Iterable[dict], account: str
) -> list[dict[str, str]]:
    rows = []
    for c in charges:
        if _account_from_url(c.get("account")) != account:
            continue
        day, time = _when(c.get("created_at"))
        rows.append(
            _row(
                Id=c["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="margin_interest",
                Amount=_money(-(_dec(c.get("amount")) - _dec(c.get("credit")))),
                Description="Robinhood Margin Interest",
                Detail=_detail(c),
            )
        )
    return rows


def rows_from_deposit_boosts(
    payouts: Iterable[dict], account: str
) -> list[dict[str, str]]:
    rows = []
    for p in payouts:
        if p.get("account_number") != account:
            continue
        day, time = _when(p.get("created_at"))
        rows.append(
            _row(
                Id=p["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="deposit_boost",
                Amount=_money(_dec(p.get("amount"))),
                Description=p.get("title") or "Gold deposit boost payout",
                Detail=_detail(p),
            )
        )
    return rows


def _side_name(info: dict | None) -> str:
    info = info or {}
    return info.get("account_name_inline") or info.get("account_name_title") or ""


def rows_from_transfers(
    transfers: Iterable[dict],
    account: str,
    bank_names: dict[str, str],
    tax_years: dict[str, str],
) -> list[dict[str, str]]:
    """Completed cash transfers touching `account`.

    ACH transfers name the Robinhood account as the originating side whatever
    the direction; `details.direction` says which way the money moved. Internal
    transfers move money from the originating to the receiving account.
    """
    rows = []
    for t in transfers:
        if t.get("state") != "completed":
            continue
        origin, receiver = (
            t.get("originating_account_id"),
            t.get("receiving_account_id"),
        )
        if account not in (origin, receiver):
            continue
        details = t.get("details") or {}
        amount = _dec(t.get("net_amount") or t.get("amount"))
        own_info = (
            t.get("originating_transfer_account_info")
            if origin == account
            else t.get("receiving_transfer_account_info")
        )
        own_name = _side_name(own_info)
        own_type = str(
            t.get(
                "originating_account_type"
                if origin == account
                else "receiving_account_type"
            )
            or ""
        )
        if (
            t.get("transfer_type") == "originated_ach"
            or t.get("receiving_account_type") == "ach_relationship"
        ):
            incoming = details.get("direction") == "deposit"
            other_id = receiver if origin == account else origin
            counterparty = bank_names.get(other_id, "") or "bank account"
        else:
            incoming = receiver == account
            other_info = (
                t.get("originating_transfer_account_info")
                if incoming
                else t.get("receiving_transfer_account_info")
            )
            other_id = origin if incoming else receiver
            other_type = t.get(
                "originating_account_type" if incoming else "receiving_account_type", ""
            )
            counterparty = (
                other_id if other_type.startswith("rhs_") else _side_name(other_info)
            )
        match = _dec(details.get("enoki_amount"))
        day, time = _when(t.get("completed_at") or t.get("created_at"))
        purpose = details.get("purpose")
        if purpose == "cashback_redemption_cc":
            kind = "cc_rebate"
        else:
            kind = "transfer_in" if incoming else "transfer_out"
        if incoming:
            source = (
                counterparty
                if not counterparty.isdigit()
                else _side_name(t.get("originating_transfer_account_info"))
            )
            ira = "ira" in own_type
            verb = (
                "Contribution to"
                if ira and t.get("transfer_type") == "originated_ach"
                else "Transfer to"
            )
            description = f"{verb} {own_name} from {source}"
        else:
            target = (
                counterparty
                if not counterparty.isdigit()
                else _side_name(t.get("receiving_transfer_account_info"))
            )
            description = f"Transfer from {own_name} to {target}"
        rows.append(
            _row(
                Id=t["id"],
                Account=account,
                Date=day,
                Time=time,
                Type=kind,
                Amount=_money(amount if incoming else -amount),
                Fees=_money(_dec(t.get("service_fee"))),
                Match=_money(match) if match else "",
                Counterparty=counterparty,
                TaxYear=tax_years.get(t["id"], ""),
                Description=description,
                Detail=_detail(t),
            )
        )
    return rows


def rows_from_other(
    records: Iterable[dict], account: str, kind: str, description: str
) -> list[dict[str, str]]:
    """Rare corporate actions (ADR fees, splits): kept for the record, booked by hand."""
    rows = []
    for r in records:
        own = (
            r.get("account_number_rhs")
            or r.get("account_number")
            or _account_from_url(r.get("account"))
        )
        if own != account:
            continue
        day, time = _when(r.get("paid_at") or r.get("updated_at"), r.get("record_date"))
        amount = _dec(r.get("amount")) if r.get("amount") is not None else Decimal(0)
        rows.append(
            _row(
                Id=r["id"],
                Account=account,
                Date=day,
                Time=time,
                Type="other",
                Amount=_money(-amount if kind == "adr_fee" else amount),
                Description=description,
                Detail=_detail(r),
            )
        )
    return rows


def contribution_tax_year(detail: dict) -> str:
    """The "Tax year" row of a unified transfer's /contribution/ response."""
    for row in detail.get("rows") or []:
        if str(row.get("label", "")).strip().lower() == "tax year":
            return str(row.get("value", "")).strip()
    return ""


# ---------------------------------------------------------------------------
# Pure helpers: CSV merge
# ---------------------------------------------------------------------------


def read_rows(text: str) -> list[dict[str, str]]:
    if not text.strip():
        return []
    reader = csv.DictReader(io.StringIO(text, newline=""))
    return [{c: (r.get(c) or "") for c in COLUMNS} for r in reader]


def write_rows(rows: Iterable[dict[str, str]]) -> str:
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({c: row.get(c, "") for c in COLUMNS})
    return out.getvalue()


def sort_key(row: dict[str, str]) -> tuple[str, str, str]:
    return (row["Date"], row["Time"], row["Id"])


def merge_rows(
    existing: list[dict[str, str]], fetched: list[dict[str, str]]
) -> tuple[list[dict[str, str]], int]:
    """Existing rows stay exactly as stored; new ids are added. Returns the
    merged rows (sorted) and how many were added. Raises AmendedRows when a
    known id comes back with a different STABLE_COLUMNS value."""
    known = {r["Id"]: r for r in existing}
    changes = []
    added: dict[str, dict[str, str]] = {}
    for row in fetched:
        old = known.get(row["Id"])
        if old is None:
            added.setdefault(row["Id"], row)
            continue
        diff = [
            f"{c} {old[c]!r} -> {row[c]!r}" for c in STABLE_COLUMNS if old[c] != row[c]
        ]
        if diff:
            changes.append(f"{row['Id']} ({', '.join(diff)})")
    if changes:
        raise AmendedRows(changes)
    merged = sorted([*existing, *added.values()], key=sort_key)
    return merged, len(added)


# ---------------------------------------------------------------------------
# Browser login
# ---------------------------------------------------------------------------


def _visible(locator: Locator) -> Locator:
    return locator.filter(visible=True)


@contextmanager
def step(name: str) -> Iterator[None]:
    try:
        yield
    except RobinhoodStepError:
        raise
    except Exception as e:
        if type(e).__name__ == "TimeoutError":
            # from None: Playwright's message carries the request's call log,
            # which includes the authorization header and cookies.
            raise RobinhoodStepError(name, "timed out") from None
        raise


def login_spec() -> browser.LoginSpec:
    def email_field(p: Page) -> Locator:
        return _visible(p.get_by_role("textbox", name=EMAIL_LABEL, exact=True)).first

    def password_field(p: Page) -> Locator:
        return _visible(p.get_by_role("textbox", name=PASSWORD_LABEL)).first

    def submit(p: Page) -> Locator:
        return _visible(
            p.get_by_role("button", name=LOGIN_SUBMIT_NAME, exact=True)
        ).first

    def marker(p: Page) -> Locator:
        return _visible(p.get_by_role("combobox", name=LOGGED_IN_MARKER))

    def is_logged_in(p: Page) -> bool:
        # The SPA first renders the requested route, then redirects to /login
        # when there is no session: wait for one outcome before answering.
        if urlparse(p.url).path.startswith(LOGIN_PATH):
            return False
        try:
            marker(p).or_(email_field(p)).first.wait_for(
                state="visible", timeout=SETTLE_TIMEOUT_MS
            )
        except Exception:  # noqa: BLE001 (not settled yet: not logged in)
            return False
        return not urlparse(p.url).path.startswith(LOGIN_PATH) and marker(p).count() > 0

    def is_mfa(p: Page) -> bool:
        return _visible(p.get_by_role("dialog").get_by_text(MFA_TEXT)).count() > 0

    def is_rejected(p: Page) -> bool:
        return _visible(p.get_by_text(REJECTED_TEXT)).count() > 0

    def open_sign_in(p: Page) -> None:
        email_field(p).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        cookies = _visible(p.get_by_role("button", name=COOKIE_REJECT_NAME, exact=True))
        if cookies.count():
            cookies.first.click()
        keep = p.get_by_role("checkbox", name=KEEP_LOGGED_IN)
        if keep.count() and not keep.first.is_checked():
            p.get_by_text(KEEP_LOGGED_IN).first.click()

    def username_prefilled(p: Page) -> bool:
        return bool(email_field(p).input_value(timeout=3_000).strip())

    return browser.LoginSpec(
        overview_url=HISTORY_URL,
        is_logged_in=is_logged_in,
        username_field=email_field,
        password_field=password_field,
        submit=submit,
        is_mfa=is_mfa,
        is_rejected=is_rejected,
        open_sign_in=open_sign_in,
        username_prefilled=username_prefilled,
    )


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------


class RobinhoodFetcher(Fetcher):
    key = "robinhood"
    display_name = "Robinhood"
    domain = "robinhood.com"

    def __init__(self, login_timeout_minutes: float = 5):
        super().__init__(login_timeout_minutes)
        self._auth: str | None = None
        self._shared: dict[str, list[dict]] = {}
        self._instruments: dict[str, Instrument] = {}
        self._bank_names: dict[str, str] = {}

    # -- session ------------------------------------------------------------

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        browser.login(
            page,
            login_spec(),
            creds,
            bank_label=self.display_name,
            timeout_minutes=self.login_timeout_minutes,
        )
        self._capture_auth(page)

    def _capture_auth(self, page: Page) -> None:
        """Take the bearer token from one of the History page's own API calls."""
        holder: dict[str, str] = {}

        def on_request(request: Any) -> None:
            if request.url.startswith(API) and "authorization" in request.headers:
                holder["auth"] = request.headers["authorization"]

        page.on("request", on_request)
        try:
            with step("open History"):
                page.goto(HISTORY_URL, wait_until="domcontentloaded")
            for _ in range(STEP_TIMEOUT_MS // 500):
                if "auth" in holder:
                    break
                page.wait_for_timeout(500)
        finally:
            page.remove_listener("request", on_request)
        if "auth" not in holder:
            raise RobinhoodStepError("read the session", "History made no API call")
        self._auth = holder["auth"]

    def _get(self, page: Page, url: str, *, retry: bool = True) -> Any:
        if self._auth is None:
            self._capture_auth(page)
        endpoint = urlparse(url).path
        response = None
        for attempt in range(REQUEST_ATTEMPTS):
            try:
                response = page.request.get(
                    url,
                    headers={"authorization": self._auth or ""},
                    timeout=REQUEST_TIMEOUT_MS,
                )
                break
            except Exception as e:  # noqa: BLE001
                # Never chain or print Playwright's error here: its call log
                # lists the request headers, including the bearer token.
                failure = type(e).__name__
                if attempt + 1 < REQUEST_ATTEMPTS:
                    page.wait_for_timeout(2_000)
        if response is None:
            raise RobinhoodStepError(f"read {endpoint}", failure)
        if response.status == 401 and retry:
            self._capture_auth(page)
            return self._get(page, url, retry=False)
        if response.status != 200:
            raise RobinhoodStepError(f"read {endpoint}", f"HTTP {response.status}")
        return response.json()

    def _paged(
        self,
        page: Page,
        url: str,
        *,
        stop: Callable[[list[dict]], bool] = lambda items: False,
    ) -> list[dict]:
        """Follow `next` cursors. `stop(items)` is asked after each page."""
        items: list[dict] = []
        for _ in range(MAX_PAGES):
            body = self._get(page, url)
            results = body if isinstance(body, list) else body.get("results") or []
            items += results
            url = None if isinstance(body, list) else body.get("next")
            if not url or not results or stop(results):
                break
        return items

    # -- lookups ------------------------------------------------------------

    def _resolve_instruments(self, page: Page, ids: Iterable[str]) -> None:
        missing = sorted({i for i in ids if i and i not in self._instruments})
        for start in range(0, len(missing), 50):
            chunk = missing[start : start + 50]
            body = self._get(
                page,
                f"{API}/instruments/?"
                + urlencode(
                    {"active_instruments_only": "false", "ids": ",".join(chunk)}
                ),
            )
            for ins in body.get("results") or []:
                if ins:
                    self._instruments[ins["id"]] = Instrument(
                        ins["symbol"],
                        ins.get("simple_name") or ins.get("name") or ins["symbol"],
                    )

    def _bank_name(self, page: Page, relationship_id: str) -> str:
        if relationship_id not in self._bank_names:
            try:
                body = self._get(
                    page, f"{CASHIER}/ach/relationships/{relationship_id}/"
                )
                self._bank_names[relationship_id] = (
                    body.get("bank_account_nickname") or ""
                )
            except RobinhoodStepError:
                self._bank_names[relationship_id] = ""
        return self._bank_names[relationship_id]

    def _shared_list(self, page: Page, name: str, url: str, stop) -> list[dict]:
        """Endpoints that are not filtered by account: read once per run."""
        if name not in self._shared:
            self._shared[name] = self._paged(page, url, stop=stop)
        return self._shared[name]

    # -- fetch --------------------------------------------------------------

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        from beancount_tooling.paths import get_statements_dir

        number = account.account_number
        if not number:
            raise RobinhoodStepError(
                "configure", f"{account.path} has no account_number"
            )
        target = get_statements_dir() / account.path / account.rolling
        existing = read_rows(target.read_text()) if target.exists() else []
        known = {r["Id"] for r in existing}
        start = account.history_start.isoformat() if account.history_start else ""

        def stop_when_known_or_old(field: str) -> Callable[[list[dict]], bool]:
            def stop(items: list[dict]) -> bool:
                if all(i.get("id") in known for i in items):
                    return True
                oldest = min((str(i.get(field) or "") for i in items), default="")
                return bool(start) and bool(oldest) and oldest[:10] < start

            return stop

        per_account = urlencode({"account_numbers": number, "page_size": PAGE_SIZE})
        with step("read orders"):
            orders = self._paged(
                page,
                f"{API}/orders/?{per_account}&is_closed=true",
                stop=stop_when_known_or_old("created_at"),
            )
        with step("read dividends"):
            # Not sorted by date: read every page.
            dividends = self._paged(page, f"{API}/dividends/?{per_account}")
        with step("read interest"):
            sweeps = self._paged(page, f"{API}/accounts/sweeps/?{per_account}")
        with step("read stock lending"):
            loans = self._paged(
                page, f"{API}/accounts/stock_loan_payments/?{per_account}"
            )
        with step("read corporate actions"):
            adr_fees = self._paged(page, f"{API}/corp_actions/adr_fees/?{per_account}")
            splits = self._paged(
                page, f"{API}/corp_actions/v2/split_payments/?{per_account}"
            )
        with step("read transfers"):
            transfers = self._shared_list(
                page,
                "transfers",
                f"{BONFIRE}/paymenthub/unified_transfers/?page_size=50",
                lambda items: (
                    bool(start)
                    and min(
                        (str(i.get("created_at") or "") for i in items), default="z"
                    )[:10]
                    < start
                ),
            )
        with step("read margin interest"):
            margin = self._shared_list(
                page,
                "margin",
                f"{API}/cash_journal/margin_interest_charges/?default_to_all_accounts=true&page_size={PAGE_SIZE}",
                lambda items: False,
            )
        with step("read deposit boosts"):
            boosts = self._shared_list(
                page,
                "boosts",
                f"{BONFIRE}/gold/deposit_boost_paid_payouts/",
                lambda items: False,
            )

        with step("read instruments"):
            self._resolve_instruments(
                page,
                [o.get("instrument_id") or _url_id(o.get("instrument")) for o in orders]
                + [_url_id(d.get("instrument")) for d in dividends]
                + [p.get("instrument_id", "") for p in loans],
            )

        mine = [
            t
            for t in transfers
            if number
            in (t.get("originating_account_id"), t.get("receiving_account_id"))
        ]
        bank_names = {}
        tax_years = {}
        for t in mine:
            for side in ("originating", "receiving"):
                if t.get(f"{side}_account_type") == "ach_relationship":
                    rel = t[f"{side}_account_id"]
                    bank_names[rel] = self._bank_name(page, rel)
            own_side = (
                "originating"
                if t.get("originating_account_id") == number
                else "receiving"
            )
            if (
                t["id"] not in known
                and t.get("state") == "completed"
                and "ira" in str(t.get(f"{own_side}_account_type") or "")
                and t.get("details", {}).get("purpose") != "cashback_redemption_cc"
            ):
                try:
                    detail = self._get(
                        page,
                        f"{BONFIRE}/paymenthub/unified_transfers/{t['id']}/contribution/",
                    )
                    tax_years[t["id"]] = contribution_tax_year(detail)
                except RobinhoodStepError:
                    pass

        fetched = (
            rows_from_orders(orders, number, self._instruments)
            + rows_from_dividends(dividends, number, self._instruments)
            + rows_from_sweeps(sweeps, number)
            + rows_from_stock_loans(loans, number, self._instruments)
            + rows_from_margin_interest(margin, number)
            + rows_from_deposit_boosts(boosts, number)
            + rows_from_transfers(mine, number, bank_names, tax_years)
            + rows_from_other(adr_fees, number, "adr_fee", "ADR fee")
            + rows_from_other(splits, number, "split", "Stock split")
        )
        if start:
            fetched = [r for r in fetched if r["Date"] >= start]
        merged, _added = merge_rows(existing, fetched)

        path = staging_dir / account.rolling
        path.write_text(write_rows(merged), newline="")
        return [StagedFile(path, account.rolling, "rolling")]


FETCHER_CLASS = RobinhoodFetcher
