"""Amex fetcher.

One login covers every card on the profile. For each configured account:

1. Open Statements & Activity and switch to the card whose label carries the
   account's last5 digits (config/fetch.yaml).
2. Rolling file: on the current period, Download -> CSV with "include all
   additional transaction details" checked (the importer reads the Extended
   Details column), saved as account.rolling.
3. Archive: pick the latest closed statement period from the period selector;
   if statements/<path>/<archive name> is missing, select it and download it the
   same way, saved under account.archive_name(year, month). Archives are named
   by the statement's closing month.

Every URL, label and pattern the site logic touches lives in the constants block
below so it can be tuned live (`just fetch amex --dry-run --keep-open`). A
locator timeout raises AmexStepError naming the step and the constant involved.
No account identifiers live here: they all come from config/fetch.yaml.
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager, suppress
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING

from beancount_tooling.fetch import browser, guards
from beancount_tooling.fetch.banks.base import Fetcher, StagedFile

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource

# ---------------------------------------------------------------------------
# Site constants: tune these live. Everything marked UNVERIFIED comes from public
# help pages or recollection of the site and has not been checked against a
# logged-in session yet.
# ---------------------------------------------------------------------------

# URLs
LOGIN_URL = "https://www.americanexpress.com/en-us/account/login?inav=en_us_menu_login"
OVERVIEW_URL = "https://global.americanexpress.com/dashboard"
ACTIVITY_URL = "https://global.americanexpress.com/activity/recent"
# Amex's page CSP disables eval, so Playwright calls that run page scripts
# (inner_text, all_inner_texts, evaluate) fail there. Read labels with
# aria_snapshot() or get_attribute() instead.

# Login form (confirmed 2026-10-02: fill + submit works; 2FA is a push or code)
LOGIN_USER_ID_LABEL = re.compile(r"^\s*user\s*id\s*$", re.IGNORECASE)
LOGIN_PASSWORD_LABEL = re.compile(r"^\s*password\s*$", re.IGNORECASE)
LOGIN_SUBMIT_NAME = re.compile(r"^\s*log\s*in\s*$", re.IGNORECASE)
LOGIN_REJECTED_TEXT = re.compile(
    r"(user\s*id\s*or\s*password\s*(you\s*entered\s*)?(is|are)\s*(incorrect|not\s*valid)"
    r"|incorrect\s*user\s*id\s*or\s*password)",
    re.IGNORECASE,
)  # UNVERIFIED
# Confirmed 2026-10-02: Amex lands on .../account/two-step-verification/verify?mfaId=...
MFA_URL_PART = "/two-step-verification/"
MFA_TEXT = re.compile(
    r"(verify\s*your\s*identity|one[-\s]*time\s*(verification\s*)?code"
    r"|we\s*(just\s*)?sent\s*(you\s*)?a\s*code|verification\s*code)",
    re.IGNORECASE,
)  # UNVERIFIED
# Confirmed 2026-10-02: after login (and 2FA) Amex lands on global.../overview.
# Logged-out visits to these redirect to www.americanexpress.com/.../login.
LOGGED_IN_URL_PREFIXES = (
    "https://global.americanexpress.com/overview",
    "https://global.americanexpress.com/dashboard",
    "https://global.americanexpress.com/activity",
)
# Visible only on a logged-in page (the top nav link).
LOGGED_IN_MARKER_ROLE = "link"  # UNVERIFIED
LOGGED_IN_MARKER_NAME = re.compile(
    r"statements\s*(&|and)\s*activity", re.IGNORECASE
)  # UNVERIFIED

# One-time "Welcome to the New Statements & Activity" modal (confirmed 2026-10-02).
WELCOME_DISMISS_NAME = re.compile(r"^\s*explore\s*on\s*my\s*own\s*$", re.IGNORECASE)

# Card switcher (confirmed 2026-10-02): a combobox showing "<Card> ••••12345";
# its listbox options are named "<Card> ending in 12345." (canceled cards add
# "This account is Canceled.").
CARD_SWITCHER_TEST_ID = "simple_switcher_combobox"
CARD_OPTION_ROLE = "option"


def card_option_name(last5: str) -> re.Pattern[str]:
    return re.compile(rf"ending\s*in\s*{re.escape(last5)}\.", re.IGNORECASE)


# Statement period popover (confirmed 2026-10-02): the "Since Last Statement"
# button opens buttons for presets and "Recent Statement Periods (by Closing
# Date)", each named by its closing date, e.g. "Sep 9, 2026".
PERIOD_SELECTOR_TEST_ID = "date-picker-popover-button"
PERIOD_OPTION_ROLE = "button"
# Rolling file period. Explicit because the default view differs per card
# (one card opened on "Last 30 Days", confirmed 2026-10-02).
ROLLING_PERIOD_NAME = re.compile(r"^\s*since\s*last\s*statement\s*$", re.IGNORECASE)
PERIOD_OPTION_NAME = re.compile(r"^[A-Z][a-z]{2,8}\.?\s+\d{1,2},\s*\d{4}$")

# Download dialog
# Confirmed 2026-10-02: dialog "Select File Type" with radios Excel/CSV/
# Quickbooks/Quicken, the details checkbox (checked by default), Download button.
DOWNLOAD_OPEN_NAME = re.compile(r"^\s*download\s*$", re.IGNORECASE)
DOWNLOAD_DIALOG_ROLE = "dialog"
DOWNLOAD_DIALOG_NAME = re.compile(r"select\s*file\s*type", re.IGNORECASE)
DOWNLOAD_CSV_LABEL = re.compile(
    r"^\s*csv\s*$", re.IGNORECASE
)  # option named in Amex help pages
DOWNLOAD_DETAILS_LABEL = re.compile(
    r"include\s*all\s*additional\s*transaction\s*details", re.IGNORECASE
)  # checkbox text named in Amex help pages
DOWNLOAD_CONFIRM_NAME = re.compile(r"^\s*download\s*$", re.IGNORECASE)

# Balance summary on the activity page (seen 2026-10-02): "Pending Charges",
# "Posted Charges", "Total Balance $219.07". Total Balance is the posted balance
# owed, which is what the ledger holds (activity.csv only has posted rows).
TOTAL_BALANCE_LABEL = re.compile(r"^\s*total\s*balance\s*$", re.IGNORECASE)
TOTAL_BALANCE_AMOUNT = re.compile(
    r"total\s*balance.*?(?P<neg>-)?\$(?P<amount>\d[\d,]*\.\d{2})",
    re.IGNORECASE | re.DOTALL,
)

# Timeouts
STEP_TIMEOUT_MS = 20_000
LOGIN_SETTLE_MS = 15_000
DOWNLOAD_TIMEOUT_MS = 60_000

BANK_LABEL = "Amex"

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class AmexStepError(browser.SiteStepError):
    """A site step failed (usually a locator timeout). The message names the
    step and the constant to tune; it never contains a credential."""

    def __init__(self, step: str, constant: str, detail: str = ""):
        self.step = step
        self.constant = constant
        message = (
            f"{BANK_LABEL}: step '{step}' failed (constant {constant} in "
            "fetch/banks/amex.py)"
        )
        if detail:
            message += f": {detail}"
        message += (
            ". The page may have changed: run `just fetch amex --dry-run --keep-open`, "
            f"inspect the page, and tune {constant}."
        )
        super().__init__(message)


def _timeout_errors() -> tuple[type[BaseException], ...]:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    except ImportError:  # pragma: no cover (playwright is a dependency)
        return ()
    return (PlaywrightTimeoutError,)


@contextmanager
def step(name: str, constant: str) -> Iterator[None]:
    """Turn a Playwright timeout inside the block into AmexStepError."""
    try:
        yield
    except AmexStepError:
        raise
    except _timeout_errors() as e:
        raise AmexStepError(name, constant, "timed out") from e


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------

_MONTHS = {
    name.lower(): i
    for i in range(1, 13)
    for name in (calendar.month_name[i], calendar.month_abbr[i])
}
_MONTHS["sept"] = 9

_DATE_TOKEN = re.compile(
    r"(?P<numeric>(?P<nm>\d{1,2})/(?P<nd>\d{1,2})/(?P<ny>\d{4}|\d{2}))"
    r"|(?P<named>(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\b"
    r"(?:,?\s*(?P<year>\d{4}))?)"
)


def card_digits_pattern(last5: str) -> re.Pattern[str]:
    """Matches `last5` as a whole digit group: "-12345", "•12345" and
    "ending in 12345" match; "112345" and "123456" do not."""
    if not re.fullmatch(r"\d{5}", last5 or ""):
        raise ValueError(f"last5 must be 5 digits, got {last5!r}")
    return re.compile(rf"(?<!\d){last5}(?!\d)")


def match_card(labels: Sequence[str], last5: str) -> int:
    """Index of the one card label carrying `last5`. Raises LookupError when no
    label or more than one label matches (never guess between cards)."""
    pattern = card_digits_pattern(last5)
    hits = [i for i, label in enumerate(labels) if pattern.search(label)]
    if not hits:
        raise LookupError(f"no card ending in {last5} among {len(labels)} card(s)")
    if len(hits) > 1:
        raise LookupError(f"{len(hits)} cards match the digits {last5}")
    return hits[0]


def _token_date(m: re.Match[str]) -> tuple[int | None, int, int] | None:
    if m.group("numeric"):
        year = int(m.group("ny"))
        if year < 100:
            year += 2000
        return year, int(m.group("nm")), int(m.group("nd"))
    month = _MONTHS.get(m.group("mon").lower())
    if month is None:
        return None
    year = int(m.group("year")) if m.group("year") else None
    return year, month, int(m.group("day"))


def parse_period_label(label: str) -> tuple[date | None, date] | None:
    """Parse a statement-period label into (start, end).

    Accepts "Aug 13 - Sep 12, 2026", "Dec 13, 2025 - Jan 12, 2026",
    "08/13/2026 to 09/12/2026" and a single closing date ("Closing Date
    Sep 12, 2026", start None). A start date without a year takes the end
    date's year, rolling back one year across a December/January boundary.
    Returns None when the label has no dated end.
    """
    parts: list[tuple[int | None, int, int]] = []
    for m in _DATE_TOKEN.finditer(label):
        parsed = _token_date(m)
        if parsed is not None:
            parts.append(parsed)
    if not parts:
        return None
    end_y, end_m, end_d = parts[-1]
    if end_y is None:
        return None
    try:
        end = date(end_y, end_m, end_d)
    except ValueError:
        return None
    if len(parts) == 1:
        return None, end
    start_y, start_m, start_d = parts[-2]
    if start_y is None:
        start_y = end_y if (start_m, start_d) <= (end_m, end_d) else end_y - 1
    try:
        start = date(start_y, start_m, start_d)
    except ValueError:
        return None
    return start, end


def parse_total_balance(snapshot: str) -> Decimal | None:
    """The amount after "Total Balance" in an aria snapshot of the summary."""
    m = TOTAL_BALANCE_AMOUNT.search(snapshot)
    if not m:
        return None
    amount = Decimal(m["amount"].replace(",", ""))
    return -amount if m["neg"] else amount


def archive_period(closing: date) -> tuple[int, int]:
    """(year, month) an archive is named after: the statement's closing month."""
    return closing.year, closing.month


def latest_closed_period(
    labels: Sequence[str], today: date
) -> tuple[int, tuple[date | None, date]] | None:
    """Among period labels, the (index, (start, end)) of the statement that
    closed most recently before `today`. The open (current) period, whose end is
    today or later, is never picked. None when nothing qualifies."""
    best: tuple[int, tuple[date | None, date]] | None = None
    for i, label in enumerate(labels):
        period = parse_period_label(label)
        if period is None or period[1] >= today:
            continue
        if best is None or period[1] > best[1][1]:
            best = (i, period)
    return best


def archive_target(account: AccountConfig, closing: date) -> str | None:
    """Archive file name for the statement closing on `closing`, or None when the
    account has no archive template."""
    year, month = archive_period(closing)
    return account.archive_name(year, month)


def check_archive_dates(path: Path, closing: date) -> None:
    """A closed statement holds nothing dated after its closing date. A later
    row means the period selection did not apply and the current period was
    downloaded instead; raise rather than archive it under the wrong name."""
    latest = guards.parse_table(guards.read_text(path)).last_date
    if latest is not None and latest > closing:
        raise AmexStepError(
            "select the closed statement",
            "PERIOD_OPTION_ROLE",
            f"downloaded rows run to {latest:%Y-%m-%d}, after the closing date "
            f"{closing:%Y-%m-%d}",
        )


def require_last5(account: AccountConfig) -> str:
    """The account's last5 digits, or a clear error while still a placeholder."""
    last5 = account.last5
    if not last5 or not re.fullmatch(r"\d{5}", last5):
        raise ValueError(
            f"{account.path}: set last5 in config/fetch.yaml (the card switcher "
            f"matches on it; got {last5!r})"
        )
    return last5


# ---------------------------------------------------------------------------
# Locators: the one place that maps the constants to Playwright calls
# ---------------------------------------------------------------------------


def _user_id_field(page: Page) -> Locator:
    return page.get_by_label(LOGIN_USER_ID_LABEL).first


def _password_field(page: Page) -> Locator:
    return page.get_by_label(LOGIN_PASSWORD_LABEL).first


def _submit(page: Page) -> Locator:
    return page.get_by_role("button", name=LOGIN_SUBMIT_NAME).first


def _logged_in_marker(page: Page) -> Locator:
    return page.get_by_role(LOGGED_IN_MARKER_ROLE, name=LOGGED_IN_MARKER_NAME).first


def _card_switcher(page: Page) -> Locator:
    return page.get_by_test_id(CARD_SWITCHER_TEST_ID).first


def _period_selector(page: Page) -> Locator:
    return page.get_by_test_id(PERIOD_SELECTOR_TEST_ID).first


_SNAPSHOT_NAME = re.compile(r'^\s*-\s*\w+\s+"(?P<name>[^"]*)"')


def accessible_name(loc: Locator) -> str:
    """The accessible name of `loc`, read via aria_snapshot (no page eval)."""
    first = loc.aria_snapshot(timeout=STEP_TIMEOUT_MS).splitlines()[0]
    m = _SNAPSHOT_NAME.match(first)
    return m.group("name") if m else first


def _download_open(page: Page) -> Locator:
    return page.get_by_role("button", name=DOWNLOAD_OPEN_NAME).first


class _LoginProbe:
    """browser.login() hooks. The first logged-in check waits (bounded) for the
    page to settle on either the dashboard or the sign-in form, so a slow SPA
    redirect is not mistaken for "logged out"; later checks do not wait."""

    def __init__(self) -> None:
        self.settled = False

    def is_logged_in(self, page: Page) -> bool:
        if not self.settled:
            self.settled = True
            # Timing out here just falls through to the cheap check below.
            with suppress(Exception):
                _logged_in_marker(page).or_(_user_id_field(page)).first.wait_for(
                    state="visible", timeout=LOGIN_SETTLE_MS
                )
        if any(page.url.startswith(u) for u in LOGGED_IN_URL_PREFIXES):
            return True
        return _logged_in_marker(page).is_visible()

    @staticmethod
    def open_sign_in(page: Page) -> None:
        with step("open the sign-in form", "LOGIN_URL / LOGIN_USER_ID_LABEL"):
            if not _user_id_field(page).is_visible():
                page.goto(LOGIN_URL)
            _user_id_field(page).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)

    @staticmethod
    def username_prefilled(page: Page) -> bool:
        # "Remember me" shows the saved User ID (masked) in the field.
        return bool(_user_id_field(page).input_value(timeout=2_000).strip())

    @staticmethod
    def is_mfa(page: Page) -> bool:
        if MFA_URL_PART in page.url:
            return True
        return page.get_by_text(MFA_TEXT).first.is_visible()

    @staticmethod
    def is_rejected(page: Page) -> bool:
        return page.get_by_text(LOGIN_REJECTED_TEXT).first.is_visible()


