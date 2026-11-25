"""Assemble a full mobile snapshot from a ledger directory and loaded entries.

Shared by ``just mobile-snapshot`` (``cli.py``) and the Fava dashboard
endpoint (``ledger_data_api.dashboard``), so both build the same document:
``build_snapshot`` over the ledger's side files (card settings, statements,
plans, logos, leave) plus the ``derived`` block (``derived.py``).
"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

from beancount_tooling import billing
from beancount_tooling.mobile.config import CONFIG_FILENAME, MobileConfig, load_config
from beancount_tooling.mobile.context import CONTEXT_RELATIVE
from beancount_tooling.mobile.derived import (
    FETCH_STATUS_RELATIVE,
    FINDINGS_RELATIVE,
    build_derived,
)
from beancount_tooling.mobile.leave import read_leave
from beancount_tooling.mobile.logos import UI_CONFIG_FILENAME, load_resolver
from beancount_tooling.mobile.snapshot import build_snapshot

OUT_RELATIVE = Path("mobile") / "snapshot.json"
CC_CARDS_RELATIVE = Path("journal") / "plan" / "cc-cards.json"
CC_EXPECTED_RELATIVE = Path("journal") / "plan" / "cc-expected.json"
PLANS_RELATIVE = Path("journal") / "plan" / "plans.jsonl"
STATEMENTS_RELATIVE = Path("statements")
CONFIG_RELATIVE = Path("config")

#: Paths under the ledger's working tree that never make it "dirty": the
#: dashboard files the daily agent rewrites, notes, agent instructions
#: (``.claude``, ``CLAUDE.md``), and the snapshot output. Git pathspecs,
#: relative to the ledger directory.
DIRTY_IGNORED = ("config/dashboard", "docs", "mobile", ".claude", "CLAUDE.md")

#: Files under the config directory that feed the snapshot.
CONFIG_INPUTS = (CONFIG_FILENAME, UI_CONFIG_FILENAME, FINDINGS_RELATIVE, CONTEXT_RELATIVE)

#: Files and directories besides the journal and the config directory that
#: feed the snapshot. A cache of the snapshot is stale when any of their
#: mtimes moves.
INPUTS_RELATIVE = (
    CC_CARDS_RELATIVE,
    CC_EXPECTED_RELATIVE,
    PLANS_RELATIVE,
    STATEMENTS_RELATIVE / "billing",
    STATEMENTS_RELATIVE / "leave",
    Path("journal") / "leave",
    FETCH_STATUS_RELATIVE,
)


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


def config_dir_of(ledger_dir: Path) -> Path:
    """The ledger's config directory: ``<ledger>/config``, the same place
    ``paths.get_config_dir()`` names when ``LEDGER_DIR`` is that ledger."""
    return Path(ledger_dir) / CONFIG_RELATIVE


def ledger_meta(ledger_dir: Path, out_path: Path) -> dict:
    """Commit the snapshot was built from, and whether the ledger had other
    uncommitted changes. The snapshot file itself and the ``DIRTY_IGNORED``
    paths do not count. Both are None when git is unavailable."""
    commit = _git(ledger_dir, "rev-parse", "--short", "HEAD")
    dirty = None
    if commit is not None:
        status = _git(
            ledger_dir,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            ".",
            *(f":(exclude){p}" for p in DIRTY_IGNORED),
        )
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


def _load_card_plans(path: Path) -> list[dict]:
    """The planner's live card-payment plans (those tagged with a card).

    ``plans.jsonl`` is an event log: the last ``save`` of an id wins and a
    ``delete`` removes it."""
    if not path.is_file():
        return []
    live: dict[str, dict] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as e:
        print(f"warning: ignoring {path}: {e}", file=sys.stderr)
        return []
    for line in lines:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict) or not isinstance(ev.get("id"), str):
            continue
        if ev.get("op") == "delete":
            live.pop(ev["id"], None)
        elif ev.get("op") == "save":
            live[ev["id"]] = ev
    return [p for p in live.values() if p.get("ccCardRef")]


def _load_statements(ledger_dir: Path) -> dict[str, list[billing.Statement]]:
    """Closed card statements by account; empty when there are none."""
    return billing.read_all(ledger_dir / STATEMENTS_RELATIVE)


def _now_iso() -> str:
    return (
        dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )


def _git_dir(ledger_dir: Path) -> Path | None:
    """The ``.git`` directory of the repository holding ``ledger_dir`` (found
    without running git; a worktree's ``gitdir:`` file is followed)."""
    for d in (Path(ledger_dir).resolve(), *Path(ledger_dir).resolve().parents):
        dot = d / ".git"
        if dot.is_dir():
            return dot
        if dot.is_file():
            try:
                line = dot.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeDecodeError):
                return None
            if line.startswith("gitdir:"):
                gd = Path(line[len("gitdir:"):].strip())
                return gd if gd.is_absolute() else (d / gd).resolve()
            return None
    return None


