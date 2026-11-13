"""``just mobile-snapshot``: write the mobile snapshot for the ledger at ``$LEDGER_DIR``.

Usage (from the app repo, ``LEDGER_DIR`` set)::

    just mobile-snapshot [--asof YYYY-MM-DD] [--out PATH] [--config PATH]

Reads ``journal/journal.beancount``, ``config/mobile.yaml`` (personal inputs,
optional), ``journal/plan/cc-cards.json`` (card due days, optional),
``journal/plan/cc-expected.json`` (statements that have not closed, optional),
``statements/billing/`` (closed card statements, optional),
``statements/leave/`` and ``journal/leave/taken.jsonl`` (PTO and sick
balances, optional, used only with a ``leave`` section in the config) and
``config/ui.yaml`` (merchant logos, optional), and writes
``mobile/snapshot.json`` inside the ledger directory. ``--asof`` builds the
snapshot as of another day; the default is today.

Merchant logos: rows carry a ``logoDomain``; the image URL needs the logo
service's publishable token, the one the web viewer uses. It is read from the
``NEXT_PUBLIC_LOGO_DEV_TOKEN`` environment variable, else from the dotenv
file given with ``--web-env`` (the just recipe passes the web app's
``.env.local``). The token is written only into the snapshot and is never
printed. Without it the snapshot has domains but no URL template.

The file is rewritten on every run. Nothing else in the ledger is touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from beancount import loader

from beancount_tooling import billing
from beancount_tooling.mobile.config import (
    CONFIG_FILENAME,
    MobileConfigError,
    load_config,
)
from beancount_tooling.mobile.leave import read_leave
from beancount_tooling.mobile.logos import UI_CONFIG_FILENAME, load_resolver
from beancount_tooling.mobile.snapshot import build_snapshot
from beancount_tooling.paths import get_config_dir, get_journal_file, get_ledger_dir

OUT_RELATIVE = Path("mobile") / "snapshot.json"
CC_CARDS_RELATIVE = Path("journal") / "plan" / "cc-cards.json"
CC_EXPECTED_RELATIVE = Path("journal") / "plan" / "cc-expected.json"
LOGO_TOKEN_VAR = "NEXT_PUBLIC_LOGO_DEV_TOKEN"
STATEMENTS_RELATIVE = Path("statements")


def _git(ledger_dir: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", "-C", str(ledger_dir), *args],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def ledger_meta(ledger_dir: Path, out_path: Path) -> dict:
    """Commit the snapshot was built from, and whether the tree had other
    uncommitted changes (the snapshot file itself does not count)."""
    commit = _git(ledger_dir, "rev-parse", "--short", "HEAD")
    dirty = None
    if commit is not None:
        status = _git(ledger_dir, "status", "--porcelain", "--untracked-files=all")
        if status is not None:
            try:
                own = out_path.resolve().relative_to(ledger_dir.resolve()).as_posix()
            except ValueError:
                own = None
            dirty = any(line[3:].strip('"') != own for line in status.splitlines())
    return {"ledgerCommit": commit, "ledgerDirty": dirty}


def _load_cc_cards(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"warning: ignoring {path}: {e}", file=sys.stderr)
        return {}
    return doc if isinstance(doc, dict) else {}


def _logo_token(env_file: Path | None) -> str | None:
    """The logo service's publishable token: the environment, else the dotenv
    file. Never printed or logged."""
    token = os.environ.get(LOGO_TOKEN_VAR, "").strip()
    if token:
        return token
    if env_file is None:
        return None
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    for line in lines:
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and key.strip() == LOGO_TOKEN_VAR:
            return value.strip().strip("\"'") or None
    return None


def _load_statements(ledger_dir: Path) -> dict[str, list[billing.Statement]]:
    """Closed card statements by account; empty when there are none."""
    return billing.read_all(ledger_dir / STATEMENTS_RELATIVE)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mobile-snapshot", description="Write the mobile snapshot JSON for the ledger."
    )
    parser.add_argument(
        "--asof",
        type=dt.date.fromisoformat,
        default=None,
        metavar="YYYY-MM-DD",
        help="build the snapshot as of this day (default: today)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output file (default: $LEDGER_DIR/mobile/snapshot.json)",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help=f"config file (default: $LEDGER_DIR/config/{CONFIG_FILENAME})",
    )
    parser.add_argument(
        "--web-env",
        type=Path,
        default=None,
        metavar="FILE",
        help=f"dotenv file to read {LOGO_TOKEN_VAR} from when it is not in the "
        "environment (merchant logo URLs)",
    )
    args = parser.parse_args(argv)

    ledger_dir = get_ledger_dir()
    journal = get_journal_file()
    if not journal.is_file():
        print(f"error: no journal at {journal} (is LEDGER_DIR set?)", file=sys.stderr)
        return 2
    asof = args.asof or dt.date.today()
    out_path = args.out or ledger_dir / OUT_RELATIVE
    config_path = args.config or get_config_dir() / CONFIG_FILENAME

    try:
        cfg = load_config(config_path)
    except MobileConfigError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if not config_path.is_file():
        print(
            f"note: no {config_path}; goals, key dates and event labels are empty",
            file=sys.stderr,
        )

    entries, errors, _ = loader.load_file(str(journal))
    if errors:
        print(
            f"warning: the ledger loaded with {len(errors)} error(s)", file=sys.stderr
        )

    meta = {
        "generatedAt": dt.datetime.now(dt.UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        **ledger_meta(ledger_dir, out_path),
    }
    snapshot = build_snapshot(
        entries,
        cfg,
        asof,
        cc_cards=_load_cc_cards(ledger_dir / CC_CARDS_RELATIVE),
        statements=_load_statements(ledger_dir),
        meta=meta,
        expected=_load_cc_cards(ledger_dir / CC_EXPECTED_RELATIVE),
        logos=load_resolver(get_config_dir() / UI_CONFIG_FILENAME),
        logo_token=_logo_token(args.web_env),
        leave=read_leave(ledger_dir),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=1, ensure_ascii=False)
        f.write("\n")

    groups = snapshot["accounts"]["groups"]
    rows = snapshot["activity"]["transactions"]
    with_logo = sum(1 for r in rows if r.get("logoDomain"))
    print(
        f"wrote {out_path} (as of {asof.isoformat()}): "
        f"{sum(len(g['accounts']) for g in groups)} accounts, "
        f"{len(snapshot['activity']['transactions'])} transactions, "
        f"{len(snapshot['plan']['events'])} plan events, "
        f"{len(snapshot['goals'])} goals, "
        f"{with_logo} of {len(rows)} transactions with a logo domain, "
        f"{'leave as of ' + snapshot['leave']['asOf'] if 'leave' in snapshot else 'no leave'}"
        f"{'' if snapshot['logos'] else ' (no logo token: no image URLs)'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
