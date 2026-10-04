"""Browser plumbing shared by every bank fetcher.

- One persistent Chrome profile, headed, pinned to New York time (the
  reconciliation rule that statement exports are always taken in NY time,
  enforced in code instead of by memory).
- No tracing, video or HAR recording: a trace captures typed values.
- Downloads land in a per-run staging dir under $TMPDIR/bank-fetch/<run-id>/,
  never directly in statements/.
- A login helper implementing the plan's login flow.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Locator, Page

    from beancount_tooling.fetch.credentials import CredentialSource

TIMEZONE = "America/New_York"
# Bank pages load slowly through the proxy (BofA's sign-in took 16 s on
# 2026-10-05 and a run failed on Playwright's 30 s default), so the context
# defaults are raised. Site steps keep their own shorter timeouts.
NAVIGATION_TIMEOUT_MS = 90_000
ACTION_TIMEOUT_MS = 45_000
STAGING_ROOT_NAME = "bank-fetch"
# Every field a person can type into: usernames, passcodes (including one a
# "show passcode" toggle switched to type=text), one-time codes.
TEXT_ENTRY_SELECTOR = (
    "input:not([type=hidden]):not([type=checkbox]):not([type=radio])"
    ":not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),"
    " textarea"
)
# Playwright's default Chrome switches include these two on macOS. With them,
# Chrome encrypts cookies and saved logins with a hardcoded mock key instead of
# the "Chrome Safe Storage" keychain item, so any copy of the profile dir (a
# backup, Time Machine) would expose the remembered-device and session cookies.
# Dropping them makes Chrome use the real macOS keychain (it may ask for
# keychain access once on first launch).
# `--enable-automation` is also dropped (with AutomationControlled disabled via
# EXTRA_ARGS) so navigator.webdriver is false: bank login pages silently refuse
# a submit from a browser that reports itself as automated.
IGNORED_DEFAULT_ARGS = (
    "--use-mock-keychain",
    "--password-store=basic",
    "--enable-automation",
)
EXTRA_ARGS = ("--disable-blink-features=AutomationControlled",)
# Merged into <profile>/Default/Preferences before every launch so Chrome never
# offers to save the bank password that login() fills.
PASSWORD_MANAGER_OFF_PREFS: dict[str, Any] = {
    "credentials_enable_service": False,
    "profile": {"password_manager_enabled": False},
}


def new_york_today() -> date:
    """Today's date in New York, the timezone every statement is exported in."""
    return datetime.now(ZoneInfo(TIMEZONE)).date()


# ---------------------------------------------------------------------------
# Profile and context
# ---------------------------------------------------------------------------


