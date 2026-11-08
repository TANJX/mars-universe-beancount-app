"""Capital One (myaccounts.capitalone.com) fetcher: credit cards and 360 bank accounts.

Every URL, label and text pattern lives in the constants block below so it can
be tuned against the live site. Constants marked UNVERIFIED have not been
checked against the live site yet; tune them with `--dry-run --keep-open`.

The rolling file is one cumulative CSV exported over a fixed range, from the
account's `history_start` (default: 365 days ago) to today, so every run's
file is a superset of the last one (guard 3) and there are no archives. The
export is the CSV CapitalOneImporter reads:
    Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta
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

# Confirmed 2026-11-07: a logged-out visit to the account summary first shows
# myaccounts.capitalone.com/#/accountSummary, then a "Sign In" form (textboxes
# "Username" / "Password", checkbox "Remember Me", button "Sign in"), so the URL
# alone is not proof of a session. After login the summary has the heading
# "Account Summary" and a link per account, e.g. "360 Checking ending in ...1234".
OVERVIEW_URL = "https://myaccounts.capitalone.com/accountSummary"
LOGIN_HOST = "verified.capitalone.com"
LOGGED_IN_HOST = "myaccounts.capitalone.com"
LOGIN_USERNAME_LABEL = re.compile(r"^Username$", re.IGNORECASE)
LOGIN_PASSWORD_LABEL = re.compile(r"^Password$", re.IGNORECASE)
LOGIN_SUBMIT_NAME = re.compile(r"^Sign in$", re.IGNORECASE)
REMEMBER_ME_LABEL = re.compile(r"^Remember me$", re.IGNORECASE)
SIGN_IN_HEADING = re.compile(r"^Sign In$", re.IGNORECASE)
# "Account Summary" is a screen-reader-only heading; the visible one is the greeting.
LOGGED_IN_HEADING = re.compile(
    r"^(Account Summary|Good (Morning|Afternoon|Evening))\b", re.IGNORECASE
)

MFA_TEXT = re.compile(  # UNVERIFIED
    r"make sure it.s (really )?you|verify (it.s you|your identity)|send me a code"
    r"|(one.time|temporary|verification|security) code",
    re.IGNORECASE,
)
REJECTED_TEXT = re.compile(  # UNVERIFIED
    r"(username or password|information you entered).{0,60}(incorrect|doesn.t match|does not match|isn.t right)",
    re.IGNORECASE,
)

# Confirmed 2026-11-07 on a 360 Savings account: each account on the summary is a
# link named "<product> ending in ...1234"; its page has a "Download Transactions"
# link (an empty cdk-overlay backdrop can cover the page once, Escape clears it)
# that opens a dialog with dropdown buttons "File Type" (CSV) and "Time Period"
# (options include "Custom Date Range", which reveals textboxes "Start Date" /
# "End Date", mm/dd/yyyy), then "Download". UNVERIFIED for credit cards.
ACCOUNT_TILE_TEMPLATE = r"\.\.\.\s?{digits}(?!\d)"
OVERLAY_BACKDROP = ".cdk-overlay-backdrop-showing"
# Seen 2026-11-08 on a card page: a promo dialog ("Made for students") with a
# close button covers the page; Escape or its close/"Maybe later" button clears it.
PROMO_DISMISS = re.compile(
    r"^(close|maybe later|no thanks|not now|close dialog)$", re.IGNORECASE
)
DOWNLOAD_OPEN = re.compile(r"^Download Transactions$", re.IGNORECASE)
DIALOG_HEADING = re.compile(r"^Download Transactions$", re.IGNORECASE)
FILE_TYPE_SELECT_LABEL = re.compile(r"^File Type", re.IGNORECASE)
FILE_TYPE_OPTION = re.compile(r"^CSV", re.IGNORECASE)
PERIOD_SELECT_LABEL = re.compile(r"^Time Period", re.IGNORECASE)
PERIOD_OPTION = re.compile(r"^Custom Date Range$", re.IGNORECASE)
FROM_DATE_LABEL = re.compile(r"^Start Date$", re.IGNORECASE)
TO_DATE_LABEL = re.compile(r"^End Date$", re.IGNORECASE)
DATE_FORMAT = "%m/%d/%Y"
EXPORT_SUBMIT = re.compile(r"^(Download|Export)$", re.IGNORECASE)
# Card dialog (seen 2026-11-08): "You can export 25 months into the past up to
# one year per download"; its date inputs are not named "Start Date"/"End Date"
# in the accessibility tree, so the dialog's first two text inputs are used.
MAX_RANGE_DAYS = 364
DATE_INPUTS = "input:not([type=hidden]):not([type=checkbox]):not([type=radio])"

DEFAULT_HISTORY_DAYS = 365
STEP_TIMEOUT_MS = 20_000
PROBE_TIMEOUT_MS = 3_000
DOWNLOAD_TIMEOUT_MS = 60_000

BANK_LABEL = "Capital One"


class CapitalOneStepError(browser.SiteStepError):
    """A site step failed. The message names the step and the constant to tune."""

    def __init__(self, step: str, constant: str, detail: str = ""):
        message = f"{BANK_LABEL}: step '{step}' failed (constant {constant} in fetch/banks/capitalone.py)"
        if detail:
            message += f": {detail}"
        super().__init__(message + ". Rerun with --dry-run --keep-open to inspect.")


def _visible(locator: Locator) -> Locator:
    return locator.filter(visible=True)


@contextmanager
def step(name: str, constant: str) -> Iterator[None]:
    """Turn a Playwright timeout inside the block into a CapitalOneStepError."""
    try:
        yield
    except CapitalOneStepError:
        raise
    except Exception as e:
        if type(e).__name__ == "TimeoutError":
            raise CapitalOneStepError(name, constant, "timed out") from e
        raise


def account_tile_name(digits: str | None) -> re.Pattern[str]:
    if not digits or not digits.isdigit():
        raise CapitalOneStepError(
            "find the account", "last4", f"account digits are {digits!r}"
        )
    return re.compile(ACCOUNT_TILE_TEMPLATE.format(digits=re.escape(digits)))


def export_range(account: AccountConfig, today: date) -> tuple[date, date]:
    """Fixed-start range so each rolling file is a superset of the last."""
    start = account.history_start or today - timedelta(days=DEFAULT_HISTORY_DAYS)
    return max(start, today - timedelta(days=MAX_RANGE_DAYS)), today


def choose(
    page: Page, label: re.Pattern[str], option: re.Pattern[str], constant: str
) -> None:
    """Pick `option` in a dropdown rendered as a button (named "<Label> <value>")
    that opens a listbox of role=option items."""
    with step(f"choose {option.pattern}", constant):
        _visible(page.get_by_role("button", name=label)).first.click(
            timeout=STEP_TIMEOUT_MS
        )
        _visible(page.get_by_role("option", name=option)).first.click(
            timeout=STEP_TIMEOUT_MS
        )


def type_date(box: Locator, when: date) -> None:
    """Typed keys plus a blur: a programmatic fill() may not reach the form model."""
    box.click(timeout=STEP_TIMEOUT_MS)
    box.press_sequentially(when.strftime(DATE_FORMAT), delay=50)
    box.press("Tab")


def login_spec() -> browser.LoginSpec:
    def username_field(p: Page) -> Locator:
        return _visible(p.get_by_role("textbox", name=LOGIN_USERNAME_LABEL)).first

    def password_field(p: Page) -> Locator:
        # get_by_label found no "Password" match on 2026-11-07 (the aria tree
        # still names the input "Password"); the input type is unambiguous.
        return _visible(p.locator("input[type=password]")).first

    def submit(p: Page) -> Locator:
        return _visible(p.get_by_role("button", name=LOGIN_SUBMIT_NAME)).first

    def open_sign_in(p: Page) -> None:
        username_field(p).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        remember = p.get_by_role("checkbox", name=REMEMBER_ME_LABEL)
        if remember.count() and not remember.first.is_checked():
            remember.first.check(force=True)

    def username_prefilled(p: Page) -> bool:
        field = username_field(p)
        return bool(field.count()) and bool(
            field.input_value(timeout=PROBE_TIMEOUT_MS).strip()
        )

    def is_logged_in(p: Page) -> bool:
        if LOGGED_IN_HOST not in p.url or LOGIN_HOST in p.url:
            return False
        if _visible(p.get_by_role("heading", name=SIGN_IN_HEADING)).count():
            return False
        if _visible(p.get_by_text(MFA_TEXT)).count():
            return False
        return p.get_by_role("heading", name=LOGGED_IN_HEADING).count() > 0

    def is_mfa(p: Page) -> bool:
        return _visible(p.get_by_text(MFA_TEXT)).count() > 0

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


class CapitalOneFetcher(Fetcher):
    key = "capitalone"
    display_name = "Capital One"
    domain = "capitalone.com"

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        browser.login(
            page,
            login_spec(),
            creds,
            bank_label=self.display_name,
            timeout_minutes=self.login_timeout_minutes,
        )

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        tile_name = account_tile_name(account.last_digits)
        with step("open the account summary", "OVERVIEW_URL"):
            page.goto(OVERVIEW_URL)
        with step("open the account", "ACCOUNT_TILE_TEMPLATE"):
            tile = _visible(page.get_by_role("link", name=tile_name))
            tile.first.click(timeout=STEP_TIMEOUT_MS)
        link = _visible(
            page.get_by_role("link", name=DOWNLOAD_OPEN).or_(
                page.get_by_role("button", name=DOWNLOAD_OPEN)
            )
        ).first
        with step("open the download dialog", "DOWNLOAD_OPEN"):
            page.wait_for_timeout(3_000)
            for _ in range(3):
                promo = _visible(page.get_by_role("dialog")).filter(
                    has_not=page.get_by_role("heading", name=DIALOG_HEADING)
                )
                if not promo.count() and not page.locator(OVERLAY_BACKDROP).count():
                    break
                dismiss = _visible(promo.get_by_role("button", name=PROMO_DISMISS))
                if dismiss.count():
                    dismiss.first.click(timeout=STEP_TIMEOUT_MS)
                else:
                    page.keyboard.press("Escape")
                page.wait_for_timeout(1_000)
            link.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            link.click(timeout=STEP_TIMEOUT_MS)
            dialog = _visible(page.get_by_role("dialog")).filter(
                has=page.get_by_role("heading", name=DIALOG_HEADING)
            )
            dialog.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        dialog = dialog.first
        choose(page, FILE_TYPE_SELECT_LABEL, FILE_TYPE_OPTION, "FILE_TYPE_OPTION")
        choose(page, PERIOD_SELECT_LABEL, PERIOD_OPTION, "PERIOD_OPTION")
        start, end = export_range(account, browser.new_york_today())
        with step("fill the date range", "FROM_DATE_LABEL"):
            named = _visible(dialog.get_by_role("textbox", name=FROM_DATE_LABEL))
            if named.count():
                boxes = [
                    named.first,
                    _visible(dialog.get_by_role("textbox", name=TO_DATE_LABEL)).first,
                ]
            else:
                inputs = _visible(dialog.locator(DATE_INPUTS))
                inputs.nth(1).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
                boxes = [inputs.nth(0), inputs.nth(1)]
            type_date(boxes[0], start)
            type_date(boxes[1], end)
        submit = _visible(dialog.get_by_role("button", name=EXPORT_SUBMIT)).first
        with step("download", "EXPORT_SUBMIT"):
            path = browser.capture_download(
                page,
                lambda: submit.click(timeout=STEP_TIMEOUT_MS),
                staging_dir,
                account.rolling,
                timeout_ms=DOWNLOAD_TIMEOUT_MS,
            )
        return [StagedFile(path, account.rolling, "rolling")]


FETCHER_CLASS = CapitalOneFetcher
