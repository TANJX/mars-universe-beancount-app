"""BofA fetcher: one login, then checking and credit cards from the overview.

Flow per account:
    overview -> account link (matched by the last digits in fetch.yaml)
    -> Download -> current period -> file type "Microsoft Excel"
    -> Download Transactions, saved under the account's rolling name.
For accounts with an `archive` template, the period dropdown also lists closed
statements; if the newest one is missing under statements/<path>/, it is
downloaded a second time under its archive name.

Every URL, label and text pattern lives in the constants block below so it can
be tuned against the live site. Patterns marked `# UNVERIFIED` come from public
how-to guides, not from a recorded session; confirm them with
`playwright codegen` in the fetch profile and drop the marker.

When a step cannot find its element, it raises SelectorTimeout naming the step
and the constant to tune. Run `just fetch bofa --keep-open` to inspect the page
the run stopped on.
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING

from beancount_tooling.fetch import browser
from beancount_tooling.fetch.banks.base import Fetcher, NoActivity, StagedFile
from beancount_tooling.fetch.config import PLACEHOLDER

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource


# ---------------------------------------------------------------------------
# Site constants (tune these against the live site)
# ---------------------------------------------------------------------------

# Accounts overview. Without a session BofA redirects it to the sign-in form.
OVERVIEW_URL = (  # UNVERIFIED
    "https://secure.bankofamerica.com/myaccounts/brain/redirect.go"
    "?target=accountsoverview"
)

# Sign-in form (confirmed 2026-10-02 on the homepage sign-in box): "User ID"
# is a text input, or, once saved, a combobox of saved IDs ("mars.****") with
# the text input hidden; then "Password" and a "Log in" button.
LOGIN_USERNAME_LABEL = re.compile(r"^User ID", re.IGNORECASE)
LOGIN_PASSWORD_LABEL = re.compile(r"^Password", re.IGNORECASE)
LOGIN_SUBMIT_BUTTON = re.compile(r"^(Log In|Sign In)$", re.IGNORECASE)

# Logged-in marker: the sign-out control on every authenticated page.
LOGGED_IN_MARKER = re.compile(r"^(Log Out|Sign Out)$", re.IGNORECASE)  # UNVERIFIED

# MFA challenge (SMS code or push approval), matched against visible text.
MFA_TEXT = re.compile(  # UNVERIFIED
    r"authorization code|verify your identity|we sent a (code|notification)"
    r"|approve (this|the) sign.?in|check your (phone|mobile)",
    re.IGNORECASE,
)

# Rejected credentials, matched against visible text.
REJECTED_TEXT = re.compile(  # UNVERIFIED
    r"(Online ID|Passcode).{0,40}(incorrect|doesn.t match|not recognized)"
    r"|can.t find that Online ID",
    re.IGNORECASE,
)

# Overview: one link per account whose accessible name ends with the last
# digits ("Some Account - 1234"). Formatted with the regex-escaped digits.
# Confirmed 2026-10-02: "<Nickname> Account - 1234", "VISA <Name> - 1234".
# Each account also has "Show Quick View for <name>" (and sometimes "Show
# <offer> for <name>") javascript links ending in the same digits; only the
# real account link goes to target=acctDetails.
ACCOUNT_LINK_TEMPLATE = r"(?:-|\.\.\.|x|\s)\s*{digits}\s*$"
ACCOUNT_LINK_HREF = "target=acctDetails"
# The overview row shows the balance as the first money text after the account
# link ("$2,040.36"; a credit card shows the amount owed).
MONEY_TEXT = re.compile(r"(?P<neg>-)?\$(?P<amount>\d[\d,]*\.\d{2})")
# Activity page with nothing in the current period (confirmed 2026-10-02 on a
# credit card): no download link is offered at all.
NO_TRANSACTIONS_TEXT = re.compile(
    r"There are no transactions to display", re.IGNORECASE
)

# Activity page opener (confirmed 2026-10-02): checking has a "Download"
# button; credit cards have "Download transactions" links. On credit pages the
# dialog's submit carries the same name, so the submit is looked up inside the
# dialog (see _dialog_scope).
DOWNLOAD_OPEN = re.compile(r"^Download( transactions)?$", re.IGNORECASE)

# Download dialog comboboxes (confirmed 2026-10-02): "Transaction period" on
# both; file type is "Select a file type" (checking) or "File type" (credit).
# Credit pages also have a "Go to: ... transaction menu" combobox; not matched.
PERIOD_SELECT_LABEL = re.compile(r"^Transaction period$", re.IGNORECASE)
FILE_TYPE_SELECT_LABEL = re.compile(r"^(Select a )?file type$", re.IGNORECASE)
FILE_TYPE_OPTION = re.compile(r"^Microsoft Excel Format$", re.IGNORECASE)
CURRENT_PERIOD_OPTION = re.compile(r"^Current transactions?$", re.IGNORECASE)
# Checking's submit is a button named "Download transactions disabled" until
# both selects are set; credit's is a link "Download transactions".
DOWNLOAD_SUBMIT = re.compile(r"^Download( transactions)?$", re.IGNORECASE)

# Closed-statement options in the period dropdown: a month name and year
# ("September 2026") or a statement closing date ("09/24/2026").
# Credit (confirmed 2026-10-02): closing dates "September 19, 2026"; the
# archive is named for that closing month (the September 2025 archive holds
# 08/26..09/16/2025). Checking: "Period ending 09/04/2026".
STATEMENT_MONTH_OPTION = re.compile(
    r"\b(?P<month>"
    + "|".join(calendar.month_name[1:])
    + r")\s+(?:\d{1,2},\s*)?(?P<year>\d{4})\b",
    re.IGNORECASE,
)
STATEMENT_DATE_OPTION = re.compile(
    r"\b(?P<month>\d{1,2})/(?P<day>\d{1,2})/(?P<year>\d{4})\b"
)

# Timeouts.
STEP_TIMEOUT_MS = 20_000  # wait for one element before failing the step
PROBE_TIMEOUT_MS = 3_000  # how long one logged-in check waits
DOWNLOAD_TIMEOUT_MS = 60_000


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SelectorTimeout(browser.SiteStepError):
    """A step could not find its element. Names the step and the constant."""

    def __init__(self, step: str, constant: str, detail: str = ""):
        self.step = step
        self.constant = constant
        super().__init__(
            f"BofA: step '{step}' failed waiting for {constant}"
            + (f" ({detail})" if detail else "")
            + f". Tune {constant} in fetch/banks/bofa.py; rerun with --keep-open "
            "to inspect the page."
        )


class AccountNotFound(RuntimeError):
    """The overview has no single account link for the configured digits."""


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------


def account_link_pattern(digits: str | None) -> re.Pattern[str]:
    """Regex matching an overview link name that ends with `digits`."""
    if not digits or digits == PLACEHOLDER or not digits.isdigit():
        raise AccountNotFound(
            f"BofA: account digits are {digits!r}; set last4 in config/fetch.yaml"
        )
    return re.compile(
        ACCOUNT_LINK_TEMPLATE.format(digits=re.escape(digits)), re.IGNORECASE
    )


def parse_money(text: str) -> Decimal | None:
    """The first "$1,234.56" (or "-$1.00") amount in `text`."""
    m = MONEY_TEXT.search(text)
    if not m:
        return None
    amount = Decimal(m["amount"].replace(",", ""))
    return -amount if m["neg"] else amount


def parse_statement_period(label: str) -> tuple[int, int] | None:
    """(year, month) of a closed-statement option label, or None."""
    m = STATEMENT_MONTH_OPTION.search(label)
    if m:
        names = [n.lower() for n in calendar.month_name]
        return int(m["year"]), names.index(m["month"].lower())
    m = STATEMENT_DATE_OPTION.search(label)
    if m:
        month, year = int(m["month"]), int(m["year"])
        if 1 <= month <= 12:
            return year, month
    return None


def latest_statement_option(options: Sequence[str]) -> tuple[str, int, int] | None:
    """The newest closed-statement option as (label, year, month), or None."""
    best: tuple[str, int, int] | None = None
    for label in options:
        period = parse_statement_period(label)
        if period and (best is None or period > best[1:]):
            best = (label, *period)
    return best


def previous_month(today: date) -> tuple[int, int]:
    """(year, month) of the month before `today`'s."""
    if today.month == 1:
        return today.year - 1, 12
    return today.year, today.month - 1


