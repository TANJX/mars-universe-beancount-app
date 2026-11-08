"""Chase (secure.chase.com) credit card fetcher.

Every URL, label and text pattern lives in the constants block below so it can
be tuned against the live site. Constants marked UNVERIFIED have not been
checked against the live site yet; tune them with `--dry-run --keep-open`.

The rolling file is the "All transactions" export (Chase keeps about two years,
up to 1,000 rows per file), so every run's file is a superset of the last one
until Chase ages rows out (guard 3 reports those), and there are no archives.
The page's dropdowns are set on the components directly and Download gets a DOM
click: on some sessions the page ignores pointer clicks (see select_value). The
export is the card CSV ChaseImporter reads:
    Transaction Date,Post Date,Description,Category,Type,Amount,Memo
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
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

# Confirmed 2026-11-07: a logged-out visit to the dashboard shows the sign-in
# form inside a late-loading iframe named "logonbox" (inputs #userId-input-field-input,
# #password-input-field-input, checkbox "Remember username").
OVERVIEW_URL = "https://secure.chase.com/web/auth/dashboard"
LOGIN_URL_PART = "/logon/"
LOGGED_IN_URL_PART = "#/dashboard"
# Seen 2026-11-07: the "Let's make sure it's you" screen can sit under a
# dashboard URL, so the URL alone is not proof. UNVERIFIED: the dashboard
# header has a "Sign out" button.
LOGGED_IN_MARKER = re.compile(r"^Sign out$", re.IGNORECASE)
LOGIN_FRAME_SELECTOR = "iframe#logonbox, iframe[name='logonbox']"
LOGIN_USERNAME_LABEL = re.compile(r"^Username$", re.IGNORECASE)
LOGIN_PASSWORD_LABEL = re.compile(r"^Password$", re.IGNORECASE)
LOGIN_SUBMIT_NAME = re.compile(r"^Sign in$", re.IGNORECASE)
REMEMBER_ME_LABEL = re.compile(r"^Remember username$", re.IGNORECASE)

MFA_TEXT = re.compile(  # UNVERIFIED
    r"make sure it.s you|confirm your identity|don.t recognize (this|your) device"
    r"|(one.time|temporary|verification) code",
    re.IGNORECASE,
)
REJECTED_TEXT = re.compile(  # UNVERIFIED
    r"(information|username or password).{0,60}(doesn.t match|does not match|isn.t right|incorrect)",
    re.IGNORECASE,
)

# Confirmed 2026-11-07: the download page has three mds-select dropdowns (ids below), each a
# button named "<Label>, <value>" (Account, File type, Activity), options like
# "Freedom Unlimited (...1234)", "Spreadsheet (Excel, CSV)", "All transactions",
# "Choose a date range"; and a Download button, disabled until an account is picked.
DOWNLOAD_URL = (
    "https://secure.chase.com/web/auth/dashboard"
    "#/dashboard/accountDetails/downloadAccountTransactions/index"
)
ACCOUNT_SELECT_ID = "account-selector"
ACCOUNT_OPTION_TEMPLATE = r"\(\.\.\.{digits}\)"
FILE_TYPE_SELECT_ID = "downloadFileTypeOption"
FILE_TYPE_OPTION = re.compile(r"Spreadsheet.*CSV", re.IGNORECASE)
ACTIVITY_SELECT_ID = "downloadActivityOptionId"
ACTIVITY_OPTION = re.compile(r"^All transactions$", re.IGNORECASE)
DOWNLOAD_SUBMIT = re.compile(r"^Download$", re.IGNORECASE)

SELECT_SETTLE_MS = 1_500
DASHBOARD_SETTLE_MS = 30_000
STEP_TIMEOUT_MS = 20_000
PROBE_TIMEOUT_MS = 3_000
DOWNLOAD_TIMEOUT_MS = 60_000

BANK_LABEL = "Chase"


class ChaseStepError(browser.SiteStepError):
    """A site step failed. The message names the step and the constant to tune."""

    def __init__(self, step: str, constant: str, detail: str = ""):
        message = f"{BANK_LABEL}: step '{step}' failed (constant {constant} in fetch/banks/chase.py)"
        if detail:
            message += f": {detail}"
        super().__init__(message + ". Rerun with --dry-run --keep-open to inspect.")


def _visible(locator: Locator) -> Locator:
    return locator.filter(visible=True)


@contextmanager
def step(name: str, constant: str) -> Iterator[None]:
    """Turn a Playwright timeout inside the block into a ChaseStepError."""
    try:
        yield
    except ChaseStepError:
        raise
    except Exception as e:
        if type(e).__name__ == "TimeoutError":
            raise ChaseStepError(name, constant, "timed out") from e
        raise


def account_option_name(digits: str | None) -> re.Pattern[str]:
    if not digits or not digits.isdigit():
        raise ChaseStepError(
            "find the account", "last4", f"account digits are {digits!r}"
        )
    return re.compile(
        ACCOUNT_OPTION_TEMPLATE.format(digits=re.escape(digits)) + r"(?!\d)"
    )


# Pick a value in an mds-select by setting it on the component, the way its own
# option click does. Options come either as JSON in an `options` attribute (keys
# named by `value-key` / `label-key`; Account, File type) or as child
# mds-select-option elements with label/value attributes (Activity). Seen 2026-11-08: on some sessions the dropdown never opens
# for a scripted click (no options rendered, though a person's click works), so
# clicks are not used. The page reacts to the change events.
_OPTIONS_JS = """(s) => {
  const key = s.getAttribute('label-key') || 'name';
  const vkey = s.getAttribute('value-key') || 'value';
  let opts = [];
  try { opts = JSON.parse(s.getAttribute('options') || '[]'); } catch (e) { opts = []; }
  if (opts.length) return opts.map(o => ({label: String(o[key] ?? o.label ?? ''), value: o[vkey]}));
  return Array.from(s.querySelectorAll('mds-select-option')).map(o => ({
    label: o.getAttribute('label') || '', value: o.getAttribute('value')}));
}"""
_SELECT_JS = (
    """([id, pattern]) => {
  const s = document.querySelector('mds-select#' + id);
  if (!s) return {error: 'no select #' + id};
  const opts = ("""
    + _OPTIONS_JS
    + """)(s);
  const re = new RegExp(pattern, 'i');
  const o = opts.find(x => re.test(x.label));
  if (!o) return {error: 'no option', labels: opts.map(x => x.label)};
  s.value = o.value;
  s.setAttribute('value', o.value);
  for (const ev of ['change', 'input', 'mdsChange', 'mds-select-change', 'valueChange'])
    s.dispatchEvent(new CustomEvent(ev, {bubbles: true, composed: true, detail: {value: o.value}}));
  return {value: o.value, label: o.label};
}"""
)
_HAS_OPTIONS_JS = (
    """(id) => { const s = document.querySelector('mds-select#' + id);
  return !!s && ("""
    + _OPTIONS_JS
    + """)(s).length > 0; }"""
)


def select_value(
    page: Page, select_id: str, option: re.Pattern[str], constant: str
) -> None:
    """Choose the option matching `option` in mds-select#<select_id>."""
    with step(f"choose {option.pattern}", constant):
        page.wait_for_function(_HAS_OPTIONS_JS, arg=select_id, timeout=STEP_TIMEOUT_MS)
        result = page.evaluate(_SELECT_JS, [select_id, option.pattern])
        if result.get("error"):
            detail = result["error"]
            if result.get("labels") is not None:
                detail += f" among {len(result['labels'])} options"
            raise ChaseStepError(f"choose {option.pattern}", constant, detail)
        page.wait_for_timeout(SELECT_SETTLE_MS)


