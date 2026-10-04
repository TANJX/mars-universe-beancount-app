"""Run the fetchers, gate every staged file through the guards, install survivors.

Failure isolation: a credential, login or site error skips that bank's
accounts; a guard failure skips that one file. Nothing aborts the run.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import traceback
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from beancount_tooling.fetch import guards
from beancount_tooling.fetch.banks.base import (
    Fetcher,
    NoActivity,
    StagedFile,
    get_fetcher,
)
from beancount_tooling.fetch.config import AccountConfig, BankConfig, FetchConfig
from beancount_tooling.fetch.credentials import CredentialError, make_source
from beancount_tooling.fetch.ledger import (
    LedgerBalances,
    expected_ledger_balance,
    ledger_account,
)

MAX_LISTED_ROWS = 10


@dataclass
class Outcome:
    account: AccountConfig
    file_name: str
    detail: str
    ok: bool = True
    notes: list[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        return account_label(self.account)


def account_label(account: AccountConfig) -> str:
    return (
        account.name if account.type == "credit" else f"{account.name} {account.type}"
    )


def _range_text(r: tuple[Any, Any] | None) -> str:
    if not r:
        return ""
    return f"   (range {r[0]:%m/%d} to {r[1]:%m/%d})"


def _rows_note(prefix: str, rows: list[guards.Row]) -> list[str]:
    notes = [prefix]
    notes += [f"  {r.raw}" for r in rows[:MAX_LISTED_ROWS]]
    if len(rows) > MAX_LISTED_ROWS:
        notes.append(f"  ... and {len(rows) - MAX_LISTED_ROWS} more")
    return notes


def install(staged: Path, target: Path) -> None:
    """Copy into place atomically (temp file in the target dir, then rename)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".fetch-", dir=target.parent)
    os.close(fd)
    try:
        shutil.copyfile(staged, tmp)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _archive_tables(
    target_dir: Path, rolling_name: str, extra: Sequence[Path] = ()
) -> list[guards.Table]:
    """Every other statement file for the account (the importer reads them all),
    plus archives staged in this run that passed their own guards."""
    paths = [
        p
        for p in sorted(target_dir.glob("*.csv"))
        if p.name != rolling_name and p.is_file()
    ]
    paths += list(extra)
    return [guards.parse_table(guards.read_text(p)) for p in paths]


def evaluate_staged(
    staged: StagedFile,
    account: AccountConfig,
    target_dir: Path,
    *,
    payment_account: str,
    dry_run: bool = False,
    parse: Callable[..., guards.ParseResult] = guards.parse_with_importer,
    staged_archives: Sequence[Path] = (),
) -> Outcome:
    """Run guards 1 to 4 on one staged file and install it if they all pass.

    staged_archives: archive files staged for the same account in this run that
    passed their guards; guard 3 treats rows found in them as archived.
    """
    name = staged.target_name
    target = target_dir / name

    def skipped(reason: str, notes: list[str] | None = None) -> Outcome:
        return Outcome(account, name, f"SKIPPED: {reason}", ok=False, notes=notes or [])

    if staged.path is None:
        return skipped(f"download failed ({staged.error or 'unknown error'})")

    text = guards.read_text(staged.path)
    would = "would be " if dry_run else ""

    # Guard 1
    if account.bank == "bofa" and guards.is_bofa_placeholder(text, account.kind):
        return Outcome(account, name, "no new rows (kept existing)")

    # Amex returns a 0-byte file (no header) for a card with no activity in the
    # period (confirmed 2026-10-02). Nothing to install, rolling or archive.
    if not text.strip():
        if staged.role == "archive":
            return Outcome(account, name, "empty statement (nothing archived)")
        if target.exists():
            return Outcome(account, name, "no new rows (kept existing)")
        return Outcome(account, name, "no rows yet (nothing created)")

    new_table = guards.parse_table(text)
    # A rolling export with the header and no rows is the bank saying "nothing
    # this period" (normal right after a statement closes, or on a quiet card).
    if (
        staged.role == "rolling"
        and new_table.date_index is not None
        and not new_table.rows
    ):
        if target.exists():
            return Outcome(account, name, "no new rows (kept existing)")
        return Outcome(account, name, "no rows yet (nothing created)")

    if staged.role == "archive" and target.exists():
        return Outcome(account, name, "archive exists (kept existing)")

    # Guard 2
    parsed = parse(staged.path, account, payment_account)
    if not parsed.ok:
        return skipped(f"parse: {parsed.message}")

    if staged.role == "archive":
        if not dry_run:
            install(staged.path, target)
        return Outcome(
            account, name, f"{would}archived (new, {len(new_table.rows)} rows)"
        )

    if not target.exists():
        if not dry_run:
            install(staged.path, target)
        return Outcome(
            account,
            name,
            f"{would}created, {len(new_table.rows)} rows{_range_text(_table_range(new_table))}",
        )

    old_text = guards.read_text(target)
    if old_text == text:
        return Outcome(account, name, "no new rows (unchanged)")
    old_table = guards.parse_table(old_text)

    # Guard 3. Other statement files are read only when some row is unmatched.
    key_column = guards.key_column_for(account)
    overlap = guards.check_overlap(old_table, new_table, key_column=key_column)
    if not overlap.ok:
        overlap = guards.check_overlap(
            old_table,
            new_table,
            key_column=key_column,
            archived=_archive_tables(target_dir, name, staged_archives),
        )
    if overlap.status == guards.OVERLAP_TIMEZONE:
        return skipped(
            f"wrong timezone (rows shifted {overlap.shift_days:+d} day(s))",
            _rows_note(
                "Rows whose date moved (re-export in New York time):", overlap.missing
            ),
        )
    if overlap.status == guards.OVERLAP_MISSING:
        return skipped(
            f"{len(overlap.missing)} existing row(s) missing or changed",
            _rows_note(
                "Rows in the existing file absent from the new one:", overlap.missing
            ),
        )

    # Guard 4
    sanity = guards.check_latest_date(old_table, new_table)
    if not sanity.ok:
        return skipped(f"sanity: {sanity.message}")

    if not dry_run:
        install(staged.path, target)
    detail = f"{would}+{overlap.added} rows"
    if overlap.aged_out:
        detail += f", {overlap.aged_out} aged out"
    detail += _range_text(overlap.new_range)
    return Outcome(account, name, detail)