def pick_option(options: Sequence[str], pattern: re.Pattern[str]) -> str | None:
    """First option label matching `pattern`."""
    for label in options:
        if pattern.search(label.strip()):
            return label
    return None


def archive_target(
    account: AccountConfig, options: Sequence[str], statements_dir: Path
) -> tuple[str, str] | None:
    """(option label, archive file name) to download, or None when the account
    has no archive template, no closed statement is listed, or the newest
    archive already exists under statements_dir/<account.path>/."""
    if not account.archive:
        return None
    latest = latest_statement_option(options)
    if latest is None:
        return None
    label, year, month = latest
    name = account.archive_name(year, month)
    if name is None or (statements_dir / account.path / name).exists():
        return None
    return label, name


# ---------------------------------------------------------------------------
# Page helpers
# ---------------------------------------------------------------------------


def _is_timeout(e: BaseException) -> bool:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    except ImportError:  # pragma: no cover
        return False
    return isinstance(e, PlaywrightTimeoutError)


@contextmanager
def _step(step: str, constant: str) -> Iterator[None]:
    """Turn a Playwright timeout inside the block into SelectorTimeout."""
    try:
        yield
    except Exception as e:
        if _is_timeout(e):
            raise SelectorTimeout(step, constant) from None
        raise


def _require(locator: Locator, step: str, constant: str) -> Locator:
    with _step(step, constant):
        locator.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    return locator.first


