"""X Money (x.com/i/money) fetcher.

X Money has no CSV export and no documented API. Its Activity page loads
transactions from a private gRPC-web endpoint (binary protobuf, no published
schema), so this fetcher builds its own cumulative CSV from the responses the
page itself receives: it opens Activity, scrolls the list to its end, and
decodes every SearchTransactions response by field number (the numbers in the
constants block were read off live responses). It never issues its own API
calls and never touches the session token.

Each record keeps X's own transaction id, so a re-fetch is merged by id: new
ids are appended, known ids must be unchanged. Only completed rows are written.
The merged file is then checked against the balance the site shows: the signed
amounts must add up to it, which catches a list that did not load to its end
and a direction code this module does not know.

CSV columns (COLUMNS): Id, Date (New York), Time, Amount (signed, cash effect
on the account), Balance (the available balance X shows on the row), Type,
Status, Mode, Counterparty, Label, Category, Code, Description (the statement
descriptor).

Login is manual. X signs in with a two-step form or a passkey, and X Money
then asks for its own verification when its short session has lapsed, so this
fetcher fills no credentials: it opens the page and waits (with a
notification) until the Money balance is on screen.
"""

from __future__ import annotations

import csv
import io
import re
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from beancount_tooling.fetch import browser
from beancount_tooling.fetch.banks.base import Fetcher, StagedFile

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource

# ---------------------------------------------------------------------------
# Site constants (confirmed 2026-11-13 unless marked UNVERIFIED)
# ---------------------------------------------------------------------------

BALANCE_URL = "https://x.com/i/money/balance"
ACTIVITY_URL = "https://x.com/i/money/transactions"
# A logged-out visit redirects to x.com/i/jf/onboarding/web?...&mode=login. An X
# account that has no X Money lands on /i/money/onboarding (a QR code dialog).
NO_ACCOUNT_PATH = "/i/money/onboarding"
# The Money UI renders inside an open shadow root; Playwright locators pierce it.
# The balance page shows the balance as a button named like "$1,234.56" (its
# inner text repeats the amount as animated digit fragments after the first
# line) and a link "View all activity"; both appear only once the Money session
# is verified.
LOGGED_IN_MARKER = re.compile(r"^View all activity$")
BALANCE_BUTTON = re.compile(r"^\$[\d,]+\.\d{2}$")
ACTIVITY_HEADING = re.compile(r"^Activity$")
TRANSACTION_LINKS = 'a[href^="/i/money/transactions/"]'

# The page's own transaction search (POST, application/grpc-web+proto).
SEARCH_METHOD = "OrchestratorService/SearchTransactions"
API_HOST = re.compile(r"^https://[a-z0-9-]+\.money\.x\.com/")
GRPC_CONTENT_TYPE = "application/grpc-web+proto"

# Protobuf field numbers. SearchTransactions response: repeated transaction.
F_RESPONSE_TRANSACTIONS = 1
# Transaction.
F_ID = 1
F_AMOUNT = 4  # message {1: micro-dollars}, unsigned; absent subfield means 0
F_DIRECTION = 5
F_CREATED = 6  # message {1: epoch seconds, 2: nanos}
F_CODE = 9  # ACH entry description ("PAYROLL") or an internal label
F_DISPLAY = 34
# Transaction.display: what the detail dialog shows.
F_DISPLAY_TITLE = 6
F_DISPLAY_LABEL = 7
F_DISPLAY_ROWS = 8  # repeated {1: name, 2: text, 3: {1: micro-dollars}}
F_DISPLAY_TYPE = 29
F_DISPLAY_STATUS = 30
F_DISPLAY_MODE = 31
F_ROW_NAME = 1
F_ROW_TEXT = 2
F_ROW_MONEY = 3
F_MONEY_MICROS = 1
F_TIME_SECONDS = 1
# Direction codes seen: 1 = credit from X itself (interest, welcome gift),
# 2 = external deposit, 3 = payment out. Anything else stops the fetch.
DIRECTION_SIGN = {1: 1, 2: 1, 3: -1}
COMPLETED_STATUS = "Completed"
ROW_BALANCE = "Available Balance"
ROW_CATEGORY = "Category"
ROW_DESCRIPTION = "Statement Description"
MICROS = Decimal(1_000_000)

SCROLL_ROUNDS = 200  # UNVERIFIED past one page: the account had 15 rows
SCROLL_SETTLE_MS = 1_500
STEP_TIMEOUT_MS = 30_000
POLL_SECONDS = 2.0

TIMEZONE = ZoneInfo("America/New_York")
BANK_LABEL = "X Money"