def open_download_page(page: Page, digits: re.Pattern[str]) -> None:
    """Load the dashboard until this account's tile shows (its data feeds the
    download page), then open the download page."""
    page.goto(OVERVIEW_URL)
    try:
        _visible(page.get_by_text(digits)).first.wait_for(
            state="visible", timeout=DASHBOARD_SETTLE_MS
        )
    except Exception:  # noqa: BLE001, S110 (best effort; select_value waits too)
        pass
    page.goto(DOWNLOAD_URL)


def login_spec() -> browser.LoginSpec:
    def scope(p: Page):
        # A frame locator auto-waits for the iframe, which loads after DOMContentLoaded.
        return p.frame_locator(LOGIN_FRAME_SELECTOR).first

    def username_field(p: Page) -> Locator:
        return _visible(scope(p).get_by_label(LOGIN_USERNAME_LABEL)).first

    def password_field(p: Page) -> Locator:
        return _visible(scope(p).get_by_label(LOGIN_PASSWORD_LABEL)).first

    def submit(p: Page) -> Locator:
        return _visible(scope(p).get_by_role("button", name=LOGIN_SUBMIT_NAME)).first

    def open_sign_in(p: Page) -> None:
        username_field(p).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        remember = scope(p).get_by_role("checkbox", name=REMEMBER_ME_LABEL)
        if remember.count() and not remember.first.is_checked():
            remember.first.check(force=True)

    def username_prefilled(p: Page) -> bool:
        field = username_field(p)
        return bool(field.count()) and bool(
            field.input_value(timeout=PROBE_TIMEOUT_MS).strip()
        )

    def is_logged_in(p: Page) -> bool:
        if LOGGED_IN_URL_PART not in p.url or LOGIN_URL_PART in p.url:
            return False
        if _visible(p.get_by_text(MFA_TEXT)).count():
            return False
        marker = p.get_by_role("button", name=LOGGED_IN_MARKER).or_(
            p.get_by_role("link", name=LOGGED_IN_MARKER)
        )
        return _visible(marker).count() > 0

    def _shows(p: Page, pattern: re.Pattern[str]) -> bool:
        # The MFA and error screens may render in the frame or in the page.
        return (
            _visible(p.get_by_text(pattern)).count() > 0
            or _visible(scope(p).get_by_text(pattern)).count() > 0
        )

    def is_mfa(p: Page) -> bool:
        return _shows(p, MFA_TEXT)

    def is_rejected(p: Page) -> bool:
        return _shows(p, REJECTED_TEXT)

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