def _table_range(table: guards.Table):
    if not table.rows:
        return None
    return (table.first_date, table.last_date)


def _bank_failure(bank: BankConfig, reason: str) -> list[Outcome]:
    return [
        Outcome(a, a.rolling, f"SKIPPED: {reason}", ok=False) for a in bank.accounts
    ]


def _balance_shortcut(
    fetcher: Fetcher,
    page: Any,
    account: AccountConfig,
    ledger: LedgerBalances,
    log: Callable[[str], None],
) -> Outcome | None:
    """An Outcome when the site balance equals the ledger (export skipped);
    None to fetch as usual. Never fails the account: any problem reading
    either balance just falls back to the export."""
    name = ledger_account(account)
    if name is None:
        return None
    try:
        site = fetcher.read_balance(page, account)
    except Exception as e:  # noqa: BLE001 (the export is the fallback)
        log(f"  balance check skipped for {account.path}: {type(e).__name__}")
        return None
    if site is None:
        return None
    expected = expected_ledger_balance(account, site)
    try:
        actual = ledger.balance(name)
    except Exception as e:  # noqa: BLE001 (the export is the fallback)
        log(f"  ledger balance unavailable: {type(e).__name__}")
        return None
    if actual == expected:
        return Outcome(
            account,
            account.rolling,
            f"balance matches ledger ({site:,.2f}): export skipped",
        )
    log(f"  balance differs: site {site:,.2f}, ledger {actual:,.2f} for {name}")
    return None


