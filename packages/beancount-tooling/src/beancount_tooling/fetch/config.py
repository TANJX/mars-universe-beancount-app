"""Load and validate <LEDGER_DIR>/config/fetch.yaml.

All account identifiers (last digits, file names, credential item ids) live in
the ledger's config, never in this package. Schema:

    fetch:
      profile_dir: ~/.local/share/<something>/chrome-profile
      login_timeout_minutes: 5
      banks:
        <bank>:                    # registry key, e.g. bofa, amex
          credentials:
            source: dashlane       # dashlane | keychain | env
            id: "<vault item id>"  # dashlane only
            service: "<name>"      # keychain only
            prefix: "<PREFIX>"     # env only, defaults to the bank key upper-cased
            domain: "<domain>"     # optional, overrides the fetcher's domain for --find-credentials
          accounts:
            - path: <type>/<name>  # must match an accounts[].path in config/extract.yaml
              kind: checking       # optional, defaults to <type>
              last4: "1234"        # or last5; "TODO" is accepted as not-yet-known
              rolling: <file name> # overwritten each run after the guards pass
              archive: "{YYYY}-{MM}.csv"  # optional closed-statement name template
              account_number: "123"  # brokerages that address accounts by number
              history_start: 2026-01-01  # optional: oldest activity a cumulative fetcher reads
"""

from __future__ import annotations

import calendar
import re
import string
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from beancount_tooling.paths import get_config_dir

PLACEHOLDER = "TODO"
CREDENTIAL_SOURCES = ("dashlane", "keychain", "env")
ACCOUNT_KINDS = ("checking", "credit", "saving", "investment")
ARCHIVE_FIELDS = ("MonthName", "YYYY", "MM")
DEFAULT_LOGIN_TIMEOUT_MINUTES = 5


class ConfigError(ValueError):
    """fetch.yaml is missing, malformed, or inconsistent with extract.yaml."""


@dataclass(frozen=True)
class CredentialConfig:
    source: str
    id: str | None = None
    service: str | None = None
    prefix: str | None = None
    domain: str | None = None

    @property
    def is_placeholder(self) -> bool:
        if self.source == "dashlane":
            return self.id in (None, "", PLACEHOLDER)
        if self.source == "keychain":
            return self.service in (None, "", PLACEHOLDER)
        return False


@dataclass(frozen=True)
class AccountConfig:
    bank: str
    path: str
    kind: str
    rolling: str
    archive: str | None = None
    last4: str | None = None
    last5: str | None = None
    account_number: str | None = None
    history_start: date | None = None
    # The matching accounts[] entry from config/extract.yaml (importer, bank, options).
    extract: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @property
    def type(self) -> str:
        return self.path.split("/")[0]

    @property
    def name(self) -> str:
        return self.path.split("/")[1]

    @property
    def last_digits(self) -> str | None:
        return self.last4 or self.last5

    def archive_name(self, year: int, month: int) -> str | None:
        if not self.archive:
            return None
        return render_archive_name(self.archive, year, month)


@dataclass(frozen=True)
class BankConfig:
    key: str
    credentials: CredentialConfig
    accounts: tuple[AccountConfig, ...]


@dataclass(frozen=True)
class FetchConfig:
    profile_dir: Path
    login_timeout_minutes: float
    banks: dict[str, BankConfig]
    payment_account: str = "Assets:FIXME"

    def select(self, bank_filter: list[str] | None) -> list[BankConfig]:
        if not bank_filter:
            return list(self.banks.values())
        unknown = [b for b in bank_filter if b not in self.banks]
        if unknown:
            raise ConfigError(
                f"unknown bank(s) {', '.join(unknown)}; configured: {', '.join(self.banks)}"
            )
        return [self.banks[b] for b in bank_filter]


def render_archive_name(template: str, year: int, month: int) -> str:
    return template.format(
        MonthName=calendar.month_name[month],
        YYYY=f"{year:04d}",
        MM=f"{month:02d}",
    )