class ChaseFetcher(Fetcher):
    key = "chase"
    display_name = "Chase"
    domain = "chase.com"

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
        if account.kind != "credit":
            raise ChaseStepError(
                "check the account kind", "kind", "only credit is supported"
            )
        option = account_option_name(account.last_digits)
        with step("open the download page", "DOWNLOAD_URL"):
            open_download_page(page, option)
        select_value(page, ACCOUNT_SELECT_ID, option, "ACCOUNT_OPTION_TEMPLATE")
        select_value(page, FILE_TYPE_SELECT_ID, FILE_TYPE_OPTION, "FILE_TYPE_OPTION")
        select_value(page, ACTIVITY_SELECT_ID, ACTIVITY_OPTION, "ACTIVITY_OPTION")
        submit = _visible(page.get_by_role("button", name=DOWNLOAD_SUBMIT)).first
        with step("download", "DOWNLOAD_SUBMIT"):
            path = browser.capture_download(
                page,
                # A DOM click: on some sessions this page ignores pointer
                # clicks (seen 2026-11-08), while the button's handler still
                # runs for an element.click().
                lambda: submit.evaluate("el => el.click()"),
                staging_dir,
                account.rolling,
                timeout_ms=DOWNLOAD_TIMEOUT_MS,
            )
        return [StagedFile(path, account.rolling, "rolling")]


FETCHER_CLASS = ChaseFetcher
