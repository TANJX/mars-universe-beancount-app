"""The Fetcher contract and the bank registry.

A bank module (banks/<bank>.py) defines one Fetcher subclass and exposes it as
the module attribute `FETCHER_CLASS`. REGISTRY maps the bank key used in
config/fetch.yaml (`fetch.banks.<key>`) to that module's import path. Modules
are imported lazily so one broken bank module cannot break the others.
"""

from __future__ import annotations

import importlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from beancount_tooling.fetch.config import AccountConfig
    from beancount_tooling.fetch.credentials import CredentialSource

REGISTRY: dict[str, str] = {
    "bofa": "beancount_tooling.fetch.banks.bofa",
    "amex": "beancount_tooling.fetch.banks.amex",
}


@dataclass(frozen=True)
class StagedFile:
    """One downloaded file waiting for the guards.

    path: the file inside the account's staging dir.
    target_name: the file name it gets under statements/<account.path>/.
    role: "rolling" replaces the existing file after the guards pass;
        "archive" is written only if no file of that name exists.
    error: set (and path None) when this file could not be downloaded. A
        fetcher returns the rolling file it already has plus a failed archive
        this way, so an archive step failure never discards a good rolling file.
        The text must not contain a credential.
    """

    path: Path | None
    target_name: str
    role: Literal["rolling", "archive"] = "rolling"
    error: str = ""

    @classmethod
    def failed(
        cls, target_name: str, role: Literal["rolling", "archive"], error: BaseException
    ) -> StagedFile:
        return cls(None, target_name, role, f"{type(error).__name__}: {error}")


class Fetcher(ABC):
    """Drives one bank's website. Instantiated once per run, per bank.

    Class attributes:
        key: registry key (matches fetch.banks.<key>).
        display_name: label for log lines and the summary ("BofA").
        domain: credential lookup domain for --find-credentials ("example.com").
    """

    key: str = ""
    display_name: str = ""
    domain: str = ""

    def __init__(self, login_timeout_minutes: float = 5):
        self.login_timeout_minutes = login_timeout_minutes

    @abstractmethod
    def ensure_logged_in(self, page: Page, creds: CredentialSource) -> None:
        """Leave `page` on a logged-in session, usually via browser.login().

        Must raise browser.PasswordRejected on a rejected password (never retry)
        and browser.LoginTimeout when MFA does not complete in time.
        """

    @abstractmethod
    def fetch(
        self, page: Page, account: AccountConfig, staging_dir: Path
    ) -> list[StagedFile]:
        """Download `account`'s exports into `staging_dir` (already created, and
        laid out as <run>/<type>/<name>/ so importer identify() works).

        Return the rolling file (target_name == account.rolling) and, when the
        latest closed statement is missing from the archive, that archive file
        (target_name from account.archive_name(year, month)). If the archive
        step fails after the rolling file is staged, return
        StagedFile.failed(...) for the archive instead of raising. Use
        browser.capture_download() for each file. Never write outside
        staging_dir.

        Raise NoActivity when the site shows no transactions for the period and
        offers no export (the runner keeps the existing file).
        """

    def read_balance(self, page: Page, account: AccountConfig) -> Decimal | None:
        """The balance the site shows for `account`, as displayed: positive
        for money held (checking) or owed (credit). None when this bank does
        not support the balance shortcut. May navigate; fetch() must not rely
        on the page it leaves."""
        return None


class NoActivity(Exception):
    """The site lists no transactions for the period and offers no export."""


def get_fetcher(key: str) -> type[Fetcher]:
    if key not in REGISTRY:
        raise KeyError(
            f"no fetcher registered for bank {key!r}; known: {', '.join(REGISTRY)}"
        )
    module = importlib.import_module(REGISTRY[key])
    cls = getattr(module, "FETCHER_CLASS", None)
    if not (isinstance(cls, type) and issubclass(cls, Fetcher)):
        raise TypeError(
            f"{REGISTRY[key]} does not define FETCHER_CLASS as a Fetcher subclass"
        )
    return cls