def _validate_archive_template(template: str, where: str) -> None:
    for _, name, _, _ in string.Formatter().parse(template):
        if name is not None and name not in ARCHIVE_FIELDS:
            raise ConfigError(
                f"{where}: unknown archive placeholder {{{name}}}; "
                f"allowed: {', '.join('{' + f + '}' for f in ARCHIVE_FIELDS)}"
            )


def _validate_digits(value: Any, length: int, where: str) -> str:
    text = str(value)
    if text == PLACEHOLDER:
        return text
    if not re.fullmatch(rf"\d{{{length}}}", text):
        raise ConfigError(
            f'{where}: must be a quoted {length}-digit string or "{PLACEHOLDER}"'
        )
    return text


def _validate_file_name(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{where}: must be a non-empty file name")
    if "/" in value or value in (".", ".."):
        raise ConfigError(f"{where}: must be a bare file name, not a path")
    return value


def _parse_credentials(raw: Any, bank: str) -> CredentialConfig:
    where = f"fetch.banks.{bank}.credentials"
    if raw is None:
        raise ConfigError(f"{where}: missing")
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: must be a mapping")
    source = raw.get("source", "dashlane")
    if source not in CREDENTIAL_SOURCES:
        raise ConfigError(
            f"{where}.source: {source!r} is not one of {', '.join(CREDENTIAL_SOURCES)}"
        )
    unknown = set(raw) - {"source", "id", "service", "prefix", "domain"}
    if unknown:
        raise ConfigError(f"{where}: unknown key(s) {', '.join(sorted(unknown))}")
    if source == "dashlane" and not raw.get("id"):
        raise ConfigError(f"{where}.id: required for source dashlane")
    if source == "keychain" and not raw.get("service"):
        raise ConfigError(f"{where}.service: required for source keychain")
    return CredentialConfig(
        source=source,
        id=str(raw["id"]) if raw.get("id") is not None else None,
        service=raw.get("service"),
        prefix=raw.get("prefix"),
        domain=raw.get("domain"),
    )


def _parse_account(
    raw: Any, bank: str, index: int, extract_accounts: dict[str, dict]
) -> AccountConfig:
    where = f"fetch.banks.{bank}.accounts[{index}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: must be a mapping")
    unknown = set(raw) - {
        "path",
        "kind",
        "last4",
        "last5",
        "rolling",
        "archive",
        "account_number",
        "history_start",
    }
    if unknown:
        raise ConfigError(f"{where}: unknown key(s) {', '.join(sorted(unknown))}")

    path = raw.get("path")
    if not isinstance(path, str) or not re.fullmatch(r"[^/]+/[^/]+", path):
        raise ConfigError(f"{where}.path: must look like <type>/<name>")
    if path not in extract_accounts:
        raise ConfigError(
            f"{where}.path: {path!r} is not an accounts[].path in config/extract.yaml"
        )
    account_type = path.split("/")[0]
    if account_type not in ACCOUNT_KINDS:
        raise ConfigError(
            f"{where}.path: type {account_type!r} is not one of {', '.join(ACCOUNT_KINDS)}"
        )
    kind = raw.get("kind", account_type)
    if kind != account_type:
        raise ConfigError(
            f"{where}.kind: {kind!r} does not match the path type {account_type!r}"
        )

    last4 = raw.get("last4")
    last5 = raw.get("last5")
    if last4 is not None and last5 is not None:
        raise ConfigError(f"{where}: set last4 or last5, not both")
    if last4 is not None:
        last4 = _validate_digits(last4, 4, f"{where}.last4")
    if last5 is not None:
        last5 = _validate_digits(last5, 5, f"{where}.last5")

    account_number = raw.get("account_number")
    if account_number is not None:
        account_number = str(account_number)
        if not re.fullmatch(r"\d+", account_number):
            raise ConfigError(f"{where}.account_number: must be a quoted digit string")
    history_start = raw.get("history_start")
    if history_start is not None and not isinstance(history_start, date):
        raise ConfigError(f"{where}.history_start: must be a date (YYYY-MM-DD)")

    rolling = _validate_file_name(raw.get("rolling"), f"{where}.rolling")
    archive = raw.get("archive")
    if archive is not None:
        archive = _validate_file_name(archive, f"{where}.archive")
        _validate_archive_template(archive, f"{where}.archive")
        if render_archive_name(archive, 2000, 1) == render_archive_name(
            archive, 2000, 2
        ):
            raise ConfigError(f"{where}.archive: template must include the month")

    return AccountConfig(
        bank=bank,
        path=path,
        kind=kind,
        rolling=rolling,
        archive=archive,
        last4=last4,
        last5=last5,
        account_number=account_number,
        history_start=history_start,
        extract=extract_accounts[path],
    )