def run_bank(
    page: Any,
    bank: BankConfig,
    config: FetchConfig,
    run_dir: Path,
    statements_dir: Path,
    *,
    dry_run: bool = False,
    fetcher: Fetcher | None = None,
    log: Callable[[str], None] = print,
    ledger: LedgerBalances | None = None,
) -> list[Outcome]:
    from beancount_tooling.fetch.browser import (
        LoginTimeout,
        PasswordRejected,
        SiteStepError,
        account_staging_dir,
        failure_screenshot,
    )

    try:
        fetcher = fetcher or get_fetcher(bank.key)(config.login_timeout_minutes)
    except Exception as e:  # noqa: BLE001 (isolate failures)
        return _bank_failure(bank, f"no fetcher ({e})")
    label = fetcher.display_name or bank.key

    try:
        creds = make_source(bank.credentials, bank.key)
    except CredentialError as e:
        return _bank_failure(bank, f"credentials: {e}")

    log(f"{label}: logging in")
    try:
        fetcher.ensure_logged_in(page, creds)
    except PasswordRejected:
        return _bank_failure(bank, "password rejected (not retried)")
    except LoginTimeout:
        outcomes = _bank_failure(bank, "login timeout")
        shot = failure_screenshot(page, run_dir / f"{bank.key}-login-timeout.png")
        if shot and outcomes:
            outcomes[0].notes = [f"screenshot: {shot}"]
        return outcomes
    except CredentialError as e:
        return _bank_failure(bank, f"credentials: {e}")
    except NotImplementedError:
        return _bank_failure(bank, f"{label} fetcher not implemented")
    except Exception as e:  # noqa: BLE001 (isolate failures)
        shot = failure_screenshot(page, run_dir / f"{bank.key}-login-failure.png")
        outcomes = _bank_failure(bank, f"login error: {type(e).__name__}")
        # Only step errors carry a message built to be printable (step name and
        # constant to tune). Other exceptions may echo page or call details, so
        # only their type is shown.
        notes = [str(e)] if isinstance(e, SiteStepError) else []
        if type(e).__name__ == "TimeoutError":
            # Playwright's first line names the action ("Page.goto: Timeout
            # 30000ms exceeded."); call-log lines and typed values are dropped.
            notes = [str(e).splitlines()[0][:200]]
        if shot:
            notes.append(f"screenshot: {shot}")
        if notes and outcomes:
            outcomes[0].notes = notes
        return outcomes

    outcomes: list[Outcome] = []
    for account in bank.accounts:
        staging = account_staging_dir(run_dir, account.path)
        if ledger is not None:
            matched = _balance_shortcut(fetcher, page, account, ledger, log)
            if matched is not None:
                outcomes.append(matched)
                continue
        log(f"{label}: fetching {account_label(account)}")
        try:
            staged_files = fetcher.fetch(page, account, staging)
        except NoActivity:
            outcomes.append(
                Outcome(
                    account, account.rolling, "no activity this period (kept existing)"
                )
            )
            continue
        except NotImplementedError:
            outcomes.append(
                Outcome(account, account.rolling, "SKIPPED: not implemented", ok=False)
            )
            continue
        except Exception as e:  # noqa: BLE001 (isolate failures)
            shot = failure_screenshot(page, staging / "failure.png")
            notes = [traceback.format_exc().rstrip()]
            if shot:
                notes.append(f"screenshot: {shot}")
            outcomes.append(
                Outcome(
                    account,
                    account.rolling,
                    f"SKIPPED: download failed ({type(e).__name__})",
                    ok=False,
                    notes=notes,
                )
            )
            continue
        if not staged_files:
            outcomes.append(
                Outcome(
                    account, account.rolling, "SKIPPED: nothing downloaded", ok=False
                )
            )
        if any(s.error for s in staged_files):
            shot = failure_screenshot(page, staging / "archive-failure.png")
        else:
            shot = None
        # Archives first, so the rolling file's guard 3 can see rows that moved
        # into an archive staged in this same run. Summary keeps fetch order.
        order = sorted(
            range(len(staged_files)),
            key=lambda i: staged_files[i].role != "archive",
        )
        results: dict[int, Outcome] = {}
        good_archives: list[Path] = []
        for i in order:
            staged = staged_files[i]
            try:
                outcome = evaluate_staged(
                    staged,
                    account,
                    statements_dir / account.path,
                    payment_account=config.payment_account,
                    dry_run=dry_run,
                    staged_archives=good_archives,
                )
            except Exception as e:  # noqa: BLE001 (isolate failures)
                outcome = Outcome(
                    account,
                    staged.target_name,
                    f"SKIPPED: guard error ({type(e).__name__}: {e})",
                    ok=False,
                )
            if staged.error and shot:
                outcome.notes.append(f"screenshot: {shot}")
            if staged.role == "archive" and outcome.ok and staged.path is not None:
                good_archives.append(staged.path)
            results[i] = outcome
        outcomes += [results[i] for i in range(len(staged_files))]
    return outcomes


def format_summary(outcomes: list[Outcome]) -> str:
    if not outcomes:
        return "Nothing fetched."
    label_w = max(16, max(len(o.label) for o in outcomes) + 2)
    file_w = max(30, max(len(o.file_name) for o in outcomes) + 2)
    lines = []
    for o in outcomes:
        lines.append(f"{o.label:<{label_w}}{o.file_name:<{file_w}}{o.detail}".rstrip())
        lines += [f"    {n}" for line in o.notes for n in line.splitlines()]
    return "\n".join(lines)