def login_spec() -> browser.LoginSpec:
    probe = _LoginProbe()
    return browser.LoginSpec(
        overview_url=OVERVIEW_URL,
        is_logged_in=probe.is_logged_in,
        username_field=_user_id_field,
        password_field=_password_field,
        submit=_submit,
        is_mfa=probe.is_mfa,
        is_rejected=probe.is_rejected,
        open_sign_in=probe.open_sign_in,
        username_prefilled=probe.username_prefilled,
    )


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------


class AmexFetcher(Fetcher):
    key = "amex"
    display_name = BANK_LABEL
    domain = "americanexpress.com"

    def __init__(
        self,
        login_timeout_minutes: float = 5,
        *,
        statements_dir: Path | None = None,
        today: Callable[[], date] = browser.new_york_today,
    ):
        super().__init__(login_timeout_minutes)
        self._statements_dir = statements_dir
        self._today = today

    @property
    def statements_dir(self) -> Path:
        """Read only, to skip downloading an archive that already exists. The
        runner still refuses to overwrite one."""
        if self._statements_dir is None:
            from beancount_tooling.paths import get_statements_dir

            self._statements_dir = get_statements_dir()
        return self._statements_dir

    # -- login ---------------------------------------------------------------

    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        with step(
            "log in", "LOGIN_USER_ID_LABEL / LOGIN_PASSWORD_LABEL / LOGIN_SUBMIT_NAME"
        ):
            browser.login(
                page,
                login_spec(),
                creds,
                bank_label=self.display_name,
                timeout_minutes=self.login_timeout_minutes,
            )

    # -- download ------------------------------------------------------------

    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        last5 = require_last5(account)
        self._open_activity(page)
        self._select_card(page, last5)
        # Do not re-open ACTIVITY_URL here: that resets to the default card
        # (confirmed 2026-10-02). Picking a card reloads activity in place.
        self._assert_card(page, last5)
        self._select_rolling_period(page)

        staged = [
            StagedFile(
                self._download(page, staging_dir, account.rolling),
                account.rolling,
                "rolling",
            )
        ]
        if account.archive:
            # The rolling file is already staged: an archive failure is reported
            # on its own and never costs the rolling update.
            try:
                archive = self._fetch_archive(page, account, staging_dir)
            except Exception as e:  # noqa: BLE001 (isolate failures)
                archive = StagedFile.failed(account.archive, "archive", e)
            if archive is not None:
                staged.append(archive)
        return staged

    def read_balance(self, page: Page, account: AccountConfig) -> Decimal | None:
        last5 = require_last5(account)
        self._open_activity(page)
        self._select_card(page, last5)
        self._assert_card(page, last5)
        with step("read Total Balance", "TOTAL_BALANCE_LABEL"):
            label = page.get_by_text(TOTAL_BALANCE_LABEL).first
            label.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            # Walk up until the snapshot includes the amount next to the label.
            for depth in range(1, 6):
                found = parse_total_balance(
                    label.locator(f"xpath=ancestor::*[{depth}]").aria_snapshot(
                        timeout=STEP_TIMEOUT_MS
                    )
                )
                if found is not None:
                    return found
        return None

    def _open_activity(self, page: Page) -> None:
        with step("open Statements & Activity", "ACTIVITY_URL / DOWNLOAD_OPEN_NAME"):
            page.goto(ACTIVITY_URL)
            _download_open(page).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        welcome = page.get_by_role("button", name=WELCOME_DISMISS_NAME)
        if welcome.count() and welcome.first.is_visible():
            with step("dismiss the welcome modal", "WELCOME_DISMISS_NAME"):
                welcome.first.click(timeout=STEP_TIMEOUT_MS)

    def _select_card(self, page: Page, last5: str) -> None:
        pattern = card_digits_pattern(last5)
        with step("find the card switcher", "CARD_SWITCHER_TEST_ID"):
            switcher = _card_switcher(page)
            switcher.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            if pattern.search(switcher.aria_snapshot(timeout=STEP_TIMEOUT_MS)):
                return
            switcher.click(timeout=STEP_TIMEOUT_MS)
        with step("pick the card", "CARD_OPTION_ROLE / card_option_name"):
            options = page.get_by_role(CARD_OPTION_ROLE, name=card_option_name(last5))
            options.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            if options.count() != 1:
                raise AmexStepError(
                    "pick the card",
                    "CARD_OPTION_ROLE / card_option_name",
                    f"{options.count()} cards match the digits {last5}",
                )
            options.first.click(timeout=STEP_TIMEOUT_MS)

    def _assert_card(self, page: Page, last5: str) -> None:
        pattern = card_digits_pattern(last5)
        text = ""
        with step("confirm the selected card", "CARD_SWITCHER_TEST_ID"):
            for _ in range(STEP_TIMEOUT_MS // 500):
                text = _card_switcher(page).aria_snapshot(timeout=STEP_TIMEOUT_MS)
                if pattern.search(text):
                    break
                page.wait_for_timeout(500)
            _download_open(page).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        if not pattern.search(text):
            raise AmexStepError(
                "confirm the selected card",
                "CARD_SWITCHER_TEST_ID",
                f"activity page is not showing the card ending in {last5}",
            )

    def _select_rolling_period(self, page: Page) -> None:
        selector = _period_selector(page)
        with step("read the current period", "PERIOD_SELECTOR_TEST_ID"):
            current = selector.aria_snapshot(timeout=STEP_TIMEOUT_MS)
        if re.search(r"since\s*last\s*statement", current, re.IGNORECASE):
            return
        with step("select Since Last Statement", "ROLLING_PERIOD_NAME"):
            selector.click(timeout=STEP_TIMEOUT_MS)
            page.get_by_role(PERIOD_OPTION_ROLE, name=ROLLING_PERIOD_NAME).last.click(
                timeout=STEP_TIMEOUT_MS
            )
            selector.get_by_text(ROLLING_PERIOD_NAME).wait_for(
                state="visible", timeout=STEP_TIMEOUT_MS
            )
            _download_open(page).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)

    def _download(self, page: Page, staging_dir: Path, target_name: str) -> Path:
        with step(
            "open the Download dialog", "DOWNLOAD_OPEN_NAME / DOWNLOAD_DIALOG_ROLE"
        ):
            _download_open(page).click(timeout=STEP_TIMEOUT_MS)
            dialog = page.get_by_role(
                DOWNLOAD_DIALOG_ROLE, name=DOWNLOAD_DIALOG_NAME
            ).first
            dialog.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        with step("choose CSV", "DOWNLOAD_CSV_LABEL"):
            dialog.get_by_role("radio", name=DOWNLOAD_CSV_LABEL).first.check(
                timeout=STEP_TIMEOUT_MS
            )
        with step("include additional transaction details", "DOWNLOAD_DETAILS_LABEL"):
            # A styled <label> overlays the input and intercepts clicks, so
            # toggle via the label text and then verify the input state.
            box = dialog.get_by_role("checkbox", name=DOWNLOAD_DETAILS_LABEL).first
            if not box.is_checked(timeout=STEP_TIMEOUT_MS):
                dialog.get_by_text(DOWNLOAD_DETAILS_LABEL).first.click(
                    timeout=STEP_TIMEOUT_MS
                )
            if not box.is_checked(timeout=STEP_TIMEOUT_MS):
                raise AmexStepError(
                    "include additional transaction details",
                    "DOWNLOAD_DETAILS_LABEL",
                    "checkbox did not tick",
                )
        with step("start the download", "DOWNLOAD_CONFIRM_NAME"):
            confirm = dialog.get_by_role("button", name=DOWNLOAD_CONFIRM_NAME).first
            return browser.capture_download(
                page,
                lambda: confirm.click(timeout=STEP_TIMEOUT_MS),
                staging_dir,
                target_name,
                timeout_ms=DOWNLOAD_TIMEOUT_MS,
            )

    def _fetch_archive(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> StagedFile | None:
        with step("open the statement period selector", "PERIOD_SELECTOR_TEST_ID"):
            _period_selector(page).click(timeout=STEP_TIMEOUT_MS)
        with step("read the statement periods", "PERIOD_OPTION_ROLE"):
            options = page.get_by_role(PERIOD_OPTION_ROLE, name=PERIOD_OPTION_NAME)
            options.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            labels = [accessible_name(options.nth(i)) for i in range(options.count())]
        picked = latest_closed_period(labels, self._today())
        if picked is None:
            raise AmexStepError(
                "read the statement periods",
                "PERIOD_OPTION_ROLE",
                f"no closed statement among {len(labels)} period option(s)",
            )
        index, (_, closing) = picked
        target_name = archive_target(account, closing)
        if (
            target_name is None
            or (self.statements_dir / account.path / target_name).exists()
        ):
            page.keyboard.press("Escape")
            return None
        with step("select the closed statement", "PERIOD_OPTION_ROLE"):
            options.nth(index).click(timeout=STEP_TIMEOUT_MS)
            # The SPA never goes network-idle (it polls); the selector button
            # retitles to the chosen closing date once the period applies.
            _period_selector(page).get_by_text(labels[index]).wait_for(
                state="visible", timeout=STEP_TIMEOUT_MS
            )
            _download_open(page).wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        path = self._download(page, staging_dir, target_name)
        check_archive_dates(path, closing)
        return StagedFile(path, target_name, "archive")


FETCHER_CLASS = AmexFetcher