def parse_config(raw: Any, extract_config: Any) -> FetchConfig:
    """Validate parsed fetch.yaml and extract.yaml documents."""
    if not isinstance(raw, dict) or not isinstance(raw.get("fetch"), dict):
        raise ConfigError("fetch.yaml: top-level `fetch:` mapping is missing")
    fetch = raw["fetch"]

    if not isinstance(extract_config, dict) or not isinstance(
        extract_config.get("accounts"), list
    ):
        raise ConfigError("extract.yaml: `accounts:` list is missing")
    extract_accounts = {
        a["path"]: a
        for a in extract_config["accounts"]
        if isinstance(a, dict) and "path" in a
    }
    payment_account = (extract_config.get("categorization") or {}).get(
        "payment_account", "Assets:FIXME"
    )

    profile_dir = fetch.get("profile_dir")
    if not isinstance(profile_dir, str) or not profile_dir:
        raise ConfigError("fetch.profile_dir: required")
    profile_path = Path(profile_dir).expanduser()
    if not profile_path.is_absolute():
        raise ConfigError(
            "fetch.profile_dir: must be an absolute path (or start with ~)"
        )

    timeout = fetch.get("login_timeout_minutes", DEFAULT_LOGIN_TIMEOUT_MINUTES)
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or timeout <= 0
    ):
        raise ConfigError("fetch.login_timeout_minutes: must be a positive number")

    banks_raw = fetch.get("banks")
    if not isinstance(banks_raw, dict) or not banks_raw:
        raise ConfigError("fetch.banks: must be a non-empty mapping")

    banks: dict[str, BankConfig] = {}
    seen_targets: dict[tuple[str, str], str] = {}
    for key, bank_raw in banks_raw.items():
        where = f"fetch.banks.{key}"
        if not isinstance(bank_raw, dict):
            raise ConfigError(f"{where}: must be a mapping")
        credentials = _parse_credentials(bank_raw.get("credentials"), key)
        accounts_raw = bank_raw.get("accounts")
        if not isinstance(accounts_raw, list) or not accounts_raw:
            raise ConfigError(f"{where}.accounts: must be a non-empty list")
        accounts = []
        for i, a in enumerate(accounts_raw):
            account = _parse_account(a, key, i, extract_accounts)
            target = (account.path, account.rolling)
            if target in seen_targets:
                raise ConfigError(
                    f"{where}.accounts[{i}]: {account.path}/{account.rolling} is "
                    f"already written by {seen_targets[target]}"
                )
            seen_targets[target] = f"{where}.accounts[{i}]"
            accounts.append(account)
        banks[key] = BankConfig(
            key=key, credentials=credentials, accounts=tuple(accounts)
        )

    return FetchConfig(
        profile_dir=profile_path,
        login_timeout_minutes=timeout,
        banks=banks,
        payment_account=payment_account,
    )


def _read_yaml(path: Path) -> Any:
    if not path.is_file():
        raise ConfigError(
            f"{path.name} not found at {path}. Set LEDGER_DIR to a ledger working copy "
            f"with config/{path.name}."
        )
    with path.open("r") as f:
        try:
            return yaml.safe_load(f)
        except yaml.YAMLError as e:
            raise ConfigError(f"{path}: invalid YAML ({e})") from None


def load_config(config_dir: Path | None = None) -> FetchConfig:
    config_dir = config_dir or get_config_dir()
    return parse_config(
        _read_yaml(config_dir / "fetch.yaml"), _read_yaml(config_dir / "extract.yaml")
    )
