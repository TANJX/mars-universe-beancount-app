"""Pluggable credential sources for bank logins.

Rules (see the statement-fetcher plan, Credentials):
- A secret is read only when `username()` / `password()` is called, right before
  the bank's field is filled. Nothing is cached on the source object.
- Secrets are never logged, printed, written to disk, or put into an exception
  message. Errors carry the source name, the item id or service, and the exit
  status only.
- Dashlane is read with `-o console` (stdout, captured). Never the clipboard.
- A non-zero exit, an empty value, or a multi-line value (several matches) raises
  CredentialError. Nothing falls through to a different entry.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from abc import ABC, abstractmethod

from beancount_tooling.fetch.config import CredentialConfig

DCLI_INSTALL_HINT = (
    "install with `brew install dashlane/tap/dashlane-cli`, then run `dcli sync` once"
)


class CredentialError(RuntimeError):
    """A credential could not be read unambiguously. Never contains a secret."""


class CredentialSource(ABC):
    """Reads a bank username and password at call time."""

    label: str = "credentials"

    @abstractmethod
    def username(self) -> str: ...

    @abstractmethod
    def password(self) -> str: ...


def _single_value(raw: str, what: str) -> str:
    value = raw.rstrip("\r\n")
    if not value:
        raise CredentialError(f"{what}: empty value")
    if "\n" in value or "\r" in value:
        raise CredentialError(
            f"{what}: several values returned (ambiguous match); refusing to guess"
        )
    return value


class DashlaneSource(CredentialSource):
    """Dashlane CLI: `dcli p id=<id> -f login|password -o console`.

    stdin and stderr are inherited so dcli can prompt for the master password on
    the terminal; only stdout (the requested field) is captured.
    """

    def __init__(self, item_id: str, bank: str = ""):
        if not item_id or item_id == "TODO":
            raise CredentialError(
                f"{bank or 'bank'}: no Dashlane item id configured; run "
                f"`just fetch --find-credentials {bank or '<bank>'}` and set "
                "credentials.id in config/fetch.yaml"
            )
        self.item_id = item_id
        self.label = f"dashlane item {item_id}"

    def _read(self, field: str) -> str:
        what = f"{self.label} ({field})"
        if shutil.which("dcli") is None:
            raise CredentialError(f"{what}: dcli not found; {DCLI_INSTALL_HINT}")
        try:
            proc = subprocess.run(
                ["dcli", "p", f"id={self.item_id}", "-f", field, "-o", "console"],
                stdout=subprocess.PIPE,
                text=True,
                check=False,
            )
        except OSError as e:
            raise CredentialError(
                f"{what}: could not run dcli ({e.strerror})"
            ) from None
        if proc.returncode != 0:
            raise CredentialError(
                f"{what}: dcli exited with status {proc.returncode} "
                "(vault locked, no match, or several matches)"
            )
        return _single_value(proc.stdout or "", what)

    def username(self) -> str:
        return self._read("login")

    def password(self) -> str:
        return self._read("password")


# Fixed, non-identifying account labels for the two keychain items. The real
# username is stored as the password of `<service>.username`, so it is never
# passed on argv (`security add-generic-password -a <username>` would show it in
# `ps` for as long as the prompt waits).
KEYCHAIN_USERNAME_SUFFIX = ".username"
KEYCHAIN_USERNAME_ACCOUNT = "bank-fetch-username"
KEYCHAIN_PASSWORD_ACCOUNT = "bank-fetch-password"


def keychain_username_service(service: str) -> str:
    return service + KEYCHAIN_USERNAME_SUFFIX


class KeychainSource(CredentialSource):
    """macOS login keychain generic passwords, keyed by service name.

    The password is the `<service>` item and the username is the
    `<service>.username` item; both are read with `-w`.
    """

    def __init__(self, service: str):
        if not service or service == "TODO":
            raise CredentialError("keychain: no service configured")
        self.service = service
        self.label = f"keychain service {service}"

    def _read(self, service: str, what: str) -> str:
        try:
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-w"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                check=False,
            )
        except OSError as e:
            raise CredentialError(
                f"{what}: could not run security ({e.strerror})"
            ) from None
        if proc.returncode != 0:
            raise CredentialError(
                f"{what}: security exited with status {proc.returncode} (item not found?)"
            )
        return _single_value(proc.stdout or "", what)

    def username(self) -> str:
        return self._read(
            keychain_username_service(self.service), f"{self.label} (username)"
        )

    def password(self) -> str:
        return self._read(self.service, f"{self.label} (password)")


class EnvSource(CredentialSource):
    """`<PREFIX>_USERNAME` / `<PREFIX>_PASSWORD` environment variables."""

    def __init__(self, prefix: str):
        self.prefix = prefix.upper()
        self.label = f"env {self.prefix}_USERNAME/{self.prefix}_PASSWORD"

    def _read(self, suffix: str) -> str:
        name = f"{self.prefix}_{suffix}"
        value = os.environ.get(name)
        if not value:
            raise CredentialError(f"env: {name} is not set")
        return value

    def username(self) -> str:
        return self._read("USERNAME")

    def password(self) -> str:
        return self._read("PASSWORD")


def make_source(cfg: CredentialConfig, bank: str) -> CredentialSource:
    if cfg.source == "dashlane":
        return DashlaneSource(cfg.id or "", bank=bank)
    if cfg.source == "keychain":
        return KeychainSource(cfg.service or "")
    if cfg.source == "env":
        return EnvSource(cfg.prefix or bank)
    raise CredentialError(f"{bank}: unknown credential source {cfg.source!r}")


# Only these keys of a dcli JSON item are ever printed.
_SAFE_ITEM_KEYS = ("id", "title")


def _safe_items(items: object) -> list[dict[str, str]]:
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return []
    safe = []
    for item in items:
        if not isinstance(item, dict):
            continue
        safe.append({k: str(item.get(k, "")) for k in _SAFE_ITEM_KEYS})
    return safe


def find_credentials(domain: str) -> list[dict[str, str]]:
    """List Dashlane items for a domain as [{id, title}], password fields dropped.

    Runs `dcli p url=<domain> -o json`. The raw JSON (which includes passwords)
    is parsed in memory and only whitelisted keys are returned.
    """
    what = f"dashlane url={domain}"
    if shutil.which("dcli") is None:
        raise CredentialError(f"{what}: dcli not found; {DCLI_INSTALL_HINT}")
    try:
        proc = subprocess.run(
            ["dcli", "p", f"url={domain}", "-o", "json"],
            stdout=subprocess.PIPE,
            text=True,
            check=False,
        )
    except OSError as e:
        raise CredentialError(f"{what}: could not run dcli ({e.strerror})") from None
    if proc.returncode != 0:
        raise CredentialError(
            f"{what}: dcli exited with status {proc.returncode} (vault locked or no match)"
        )
    try:
        items = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        # Do not echo the output: it may contain secrets.
        raise CredentialError(
            f"{what}: dcli returned output that is not JSON"
        ) from None
    return _safe_items(items)


def _add_keychain_item(service: str, account: str) -> None:
    try:
        proc = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                service,
                "-a",
                account,
                "-w",
            ],
            check=False,
        )
    except OSError as e:
        raise CredentialError(
            f"keychain: could not run security ({e.strerror})"
        ) from None
    if proc.returncode != 0:
        raise CredentialError(
            f"keychain service {service}: security exited with status {proc.returncode}"
        )


def set_keychain_credentials(service: str) -> None:
    """Store a bank login as two keychain generic passwords.

    Tradeoff: `security add-generic-password -w <secret>` would put the secret on
    argv (visible in `ps`), and `security -i` (commands on stdin) needs the secret
    quoted by its own tokenizer, which is fragile for arbitrary values. So nothing
    is collected with getpass here. Instead `-w` is passed as the last argument
    with no value, which makes `security` itself prompt on the terminal with echo
    off (documented in `man security`). The username gets the same treatment as
    the password: it is stored as the password of `<service>.username`, and the
    `-a` account attribute of both items is a fixed label. Neither value passes
    through this process, argv, or a pipe.
    """
    if not service or service == "TODO":
        raise CredentialError("keychain: no service configured")
    print(
        "security will prompt twice for the USERNAME, then twice for the "
        "PASSWORD (input is not echoed)."
    )
    _add_keychain_item(keychain_username_service(service), KEYCHAIN_USERNAME_ACCOUNT)
    _add_keychain_item(service, KEYCHAIN_PASSWORD_ACCOUNT)