def ensure_private_dir(path: Path) -> Path:
    """Create `path` (and parents) and force it to mode 0700."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def _deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def clear_download_history(profile_dir: Path) -> None:
    """Delete the profile's download records before launch.

    Chrome 154 segfaults in the browser process as a download completes when
    the history holds earlier downloads whose files are gone (Playwright saves
    to a temp artifacts dir that it deletes on exit). Seen 2026-10-02 on every
    run after the first; clearing these tables fixed it. Browsing history and
    cookies are untouched.
    """
    history = profile_dir / "Default" / "History"
    if not history.exists():
        return
    try:
        with sqlite3.connect(history) as db:
            for table in ("downloads_url_chains", "downloads_slices", "downloads"):
                db.execute(f"DELETE FROM {table}")
    except sqlite3.Error:
        pass  # schema change or locked: Chrome still starts, maybe crashes later


def disable_password_manager(profile_dir: Path) -> Path:
    """Turn Chrome's password manager off in the profile, keeping existing prefs.

    Writes <profile>/Default/Preferences (dir 0700, file 0600). A file Chrome
    cannot parse would be reset by Chrome anyway, so it is replaced.
    """
    default_dir = ensure_private_dir(profile_dir / "Default")
    prefs_path = default_dir / "Preferences"
    prefs: dict[str, Any] = {}
    if prefs_path.exists():
        try:
            loaded = json.loads(prefs_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            loaded = None
        if isinstance(loaded, dict):
            prefs = loaded
    _deep_merge(prefs, json.loads(json.dumps(PASSWORD_MANAGER_OFF_PREFS)))
    fd = os.open(prefs_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(prefs, f)
    os.chmod(prefs_path, 0o600)
    return prefs_path


@contextmanager
def open_context(profile_dir: Path, **overrides: Any) -> Iterator[BrowserContext]:
    """Launch real Chrome on the persistent profile and yield its context.

    Requires Google Chrome installed (channel="chrome"); no `playwright install`.
    """
    from playwright.sync_api import sync_playwright

    options: dict[str, Any] = {
        "channel": "chrome",
        "headless": False,
        "timezone_id": TIMEZONE,
        "accept_downloads": True,
        "ignore_default_args": list(IGNORED_DEFAULT_ARGS),
        "args": list(EXTRA_ARGS),
    }
    options.update(overrides)
    # Recording options must never be enabled: they would capture typed secrets.
    for forbidden in ("record_har_path", "record_video_dir"):
        if options.get(forbidden):
            raise ValueError(f"{forbidden} is not allowed for the statement fetcher")
    ensure_private_dir(profile_dir)
    disable_password_manager(profile_dir)
    clear_download_history(profile_dir)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(profile_dir), **options)
        context.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)
        context.set_default_timeout(ACTION_TIMEOUT_MS)
        if os.environ.get("FETCH_DEBUG"):
            attach_debug_log(context, Path(os.environ["FETCH_DEBUG"]))
        try:
            yield context
        finally:
            context.close()


def attach_debug_log(context: BrowserContext, log_path: Path) -> None:
    """Append console messages, page errors and >=400 responses to log_path.

    Enabled with FETCH_DEBUG=<path>. Logs URLs, status codes and console text
    only, never request bodies or headers (the login POST carries the password).
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fh = log_path.open("a", encoding="utf-8")
    os.chmod(log_path, 0o600)

    def write(line: str) -> None:
        fh.write(f"{datetime.now().astimezone().strftime('%H:%M:%S')} {line}\n")
        fh.flush()

    def on_page(page: Page) -> None:
        page.on("console", lambda m: write(f"console.{m.type}: {m.text}"))
        page.on("pageerror", lambda e: write(f"pageerror: {e}"))
        page.on(
            "framenavigated",
            lambda f: f.parent_frame is None and write(f"nav: {f.url}"),
        )

    for page in context.pages:
        on_page(page)
    context.on("page", on_page)
    context.on(
        "response",
        lambda r: (
            r.status >= 400 and write(f"http {r.status} {r.request.method} {r.url}")
        ),
    )
    context.on(
        "requestfailed",
        lambda r: write(f"requestfailed {r.method} {r.url} {r.failure}"),
    )


def first_page(context: BrowserContext) -> Page:
    """The persistent context opens with one tab; reuse it."""
    return context.pages[0] if context.pages else context.new_page()


# ---------------------------------------------------------------------------
# Staging and downloads
# ---------------------------------------------------------------------------


def new_run_id() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"


def make_staging_dir(run_id: str | None = None, root: Path | None = None) -> Path:
    """$TMPDIR/bank-fetch/<run-id>/, created 0700."""
    root = root or Path(tempfile.gettempdir()) / STAGING_ROOT_NAME
    ensure_private_dir(root)
    return ensure_private_dir(root / (run_id or new_run_id()))


def account_staging_dir(run_dir: Path, account_path: str) -> Path:
    """<run-dir>/<type>/<name>/. Mirrors statements/<path>/ so the importers'
    path-based identify() accepts the staged file."""
    return ensure_private_dir(run_dir / account_path)


def capture_download(
    page: Page,
    trigger: Callable[[], None],
    dest_dir: Path,
    target_name: str,
    *,
    timeout_ms: float = 60_000,
) -> Path:
    """Run `trigger` (the click that starts the export) and save the download as
    dest_dir/target_name. Raises RuntimeError if the download fails."""
    if "/" in target_name or target_name in ("", ".", ".."):
        raise ValueError(f"target_name must be a bare file name: {target_name!r}")
    with page.expect_download(timeout=timeout_ms) as info:
        trigger()
    download = info.value
    failure = download.failure()
    if failure:
        raise RuntimeError(f"download failed: {failure}")
    dest = dest_dir / target_name
    download.save_as(str(dest))
    os.chmod(dest, 0o600)
    return dest