def _git_paths(ledger_dir: Path) -> list[Path]:
    """Git files whose mtimes move on a commit, checkout or stage: HEAD, the
    index and the branch HEAD points at (plus packed-refs)."""
    gd = _git_dir(ledger_dir)
    if gd is None:
        return []
    out = [gd / "HEAD", gd / "index", gd / "packed-refs"]
    try:
        head = (gd / "HEAD").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        head = ""
    if head.startswith("ref:"):
        ref = head[len("ref:"):].strip()
        # A worktree keeps branch refs in the common dir.
        common = gd
        try:
            c = (gd / "commondir").read_text(encoding="utf-8").strip()
            common = (gd / c).resolve()
        except (OSError, UnicodeDecodeError):
            pass
        out.append(common / ref)
    return out


def inputs_signature(ledger_dir: Path, config_dir: Path | None = None) -> tuple:
    """mtimes of the snapshot's side inputs (directories by their newest file)
    and of the git files that set ``ledgerCommit`` / ``ledgerDirty``, for cache
    keys. Missing paths count as 0. ``config_dir`` defaults to
    ``<ledger>/config``."""
    ledger_dir = Path(ledger_dir)
    config_dir = Path(config_dir) if config_dir is not None else config_dir_of(ledger_dir)
    paths = [
        *(config_dir / rel for rel in CONFIG_INPUTS),
        *(ledger_dir / rel for rel in INPUTS_RELATIVE),
        *_git_paths(ledger_dir),
    ]
    sig = []
    for p in paths:
        try:
            m = p.stat().st_mtime_ns
            if p.is_dir():
                for child in p.rglob("*"):
                    m = max(m, child.stat().st_mtime_ns)
        except OSError:
            m = 0
        sig.append(m)
    return tuple(sig)


def assemble_snapshot(
    ledger_dir: Path,
    entries: list,
    asof: dt.date,
    *,
    cfg: MobileConfig | None = None,
    config_dir: Path | None = None,
    logo_token: str | None = None,
    out_path: Path | None = None,
    generated_at: str | None = None,
) -> dict:
    """The full snapshot (schema 2 plus ``derived``) for loaded ``entries``.

    ``config_dir`` is where ``mobile.yaml``, ``ui.yaml``,
    ``dashboard/findings.json`` and ``dashboard/context.json`` live (default ``<ledger>/config``; the CLI
    passes ``paths.get_config_dir()``). ``cfg`` defaults to ``mobile.yaml``
    there (``MobileConfigError`` when it is invalid; empty when absent).
    ``out_path`` is where the snapshot will be written, so the ledger's dirty
    flag ignores that file (default ``mobile/snapshot.json``).
    """
    ledger_dir = Path(ledger_dir)
    config_dir = Path(config_dir) if config_dir is not None else config_dir_of(ledger_dir)
    if cfg is None:
        cfg = load_config(config_dir / CONFIG_FILENAME)
    meta = {
        "generatedAt": generated_at or _now_iso(),
        **ledger_meta(ledger_dir, out_path or ledger_dir / OUT_RELATIVE),
    }
    snapshot = build_snapshot(
        entries,
        cfg,
        asof,
        cc_cards=_load_cc_cards(ledger_dir / CC_CARDS_RELATIVE),
        statements=_load_statements(ledger_dir),
        meta=meta,
        expected=_load_cc_cards(ledger_dir / CC_EXPECTED_RELATIVE),
        card_plans=_load_card_plans(ledger_dir / PLANS_RELATIVE),
        logos=load_resolver(config_dir / UI_CONFIG_FILENAME),
        logo_token=logo_token,
        leave=read_leave(ledger_dir),
    )
    snapshot["derived"] = build_derived(snapshot, ledger_dir, config_dir=config_dir)
    return snapshot
