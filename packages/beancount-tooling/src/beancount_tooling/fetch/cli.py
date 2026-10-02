"""`just fetch` command line.

just fetch                       # all configured banks
just fetch bofa                  # one bank
just fetch --dry-run             # download to staging, report, touch nothing
just fetch --login               # open the profile for first-time login, no fetch
just fetch --keep-open           # leave the browser open at the end
just fetch --find-credentials bofa   # list Dashlane item titles and ids
just fetch --set-credentials bofa    # store a keychain credential (no-echo prompt)
"""

from __future__ import annotations

import argparse
import shutil
import sys

from beancount_tooling.fetch.config import ConfigError, FetchConfig, load_config
from beancount_tooling.fetch.credentials import (
    CredentialError,
    find_credentials,
    set_keychain_credentials,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fetch",
        description="Download bank statement CSVs into $LEDGER_DIR/statements/.",
    )
    parser.add_argument(
        "banks",
        nargs="*",
        metavar="BANK",
        help="bank keys from config/fetch.yaml (default: all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="download to staging and report; do not touch statements/",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--login",
        action="store_true",
        help="open the browser profile for manual login, without fetching",
    )
    mode.add_argument(
        "--find-credentials",
        metavar="BANK",
        help="list Dashlane item titles and ids for BANK's domain",
    )
    mode.add_argument(
        "--set-credentials",
        metavar="BANK",
        help="store BANK's login in the macOS keychain (source: keychain)",
    )
    parser.add_argument(
        "--keep-open",
        action="store_true",
        help="leave the browser open until its window is closed",
    )
    parser.add_argument(
        "--no-shortcut",
        action="store_true",
        help="always export, even when the site balance equals the ledger",
    )
    return parser


def _bank_domain(key: str, config: FetchConfig | None) -> str:
    if config and key in config.banks and config.banks[key].credentials.domain:
        return config.banks[key].credentials.domain
    from beancount_tooling.fetch.banks.base import get_fetcher

    return get_fetcher(key).domain


def cmd_find_credentials(key: str, config: FetchConfig | None) -> int:
    try:
        domain = _bank_domain(key, config)
    except (KeyError, TypeError, ImportError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    try:
        items = find_credentials(domain)
    except CredentialError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if not items:
        print(f"No Dashlane items match url={domain}.")
        return 1
    width = max(len(i["title"]) for i in items) + 2
    print(f"{'TITLE':<{width}}ID")
    for item in items:
        print(f"{item['title']:<{width}}{item['id']}")
    print(
        f"\nSet fetch.banks.{key}.credentials.id in config/fetch.yaml to the right id."
    )
    return 0


def cmd_set_credentials(key: str, config: FetchConfig) -> int:
    if key not in config.banks:
        print(f"error: bank {key!r} is not in config/fetch.yaml", file=sys.stderr)
        return 2
    creds = config.banks[key].credentials
    if creds.source == "dashlane":
        print(
            f"{key} reads from Dashlane. Edit the item in Dashlane, then run "
            f"`just fetch --find-credentials {key}` to confirm its id."
        )
        return 0
    if creds.source == "env":
        prefix = (creds.prefix or key).upper()
        print(
            f"{key} reads {prefix}_USERNAME and {prefix}_PASSWORD from the environment; "
            "set them in a gitignored env file."
        )
        return 0
    try:
        set_keychain_credentials(creds.service or "")
    except CredentialError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"Stored keychain items for service {creds.service}.")
    return 0


def _wait_for_close(context, prompt: str) -> None:
    """Block until every browser tab is closed (or Chrome quits).

    Waiting on Enter does not work when stdin is not a TTY (e.g. Claude Code's
    `!` prefix): input() hits EOF at once and the browser closes.
    """
    from playwright.sync_api import Error as PlaywrightError

    print(prompt, flush=True)
    while True:
        try:
            pages = [p for p in context.pages if not p.is_closed()]
        except PlaywrightError:
            return
        if not pages:
            return
        try:
            pages[0].wait_for_timeout(500)
        except PlaywrightError:
            continue  # that tab closed mid-wait; re-check the rest


def cmd_login(config: FetchConfig, keys: list[str]) -> int:
    from beancount_tooling.fetch.banks.base import get_fetcher
    from beancount_tooling.fetch.browser import first_page, open_context

    with open_context(config.profile_dir) as context:
        page = first_page(context)
        for i, key in enumerate(keys):
            domain = get_fetcher(key).domain
            tab = page if i == 0 else context.new_page()
            tab.goto(f"https://www.{domain}/")
        _wait_for_close(
            context,
            'Log in (tick "remember this device"), then close the browser window to finish.',
        )
    return 0


def cmd_fetch(
    config: FetchConfig,
    keys: list[str],
    *,
    dry_run: bool,
    keep_open: bool,
    shortcut: bool = True,
) -> int:
    from beancount_tooling.fetch.browser import (
        first_page,
        make_staging_dir,
        new_york_today,
        open_context,
    )
    from beancount_tooling.fetch.ledger import LedgerBalances
    from beancount_tooling.fetch.runner import format_summary, run_bank
    from beancount_tooling.paths import get_journal_file, get_statements_dir

    run_dir = make_staging_dir()
    statements_dir = get_statements_dir()
    ledger = LedgerBalances(get_journal_file(), new_york_today()) if shortcut else None
    outcomes = []
    with open_context(config.profile_dir) as context:
        page = first_page(context)
        for key in keys:
            outcomes += run_bank(
                page,
                config.banks[key],
                config,
                run_dir,
                statements_dir,
                dry_run=dry_run,
                ledger=ledger,
            )
        if keep_open:
            _wait_for_close(context, "Browser left open; close the window to finish.")

    print()
    if dry_run:
        print("[dry-run] statements/ untouched")
    print(format_summary(outcomes))
    failed = any(not o.ok for o in outcomes)
    if dry_run or failed:
        print(f"\nStaged files kept in {run_dir}")
    else:
        shutil.rmtree(run_dir, ignore_errors=True)
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.find_credentials:
        try:
            config = load_config()
        except ConfigError:
            config = None
        return cmd_find_credentials(args.find_credentials, config)

    try:
        config = load_config()
    except ConfigError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if args.set_credentials:
        return cmd_set_credentials(args.set_credentials, config)

    try:
        keys = [b.key for b in config.select(args.banks)]
    except ConfigError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if args.login:
        return cmd_login(config, keys)
    return cmd_fetch(
        config,
        keys,
        dry_run=args.dry_run,
        keep_open=args.keep_open,
        shortcut=not args.no_shortcut,
    )
