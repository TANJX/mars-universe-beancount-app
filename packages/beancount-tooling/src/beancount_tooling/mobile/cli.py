"""``just mobile-snapshot``: write the mobile snapshot for the ledger at ``$LEDGER_DIR``.

Usage (from the app repo, ``LEDGER_DIR`` set)::

    just mobile-snapshot [--asof YYYY-MM-DD] [--out PATH] [--config PATH]

Reads ``journal/journal.beancount``, ``config/mobile.yaml`` (personal inputs,
optional), ``journal/plan/cc-cards.json`` (card due days, optional),
``journal/plan/cc-expected.json`` (statements that have not closed, optional),
``journal/plan/plans.jsonl`` (card payment overrides: which bank pays, optional),
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
import sys
from collections.abc import Sequence
from pathlib import Path

from beancount import loader

from beancount_tooling.mobile.assemble import (  # noqa: F401 (re-exported)
    CC_CARDS_RELATIVE,
    CC_EXPECTED_RELATIVE,
    OUT_RELATIVE,
    PLANS_RELATIVE,
    STATEMENTS_RELATIVE,
    _load_card_plans,
    _load_cc_cards,
    _load_statements,
    assemble_snapshot,
    ledger_meta,
)
from beancount_tooling.mobile.config import (
    CONFIG_FILENAME,
    MobileConfigError,
    load_config,
)
from beancount_tooling.paths import get_config_dir, get_journal_file, get_ledger_dir

LOGO_TOKEN_VAR = "NEXT_PUBLIC_LOGO_DEV_TOKEN"


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
    # The same directory the Fava endpoint reads (``<ledger>/config``):
    # ui.yaml and dashboard/findings.json come from here; --config overrides
    # only mobile.yaml.
    config_dir = get_config_dir()
    config_path = args.config or config_dir / CONFIG_FILENAME

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

    snapshot = assemble_snapshot(
        ledger_dir,
        entries,
        asof,
        cfg=cfg,
        config_dir=config_dir,
        logo_token=_logo_token(args.web_env),
        out_path=out_path,
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
        f"{'' if snapshot['logos'] else ' (no logo token: no image URLs)'}, "
        f"derived: {len(snapshot['derived']['needsYou'])} needs-you, "
        f"{len(snapshot['derived']['cardsDue'])} cards due, "
        f"{len(snapshot['derived']['stale'])} stale, "
        f"{len(snapshot['derived']['findings'])} findings"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