def _visible_soon(locator: Locator, timeout_ms: float) -> bool:
    try:
        locator.first.wait_for(state="visible", timeout=timeout_ms)
        return True
    except Exception:  # noqa: BLE001 (a probe, not a step)
        return False


def _text_visible(page: Page, pattern: re.Pattern[str]) -> bool:
    return page.get_by_text(pattern).first.is_visible()


def _options(select: Locator) -> list[str]:
    return [t.strip() for t in select.locator("option").all_inner_texts()]


def _clickable(page: Page | Locator, name: re.Pattern[str]) -> Locator:
    """A visible button or link with this accessible name (BofA uses both)."""
    return (
        page.get_by_role("button", name=name)
        .or_(page.get_by_role("link", name=name))
        .filter(visible=True)
    )


def _combobox(page: Page, name: re.Pattern[str]) -> Locator:
    return page.get_by_role("combobox", name=name).filter(visible=True)


def _dialog_scope(page: Page, file_type: Locator) -> Locator:
    """The innermost element holding both the file-type select and a submit
    control (ancestors come outermost-first in document order)."""
    return (
        page.locator("form, [role=dialog], div")
        .filter(has=file_type)
        .filter(has=_clickable(page, DOWNLOAD_SUBMIT))
        .last
    )


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------


class BofAFetcher(Fetcher):
    key = "bofa"
    display_name = "BofA"
    domain = "bankofamerica.com"

    def __init__(
        self,
        login_timeout_minutes: float = 5,
        *,
        statements_dir: Path | None = None,
        today: Callable[[], date] = browser.new_york_today,
        log: Callable[[str], None] = print,
    ):
        super().__init__(login_timeout_minutes)
        if statements_dir is None:
            from beancount_tooling.paths import get_statements_dir

            statements_dir = get_statements_dir()
        self.statements_dir = statements_dir
        self.today = today
        self.log = log

    # --- login --------------------------------------------------------------

    def login_spec(self) -> browser.LoginSpec:
        def username_field(p: Page) -> Locator:
            return _require(
                p.get_by_role("textbox", name=LOGIN_USERNAME_LABEL).filter(
                    visible=True
                ),
                "sign in: User ID",
                "LOGIN_USERNAME_LABEL",
            )

        def password_field(p: Page) -> Locator:
            return _require(
                # The page also carries hidden sign-in forms; take the visible one.
                p.get_by_role("textbox", name=LOGIN_PASSWORD_LABEL).filter(
                    visible=True
                ),
                "sign in: Password",
                "LOGIN_PASSWORD_LABEL",
            )

        def submit(p: Page) -> Locator:
            return _require(
                p.get_by_role("button", name=LOGIN_SUBMIT_BUTTON).filter(visible=True),
                "sign in: submit",
                "LOGIN_SUBMIT_BUTTON",
            )

        def username_prefilled(p: Page) -> bool:
            # A saved User ID shows as a "User ID" combobox (text input hidden).
            saved = p.get_by_role("combobox", name=LOGIN_USERNAME_LABEL)
            if saved.filter(visible=True).count():
                return True
            field = p.get_by_role("textbox", name=LOGIN_USERNAME_LABEL).filter(
                visible=True
            )
            if not field.count():
                return False
            return bool(field.first.input_value(timeout=PROBE_TIMEOUT_MS).strip())

        return browser.LoginSpec(
            overview_url=OVERVIEW_URL,
            is_logged_in=lambda p: _visible_soon(
                _clickable(p, LOGGED_IN_MARKER), PROBE_TIMEOUT_MS
            ),
            username_field=username_field,
            password_field=password_field,
            submit=submit,
            is_mfa=lambda p: _text_visible(p, MFA_TEXT),
            is_rejected=lambda p: _text_visible(p, REJECTED_TEXT),
            username_prefilled=username_prefilled,
        )

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        browser.login(
            page,
            self.login_spec(),
            creds,
            bank_label=self.display_name,
            timeout_minutes=self.login_timeout_minutes,
            log=self.log,
        )

    # --- download -----------------------------------------------------------

    def _account_link(self, page: Page, account: AccountConfig) -> Locator:
        pattern = account_link_pattern(account.last_digits)
        with _step("overview: load", "OVERVIEW_URL"):
            page.goto(OVERVIEW_URL, timeout=STEP_TIMEOUT_MS)
        _require(
            _clickable(page, LOGGED_IN_MARKER),
            "overview: session check",
            "LOGGED_IN_MARKER",
        )
        links = page.get_by_role("link", name=pattern).and_(
            page.locator(f'a[href*="{ACCOUNT_LINK_HREF}"]')
        )
        _require(links, "overview: account link", "ACCOUNT_LINK_TEMPLATE")
        return links

    def read_balance(self, page: Page, account: AccountConfig) -> Decimal | None:
        links = self._account_link(page, account)
        if links.count() != 1:
            return None
        # The account's row on the overview (confirmed 2026-10-02 to hold the
        # link, then the balance text).
        row = links.first.locator(
            "xpath=ancestor::*[self::li or self::tr or contains(@class,'AccountItem')"
            " or contains(@class,'account')][1]"
        )
        with _step("overview: read balance", "MONEY_TEXT"):
            snapshot = row.aria_snapshot(timeout=STEP_TIMEOUT_MS)
        return parse_money(snapshot)

    def open_account(self, page: Page, account: AccountConfig) -> None:
        links = self._account_link(page, account)
        count = links.count()
        if count != 1:
            raise AccountNotFound(
                f"BofA: {count} overview links end in the configured digits for "
                f"{account.path}; refusing to guess (tune ACCOUNT_LINK_TEMPLATE)"
            )
        with _step("overview: open account", "ACCOUNT_LINK_TEMPLATE"):
            links.first.click(timeout=STEP_TIMEOUT_MS)
        if _visible_soon(page.get_by_text(NO_TRANSACTIONS_TEXT), PROBE_TIMEOUT_MS):
            raise NoActivity(account.path)

    def open_download_dialog(self, page: Page) -> tuple[Locator, Locator]:
        """Open the dialog (or reuse it if still open after a download);
        return (period select, file type select)."""
        period = _combobox(page, PERIOD_SELECT_LABEL).first
        if not period.is_visible():
            opener = _require(
                _clickable(page, DOWNLOAD_OPEN),
                "activity: open download",
                "DOWNLOAD_OPEN",
            )
            with _step("activity: open download", "DOWNLOAD_OPEN"):
                opener.click(timeout=STEP_TIMEOUT_MS)
        period = _require(
            _combobox(page, PERIOD_SELECT_LABEL),
            "download dialog: period",
            "PERIOD_SELECT_LABEL",
        )
        file_type = _require(
            _combobox(page, FILE_TYPE_SELECT_LABEL),
            "download dialog: file type",
            "FILE_TYPE_SELECT_LABEL",
        )
        return period, file_type

    def submit_download(
        self,
        page: Page,
        period: Locator,
        file_type: Locator,
        staging_dir: Path,
        target_name: str,
        *,
        period_label: str | None,
    ) -> Path:
        """Choose the period (None keeps the dialog default) and the Excel CSV
        format, then capture the file as staging_dir/target_name."""
        if period_label is not None:
            with _step("download dialog: choose period", "PERIOD_SELECT_LABEL"):
                period.select_option(label=period_label, timeout=STEP_TIMEOUT_MS)
        with _step("download dialog: list file types", "FILE_TYPE_SELECT_LABEL"):
            types = _options(file_type)
        excel = pick_option(types, FILE_TYPE_OPTION)
        if excel is None:
            raise SelectorTimeout(
                "download dialog: file type",
                "FILE_TYPE_OPTION",
                f"no option matched among {len(types)}",
            )
        with _step("download dialog: choose file type", "FILE_TYPE_OPTION"):
            file_type.select_option(label=excel, timeout=STEP_TIMEOUT_MS)
        submit = _require(
            _clickable(_dialog_scope(page, file_type), DOWNLOAD_SUBMIT),
            "download dialog: submit",
            "DOWNLOAD_SUBMIT",
        )
        with _step("download dialog: submit", "DOWNLOAD_SUBMIT"):
            return browser.capture_download(
                page,
                lambda: submit.click(timeout=STEP_TIMEOUT_MS),
                staging_dir,
                target_name,
                timeout_ms=DOWNLOAD_TIMEOUT_MS,
            )

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        self.open_account(page, account)

        # Rolling file: the current period. A "no posted transactions"
        # placeholder is still staged; guard 1 decides what to do with it.
        period, file_type = self.open_download_dialog(page)
        with _step("download dialog: list periods", "PERIOD_SELECT_LABEL"):
            options = _options(period)
        current = pick_option(options, CURRENT_PERIOD_OPTION)
        if current is None:
            self.log(
                f"BofA: no period matched CURRENT_PERIOD_OPTION for {account.path}; "
                "keeping the dialog default"
            )
        rolling = self.submit_download(
            page, period, file_type, staging_dir, account.rolling, period_label=current
        )
        staged = [StagedFile(rolling, account.rolling, "rolling")]

        # Archive: the newest closed statement, when it is not on disk yet.
        if account.archive and latest_statement_option(options) is None:
            year, month = previous_month(self.today())
            self.log(
                f"BofA: no closed statement listed for {account.path} (expected "
                f"{calendar.month_name[month]} {year}); skipping the archive "
                "(tune STATEMENT_MONTH_OPTION)"
            )
        target = archive_target(account, options, self.statements_dir)
        if target is not None:
            label, name = target
            self.log(f"BofA: archiving the {label} statement for {account.path}")
            # The rolling file is already staged: an archive failure is reported
            # on its own and never costs the rolling update.
            try:
                period, file_type = self.open_download_dialog(page)
                path = self.submit_download(
                    page, period, file_type, staging_dir, name, period_label=label
                )
            except Exception as e:  # noqa: BLE001 (isolate failures)
                staged.append(StagedFile.failed(name, "archive", e))
            else:
                staged.append(StagedFile(path, name, "archive"))
        return staged


FETCHER_CLASS = BofAFetcher
