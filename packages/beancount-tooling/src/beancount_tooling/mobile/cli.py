"""``just mobile-snapshot``: write the mobile snapshot for the ledger at ``$LEDGER_DIR``.

Usage (from the app repo, ``LEDGER_DIR`` set)::

    just mobile-snapshot [--asof YYYY-MM-DD] [--out PATH] [--config PATH]

Reads ``journal/journal.beancount``, ``config/mobile.yaml`` (personal inputs,
optional), ``journal/plan/cc-cards.json`` (card due days, optional) and
``statements/billing/`` (closed card statements, optional), and writes
``mobile/snapshot.json`` inside the ledger directory. ``--asof`` builds the
snapshot as of another day; the default is today.

The file is rewritten on every run. Nothing else in the ledger is touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
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
from beancount_tooling.mobile.snapshot import build_snapshot
from beancount_tooling.paths import get_config_dir, get_journal_file, get_ledger_dir

OUT_RELATIVE = Path("mobile") / "snapshot.json"
CC_CARDS_RELATIVE = Path("journal") / "plan" / "cc-cards.json"
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
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=1, ensure_ascii=False)
        f.write("\n")

    groups = snapshot["accounts"]["groups"]
    print(
        f"wrote {out_path} (as of {asof.isoformat()}): "
        f"{sum(len(g['accounts']) for g in groups)} accounts, "
        f"{len(snapshot['activity']['transactions'])} transactions, "
        f"{len(snapshot['plan']['events'])} plan events, "
        f"{len(snapshot['goals'])} goals"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