COLUMNS = (
    "Id",
    "Date",
    "Time",
    "Amount",
    "Balance",
    "Type",
    "Status",
    "Mode",
    "Counterparty",
    "Label",
    "Category",
    "Code",
    "Description",
)
# A known id must come back with these unchanged, or the fetch stops.
STABLE_COLUMNS = ("Date", "Amount")


class XMoneyStepError(browser.SiteStepError):
    """A site step failed. The message names the step, never page content."""

    def __init__(self, step: str, detail: str = ""):
        message = f"{BANK_LABEL}: step '{step}' failed (fetch/banks/xmoney.py)"
        if detail:
            message += f": {detail}"
        super().__init__(message + ". Rerun with --dry-run --keep-open to inspect.")


class AmendedRows(XMoneyStepError):
    def __init__(self, changes: list[str]):
        shown = "; ".join(changes[:5])
        more = f" (+{len(changes) - 5} more)" if len(changes) > 5 else ""
        super().__init__(
            "merge with the existing file",
            f"already-saved rows changed on the site: {shown}{more}",
        )


# ---------------------------------------------------------------------------
# Pure helpers: protobuf wire format, without a schema
# ---------------------------------------------------------------------------

Fields = dict[int, list[Any]]


class WireError(ValueError):
    """The bytes are not a well-formed protobuf message."""