def failure_screenshot(page: Page, dest: Path) -> Path | None:
    """Full-page screenshot with every text-entry field masked (usernames and
    passcodes alike, whatever their current type). Best effort."""
    try:
        page.screenshot(
            path=str(dest),
            full_page=True,
            mask=[page.locator(TEXT_ENTRY_SELECTOR)],
        )
        os.chmod(dest, 0o600)
        return dest
    except Exception:  # noqa: BLE001 (isolate failures)
        return None


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

_NOTIFY_SCRIPT = (
    "on run argv\n"
    "display notification (item 2 of argv) with title (item 1 of argv)\n"
    "end run"
)


def notify(title: str, message: str) -> None:
    """macOS notification via osascript. Text goes in argv, not the script, so it
    cannot inject AppleScript. Silently does nothing off macOS or on failure."""
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(
            ["osascript", "-e", _NOTIFY_SCRIPT, title, message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


class SiteStepError(RuntimeError):
    """A site step failed. Subclasses build their message from step names and
    constants only, so it is safe to print in the run summary."""


class LoginError(RuntimeError):
    """Login did not complete. Never contains a credential."""


class PasswordRejected(LoginError):
    """The bank rejected the password. Do not retry: repeated attempts lock accounts."""


class LoginTimeout(LoginError):
    """MFA (or the marker) did not complete within login_timeout_minutes."""


@dataclass
class LoginSpec:
    """Bank-specific hooks for `login()`. Each callable takes the page.

    overview_url: page that shows the logged-in marker when a session exists.
    is_logged_in / is_mfa / is_rejected: cheap, non-waiting checks (for example
        `lambda p: p.get_by_role("heading", name="Accounts").is_visible()`).
    username_field / password_field / submit: locators on the sign-in form.
    open_sign_in: optional action to reveal the form (click "Sign in").
    username_prefilled: optional check that the remembered username is shown, in
        which case only the password is filled.
    """

    overview_url: str
    is_logged_in: Callable[[Page], bool]
    username_field: Callable[[Page], Locator]
    password_field: Callable[[Page], Locator]
    submit: Callable[[Page], Locator]
    is_mfa: Callable[[Page], bool]
    is_rejected: Callable[[Page], bool]
    open_sign_in: Callable[[Page], None] | None = None
    username_prefilled: Callable[[Page], bool] | None = None


def _check(fn: Callable[[Page], bool] | None, page: Page) -> bool:
    if fn is None:
        return False
    try:
        return bool(fn(page))
    except Exception:  # noqa: BLE001 (isolate failures)
        return False


def login(
    page: Page,
    spec: LoginSpec,
    creds: CredentialSource,
    *,
    bank_label: str,
    timeout_minutes: float,
    poll_seconds: float = 2.0,
    log: Callable[[str], None] = print,
    notifier: Callable[[str, str], None] = notify,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """The plan's login flow.

    1. Load the overview page; return if the logged-in marker is present.
    2. Fill username and password once (secrets read right before fill) and submit.
    3. Poll: marker -> done; rejection -> PasswordRejected (no retry);
       MFA -> announce once, notify, keep polling.
    4. Deadline (timeout_minutes) -> LoginTimeout.
    """
    page.goto(spec.overview_url, wait_until="domcontentloaded")
    if _check(spec.is_logged_in, page):
        return

    if spec.open_sign_in is not None:
        spec.open_sign_in(page)
    if not _check(spec.username_prefilled, page):
        spec.username_field(page).fill(creds.username())
    spec.password_field(page).fill(creds.password())
    spec.submit(page).click()

    deadline = clock() + timeout_minutes * 60
    announced = False
    while True:
        if _check(spec.is_logged_in, page):
            return
        if _check(spec.is_rejected, page):
            raise PasswordRejected(
                f"{bank_label}: password rejected; not retrying (fix the credential, "
                "then run again)"
            )
        if not announced and _check(spec.is_mfa, page):
            announced = True
            log(f"{bank_label}: waiting for 2FA")
            notifier("Statement fetcher", f"{bank_label}: waiting for 2FA")
        if clock() >= deadline:
            raise LoginTimeout(
                f"{bank_label}: login not complete after {timeout_minutes:g} min"
            )
        sleep(poll_seconds)
