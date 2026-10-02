"""TD Bank (onlinebanking.tdbank.com) fetcher.

Every URL, label and text pattern lives in the constants block below so it can
be tuned against the live site. TD's checking export is one cumulative CSV
(Date, Bank RTN, Account Number, ..., Account Running Balance), so the rolling
file is re-exported over a fixed range starting at TD_HISTORY_START, not just
the current period, and there are no archives.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING

from beancount_tooling.fetch import browser
from beancount_tooling.fetch.banks.base import Fetcher, StagedFile

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource

# ---------------------------------------------------------------------------
# Site constants
# ---------------------------------------------------------------------------

# Confirmed 2026-10-02: the SPA routes a logged-out visit to
# #/authentication/login with "User name", "Password", "Remember me", "Log in".
LOGIN_URL = "https://onlinebanking.tdbank.com/#/authentication/login"
OVERVIEW_URL = "https://onlinebanking.tdbank.com/"
LOGIN_URL_PART = "#/authentication/"
LOGIN_USERNAME_LABEL = re.compile(r"^User name$", re.IGNORECASE)
LOGIN_PASSWORD_LABEL = re.compile(r"^Password$", re.IGNORECASE)
LOGIN_SUBMIT_NAME = re.compile(r"^Log in$", re.IGNORECASE)
REMEMBER_ME_LABEL = re.compile(r"Remember me", re.IGNORECASE)

MFA_TEXT = re.compile(  # UNVERIFIED
    r"security code|verification code|verify (it.s|your identity)|one.time",
    re.IGNORECASE,
)
REJECTED_TEXT = re.compile(  # UNVERIFIED
    r"(user name|password).{0,60}(incorrect|not match|invalid)",
    re.IGNORECASE,
)
# Confirmed 2026-10-02: after login the SPA lands on #/accounts with a
# "Good morning, <NAME>." heading and the accounts summary table.
ACCOUNTS_URL = "https://onlinebanking.tdbank.com/#/accounts"
LOGGED_IN_URL_PART = "#/accounts"
LOGGED_IN_HEADING = re.compile(r"^Good (morning|afternoon|evening)\b", re.IGNORECASE)

# Accounts summary (confirmed 2026-10-02): a table row per account, e.g.
# "TD BEYOND CHECKING x1234 | $A | $B | $C" with columns Available Balance,
# Today's Beginning Balance, Pending Transactions. The beginning balance
# excludes pending, like the ledger (the export only has posted rows).
ACCOUNT_CELL_TEMPLATE = r"x{digits}\b"
MONEY = re.compile(r"(?P<neg>-)?\$(?P<amount>\d[\d,]*\.\d{2})")
BEGINNING_BALANCE_INDEX = 1  # 0 available, 1 today's beginning, 2 pending

# Activity page (confirmed 2026-10-02). A "Protecting You from Fraud" modal may
# cover it once. The export covers the timeframe selected on the page, and the
# rolling file is the whole history, so "All available" is selected.
FRAUD_MODAL_DISMISS = re.compile(r"^Okay, got it$", re.IGNORECASE)
TIMEFRAME_LABEL = re.compile(r"^Select timeframe to view$", re.IGNORECASE)
TIMEFRAME_OPTION = "All available"
DOWNLOAD_OPEN = re.compile(r"download|export", re.IGNORECASE)
EXPORT_DIALOG_HEADING = re.compile(r"^Export Account Activity$", re.IGNORECASE)
EXPORT_FILE_TYPE_OPTION = "CSV - Comma Separated Value"
EXPORT_SUBMIT = re.compile(r"^Export$", re.IGNORECASE)

STEP_TIMEOUT_MS = 20_000
PROBE_TIMEOUT_MS = 3_000
DOWNLOAD_TIMEOUT_MS = 60_000

BANK_LABEL = "TD"


class TDStepError(browser.SiteStepError):
    """A site step failed. The message names the step and the constant to tune."""

    def __init__(self, step: str, constant: str, detail: str = ""):
        message = f"{BANK_LABEL}: step '{step}' failed (constant {constant} in fetch/banks/td.py)"
        if detail:
            message += f": {detail}"
        super().__init__(message + ". Rerun with --dry-run --keep-open to inspect.")


def _visible(locator: Locator) -> Locator:
    return locator.filter(visible=True)


@contextmanager
def step(name: str, constant: str) -> Iterator[None]:
    """Turn a Playwright timeout inside the block into a TDStepError."""
    try:
        yield
    except TDStepError:
        raise
    except Exception as e:
        if type(e).__name__ == "TimeoutError":
            raise TDStepError(name, constant, "timed out") from e
        raise


def parse_amounts(text: str) -> list[Decimal]:
    out = []
    for m in MONEY.finditer(text):
        amount = Decimal(m["amount"].replace(",", ""))
        out.append(-amount if m["neg"] else amount)
    return out


def account_cell_name(digits: str | None) -> re.Pattern[str]:
    if not digits or not digits.isdigit():
        raise TDStepError("find the account", "last4", f"account digits are {digits!r}")
    return re.compile(ACCOUNT_CELL_TEMPLATE.format(digits=re.escape(digits)))


def login_spec() -> browser.LoginSpec:
    def username_field(p: Page) -> Locator:
        return _visible(p.get_by_role("textbox", name=LOGIN_USERNAME_LABEL)).first

    def password_field(p: Page) -> Locator:
        return _visible(p.get_by_role("textbox", name=LOGIN_PASSWORD_LABEL)).first

    def submit(p: Page) -> Locator:
        return _visible(p.get_by_role("button", name=LOGIN_SUBMIT_NAME)).first

    def open_sign_in(p: Page) -> None:
        field = username_field(p)
        field.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        remember = p.get_by_role("checkbox", name=REMEMBER_ME_LABEL)
        if remember.count() and not remember.first.is_checked():
            p.get_by_text(REMEMBER_ME_LABEL).first.click()

    def username_prefilled(p: Page) -> bool:
        field = username_field(p)
        return bool(field.count()) and bool(
            field.input_value(timeout=PROBE_TIMEOUT_MS).strip()
        )

    def is_logged_in(p: Page) -> bool:
        if LOGIN_URL_PART in p.url:
            return False
        if LOGGED_IN_URL_PART in p.url:
            return True
        return _visible(p.get_by_role("heading", name=LOGGED_IN_HEADING)).count() > 0

    def is_mfa(p: Page) -> bool:
        # Only on the authentication routes: the accounts page has text that
        # loosely matches MFA_TEXT.
        return LOGIN_URL_PART in p.url and _visible(p.get_by_text(MFA_TEXT)).count() > 0

    def is_rejected(p: Page) -> bool:
        return _visible(p.get_by_text(REJECTED_TEXT)).count() > 0

    return browser.LoginSpec(
        overview_url=OVERVIEW_URL,
        is_logged_in=is_logged_in,
        username_field=username_field,
        password_field=password_field,
        submit=submit,
        is_mfa=is_mfa,
        is_rejected=is_rejected,
        open_sign_in=open_sign_in,
        username_prefilled=username_prefilled,
    )


class TDFetcher(Fetcher):
    key = "td"
    display_name = "TD"
    domain = "tdbank.com"

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        browser.login(
            page,
            login_spec(),
            creds,
            bank_label=self.display_name,
            timeout_minutes=self.login_timeout_minutes,
        )

    def _account_cell(self, page: Page, account: AccountConfig) -> Locator:
        name = account_cell_name(account.last_digits)
        with step("open the accounts summary", "ACCOUNTS_URL"):
            page.goto(ACCOUNTS_URL)
        cell = page.get_by_role("cell", name=name)
        with step("find the account", "ACCOUNT_CELL_TEMPLATE"):
            cell.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        if cell.count() != 1:
            raise TDStepError(
                "find the account",
                "ACCOUNT_CELL_TEMPLATE",
                f"{cell.count()} accounts match the digits",
            )
        return cell.first

    def read_balance(self, page: Page, account: AccountConfig) -> Decimal | None:
        cell = self._account_cell(page, account)
        row = page.get_by_role("row").filter(has=cell).first
        with step("read the balance", "BEGINNING_BALANCE_INDEX"):
            amounts = parse_amounts(row.aria_snapshot(timeout=STEP_TIMEOUT_MS))
        if len(amounts) <= BEGINNING_BALANCE_INDEX:
            return None
        return amounts[BEGINNING_BALANCE_INDEX]

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        cell = self._account_cell(page, account)
        with step("open the account activity", "ACCOUNT_CELL_TEMPLATE"):
            cell.click(timeout=STEP_TIMEOUT_MS)
            timeframe = _visible(page.get_by_role("combobox", name=TIMEFRAME_LABEL))
            timeframe.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        dismiss = _visible(page.get_by_role("button", name=FRAUD_MODAL_DISMISS))
        if dismiss.count():
            with step("dismiss the fraud notice", "FRAUD_MODAL_DISMISS"):
                dismiss.first.click(timeout=STEP_TIMEOUT_MS)
        with step("select All available", "TIMEFRAME_OPTION"):
            timeframe.first.select_option(label=TIMEFRAME_OPTION)
            # The table reloads for the new range; give it a moment to settle.
            page.wait_for_timeout(3_000)
        with step("open the export dialog", "DOWNLOAD_OPEN"):
            _visible(
                page.get_by_role("button", name=DOWNLOAD_OPEN).or_(
                    page.get_by_role("link", name=DOWNLOAD_OPEN)
                )
            ).first.click(timeout=STEP_TIMEOUT_MS)
            dialog = _visible(page.get_by_role("dialog")).filter(
                has=page.get_by_role("heading", name=EXPORT_DIALOG_HEADING)
            )
            dialog.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        dialog = dialog.first
        with step("choose CSV", "EXPORT_FILE_TYPE_OPTION"):
            dialog.get_by_role("combobox").first.select_option(
                label=EXPORT_FILE_TYPE_OPTION
            )
        with step("export", "EXPORT_SUBMIT"):
            submit = dialog.get_by_role("button", name=EXPORT_SUBMIT).first
            path = browser.capture_download(
                page,
                lambda: submit.click(timeout=STEP_TIMEOUT_MS),
                staging_dir,
                account.rolling,
                timeout_ms=DOWNLOAD_TIMEOUT_MS,
            )
        return [StagedFile(path, account.rolling, "rolling")]


FETCHER_CLASS = TDFetcher