def _varint(data: bytes, at: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        if at >= len(data) or shift > 63:
            raise WireError("truncated varint")
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def decode_message(data: bytes) -> Fields:
    """One message level: field number -> values in order. Varints are ints;
    length-delimited fields stay bytes (decode again for a nested message)."""
    fields: Fields = {}
    at = 0
    while at < len(data):
        key, at = _varint(data, at)
        number, wire = key >> 3, key & 7
        if number == 0:
            raise WireError("field number 0")
        if wire == 0:
            value, at = _varint(data, at)
        elif wire == 2:
            size, at = _varint(data, at)
            if at + size > len(data):
                raise WireError("truncated field")
            value = data[at : at + size]
            at += size
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if at + size > len(data):
                raise WireError("truncated fixed field")
            value = data[at : at + size]
            at += size
        else:
            raise WireError(f"wire type {wire}")
        fields.setdefault(number, []).append(value)
    return fields


def grpc_web_messages(body: bytes) -> list[bytes]:
    """The data frames of a gRPC-web body (5-byte prefix: flags, length).
    Trailer frames (flag 0x80) are dropped."""
    frames = []
    at = 0
    while at < len(body):
        if at + 5 > len(body):
            raise WireError("truncated frame header")
        flags = body[at]
        size = int.from_bytes(body[at + 1 : at + 5], "big")
        at += 5
        if at + size > len(body):
            raise WireError("truncated frame")
        if not flags & 0x80:
            frames.append(body[at : at + size])
        at += size
    return frames


def _text(fields: Fields, number: int) -> str:
    values = fields.get(number)
    if not values or not isinstance(values[0], bytes):
        return ""
    return values[0].decode("utf-8", "replace").strip()


def _sub(fields: Fields, number: int) -> Fields:
    values = fields.get(number)
    if not values or not isinstance(values[0], bytes):
        return {}
    return decode_message(values[0])


def _int(fields: Fields, number: int) -> int:
    values = fields.get(number)
    return values[0] if values and isinstance(values[0], int) else 0


def _money(micros: int) -> str:
    return f"{Decimal(micros) / MICROS:.2f}"


def row_from_transaction(data: bytes) -> dict[str, str]:
    """One CSV row from a serialized transaction. Raises XMoneyStepError when
    the record lacks an id or a time, or carries an unknown direction code."""
    txn = decode_message(data)
    txn_id = _text(txn, F_ID)
    seconds = _int(_sub(txn, F_CREATED), F_TIME_SECONDS)
    if not txn_id or not seconds:
        raise XMoneyStepError("read a transaction", "record has no id or no time")
    direction = _int(txn, F_DIRECTION)
    if direction not in DIRECTION_SIGN:
        raise XMoneyStepError(
            "read a transaction",
            f"unknown direction code {direction} (constant DIRECTION_SIGN)",
        )
    micros = _int(_sub(txn, F_AMOUNT), F_MONEY_MICROS)
    display = _sub(txn, F_DISPLAY)
    detail: dict[str, str] = {}
    for raw in display.get(F_DISPLAY_ROWS, []):
        if not isinstance(raw, bytes):
            continue
        row = decode_message(raw)
        name = _text(row, F_ROW_NAME)
        if F_ROW_MONEY in row:
            detail[name] = _money(_int(_sub(row, F_ROW_MONEY), F_MONEY_MICROS))
        else:
            detail[name] = _text(row, F_ROW_TEXT)
    when = datetime.fromtimestamp(seconds, TIMEZONE)
    return {
        "Id": txn_id,
        "Date": when.strftime("%Y-%m-%d"),
        "Time": when.strftime("%H:%M:%S"),
        "Amount": _money(DIRECTION_SIGN[direction] * micros),
        "Balance": detail.get(ROW_BALANCE, ""),
        "Type": _text(display, F_DISPLAY_TYPE),
        "Status": _text(display, F_DISPLAY_STATUS),
        "Mode": _text(display, F_DISPLAY_MODE),
        "Counterparty": _text(display, F_DISPLAY_TITLE),
        "Label": _text(display, F_DISPLAY_LABEL),
        "Category": detail.get(ROW_CATEGORY, ""),
        "Code": _text(txn, F_CODE),
        "Description": detail.get(ROW_DESCRIPTION, ""),
    }


def rows_from_search_response(body: bytes) -> list[dict[str, str]]:
    """Every transaction in one SearchTransactions gRPC-web response body."""
    rows = []
    try:
        for message in grpc_web_messages(body):
            for raw in decode_message(message).get(F_RESPONSE_TRANSACTIONS, []):
                if isinstance(raw, bytes) and raw:
                    rows.append(row_from_transaction(raw))
    except WireError as e:
        raise XMoneyStepError("decode the transaction list", str(e)) from None
    return rows


# ---------------------------------------------------------------------------
# Pure helpers: CSV merge and balance check
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
    """Existing rows stay exactly as stored; new completed ids are added.
    Returns the merged rows (sorted) and how many were added. Raises
    AmendedRows when a known id comes back with a different date or amount."""
    known = {r["Id"]: r for r in existing}
    changes = []
    added: dict[str, dict[str, str]] = {}
    for row in fetched:
        old = known.get(row["Id"])
        if old is None:
            if row["Status"] == COMPLETED_STATUS:
                added.setdefault(row["Id"], row)
            continue
        diff = [c for c in STABLE_COLUMNS if old[c] != row[c]]
        if diff:
            changes.append(f"{row['Date']} ({', '.join(diff)} changed)")
    if changes:
        raise AmendedRows(changes)
    merged = sorted([*existing, *added.values()], key=sort_key)
    return merged, len(added)


def check_total(
    merged: list[dict[str, str]],
    fetched: list[dict[str, str]],
    site_balance: Decimal | None,
) -> None:
    """The file's signed amounts must add up to the balance the site shows.
    Skipped when the site lists rows that are not completed yet (their effect
    on the shown balance is unknown) or the balance could not be read."""
    if site_balance is None:
        return
    if any(r["Status"] != COMPLETED_STATUS for r in fetched):
        return
    total = sum((Decimal(r["Amount"]) for r in merged), Decimal(0))
    if total != site_balance:
        raise XMoneyStepError(
            "check the file against the site balance",
            f"rows add up to {total:,.2f} but the site shows {site_balance:,.2f}; "
            "the Activity list may not have loaded to its end (SCROLL_ROUNDS) or a "
            "row's sign is wrong (DIRECTION_SIGN)",
        )


def parse_balance(text: str) -> Decimal | None:
    """The balance from the button's text. The button animates its digits, so
    its text is the full amount on the first line, then loose digit fragments."""
    lines = text.strip().splitlines()
    text = lines[0].strip() if lines else ""
    if not BALANCE_BUTTON.match(text):
        return None
    return Decimal(text.lstrip("$").replace(",", ""))


# ---------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------


def _visible(locator: Locator) -> Locator:
    return locator.filter(visible=True)


@contextmanager
def step(name: str) -> Iterator[None]:
    try:
        yield
    except XMoneyStepError:
        raise
    except Exception as e:
        if type(e).__name__ == "TimeoutError":
            raise XMoneyStepError(name, "timed out") from None
        raise


def is_logged_in(page: Page) -> bool:
    if "/i/money" not in page.url or NO_ACCOUNT_PATH in page.url:
        return False
    return _visible(page.get_by_role("link", name=LOGGED_IN_MARKER)).count() > 0


class XMoneyFetcher(Fetcher):
    key = "xmoney"
    display_name = "X Money"
    domain = "x.com"

    def __init__(self, login_timeout_minutes: float = 5):
        super().__init__(login_timeout_minutes)
        self._balance: Decimal | None = None

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        """Manual login: open the balance page and wait for it to show. `creds`
        is not read (see the module docstring)."""
        with step("open X Money"):
            page.goto(BALANCE_URL, wait_until="domcontentloaded")
        deadline = time.monotonic() + self.login_timeout_minutes * 60
        announced = False
        started = time.monotonic()
        while not is_logged_in(page):
            if NO_ACCOUNT_PATH in page.url:
                raise XMoneyStepError(
                    "open X Money",
                    "this X account has no X Money (the page shows the onboarding "
                    "QR code); log in to the right X account in the fetcher window",
                )
            # The page needs a few seconds to render even with a live session.
            if not announced and time.monotonic() - started > 15:
                announced = True
                print(
                    f"{BANK_LABEL}: waiting for you to log in to X or finish "
                    "the X Money verification in the fetcher window"
                )
                browser.notify(
                    "Statement fetcher", f"{BANK_LABEL}: log in or verify to continue"
                )
            if time.monotonic() >= deadline:
                raise browser.LoginTimeout(
                    f"{BANK_LABEL}: login not complete after "
                    f"{self.login_timeout_minutes:g} min"
                )
            page.wait_for_timeout(int(POLL_SECONDS * 1000))

    def read_balance(self, page: Page, account: AccountConfig) -> Decimal | None:
        if not is_logged_in(page) or "/i/money/balance" not in page.url:
            with step("open the balance page"):
                page.goto(BALANCE_URL, wait_until="domcontentloaded")
                _visible(
                    page.get_by_role("link", name=LOGGED_IN_MARKER)
                ).first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        with step("read the balance"):
            button = _visible(page.get_by_role("button", name=BALANCE_BUTTON)).first
            button.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            balance = parse_balance(button.inner_text(timeout=STEP_TIMEOUT_MS))
        if balance is None:
            raise XMoneyStepError(
                "read the balance", "unexpected balance text (BALANCE_BUTTON)"
            )
        self._balance = balance
        return balance

    def _collect(self, page: Page) -> list[dict[str, str]]:
        """Open Activity, scroll the list to its end, and decode every
        transaction search response the page receives on the way."""
        bodies: list[bytes] = []
        problems: list[str] = []

        def on_response(response: Any) -> None:
            url = response.url.split("?")[0]
            if not (API_HOST.match(url) and url.endswith(SEARCH_METHOD)):
                return
            try:
                if response.status != 200:
                    problems.append(f"HTTP {response.status}")
                    return
                kind = response.headers.get("content-type", "")
                if not kind.startswith(GRPC_CONTENT_TYPE):
                    problems.append("unexpected content type (GRPC_CONTENT_TYPE)")
                    return
                bodies.append(response.body())
            except Exception as e:  # noqa: BLE001 (reported below, by type only)
                problems.append(type(e).__name__)

        page.on("response", on_response)
        try:
            with step("open Activity"):
                page.goto(ACTIVITY_URL, wait_until="domcontentloaded")
                _visible(
                    page.get_by_role("heading", name=ACTIVITY_HEADING)
                ).first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            for _ in range(STEP_TIMEOUT_MS // 500):
                if bodies or problems:
                    break
                page.wait_for_timeout(500)
            page.wait_for_timeout(SCROLL_SETTLE_MS)
            links = page.locator(TRANSACTION_LINKS)
            still = 0
            with step("scroll Activity to its end"):
                for _ in range(SCROLL_ROUNDS):
                    seen = (links.count(), len(bodies))
                    if seen[0]:
                        links.last.scroll_into_view_if_needed(timeout=STEP_TIMEOUT_MS)
                    page.wait_for_timeout(SCROLL_SETTLE_MS)
                    still = still + 1 if (links.count(), len(bodies)) == seen else 0
                    if still >= 2:
                        break
        finally:
            page.remove_listener("response", on_response)
        if problems:
            raise XMoneyStepError("read the transaction list", "; ".join(problems[:3]))
        if not bodies:
            raise XMoneyStepError(
                "read the transaction list",
                "Activity made no transaction search call (SEARCH_METHOD)",
            )
        rows: dict[str, dict[str, str]] = {}
        for body in bodies:
            for row in rows_from_search_response(body):
                rows[row["Id"]] = row
        return list(rows.values())

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        from beancount_tooling.paths import get_statements_dir

        target = get_statements_dir() / account.path / account.rolling
        existing = read_rows(target.read_text()) if target.exists() else []
        if self._balance is None:
            self.read_balance(page, account)
        fetched = self._collect(page)
        merged, _added = merge_rows(existing, fetched)
        check_total(merged, fetched, self._balance)
        path = staging_dir / account.rolling
        path.write_text(write_rows(merged), newline="")
        return [StagedFile(path, account.rolling, "rolling")]


FETCHER_CLASS = XMoneyFetcher
