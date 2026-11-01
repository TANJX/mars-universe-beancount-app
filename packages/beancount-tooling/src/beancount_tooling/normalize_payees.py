"""Rewrite ledger payees to the canonical names in ``config/merchants.yaml``.

Usage (from the app repo, ``LEDGER_DIR`` set)::

    just normalize-payees [--dry-run] [--month YYYY-MM] [--file PATH ...]

The ledger is loaded with beancount to find each transaction's file and header
line, then the text is edited by line number. Only two edits ever happen:

- the header's payee and narration strings are replaced (date, flag, tags,
  links and anything after them stay byte-identical), and
- one ``raw: "<old payee>"`` line is inserted directly under the header,
  only when the entry has no ``raw:`` yet.

Postings, posting metadata (``ref:``, ``tid:``, ...), flags and entry order are
never touched. The narration rule: a non-empty narration is kept verbatim,
otherwise the map's detail fills it, otherwise it stays ``""``.

An entry is rewritten only when all of these hold:

- its file is not excluded (``scope.exclude_files``),
- it is not a forecast (no ``tid:`` on the entry or any posting),
- it has a payee,
- it is in scope: it posts under one of ``scope.accounts`` (default
  ``Expenses``), or it is a funded purchase into one of ``scope.gift_cards``,
- :func:`merchants.normalize` resolves the payee through an alias or a rule to
  a merchant, and that canonical payee differs from the current one.

Canonical names are aliases of themselves and an existing ``raw:`` is never
duplicated, so a second run is a no-op.
"""

from __future__ import annotations

import argparse
import difflib
import fnmatch
import json
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from beancount import loader
from beancount.core import data

from beancount_tooling import merchants
from beancount_tooling.merchants import MerchantConfig
from beancount_tooling.paths import get_journal_file, get_ledger_dir

DESC_KEY = "raw"
TID_KEY = "tid"

SKIP_EXCLUDED_FILE = "excluded-file"
SKIP_FORECAST = "forecast"
SKIP_NO_PAYEE = "no-payee"
SKIP_OUT_OF_SCOPE = "out-of-scope"
SKIP_NON_MERCHANT = "non-merchant"
SKIP_AMBIGUOUS = "ambiguous"
SKIP_UNMAPPED = "unmapped"
SKIP_ALREADY_CANONICAL = "already-canonical"
SKIP_HEADER_MISMATCH = "header-mismatch"

SKIP_ORDER = (
    SKIP_EXCLUDED_FILE,
    SKIP_FORECAST,
    SKIP_NO_PAYEE,
    SKIP_OUT_OF_SCOPE,
    SKIP_NON_MERCHANT,
    SKIP_AMBIGUOUS,
    SKIP_UNMAPPED,
    SKIP_ALREADY_CANONICAL,
    SKIP_HEADER_MISMATCH,
)

# date, flag, then exactly two strings (payee, narration), then the rest of the
# line (tags, links, comment, line ending) which is kept as is.
_STRING = r'"(?:[^"\\]|\\.)*"'
HEADER_RE = re.compile(
    r"^(?P<head>\d{4}-\d{2}-\d{2}[ \t]+\S+[ \t]+)"
    rf"(?P<payee>{_STRING})(?P<sep>[ \t]+)(?P<narration>{_STRING})"
    r"(?P<rest>(?![ \t]*\").*)$",
    re.DOTALL,
)


def quote(value: str) -> str:
    """A beancount string literal for ``value``."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def unquote(literal: str) -> str:
    return re.sub(r"\\(.)", r"\1", literal[1:-1], flags=re.DOTALL)


@dataclass(frozen=True)
class Change:
    path: Path
    lineno: int  # 1-based header line
    date: str
    old_payee: str
    new_payee: str
    old_narration: str
    new_narration: str
    add_desc: bool
    source: str
    scope: str


@dataclass
class Plan:
    changes: list[Change] = field(default_factory=list)
    skipped: Counter = field(default_factory=Counter)
    # In-scope payees left alone, for the report: reason -> payee -> count.
    unresolved: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    transactions: int = 0


# ---------------------------------------------------------------------------
# Selecting entries
# ---------------------------------------------------------------------------


def _root(account: str, roots: Iterable[str]) -> str | None:
    return next((r for r in roots if account == r or account.startswith(r + ":")), None)


def _under(account: str, roots: Iterable[str]) -> bool:
    return _root(account, roots) is not None


def entry_scope(entry: data.Transaction, config: MerchantConfig) -> str | None:
    """Why an entry is a merchant row (the matching root), or None."""
    for root in config.scope_accounts:
        if any(_under(p.account, (root,)) for p in entry.postings):
            return root
    gift_cards = config.gift_card_accounts
    if gift_cards:
        bought = any(
            _under(p.account, gift_cards) and p.units is not None and p.units.number > 0
            for p in entry.postings
        )
        funded = any(
            p.account.split(":", 1)[0] in ("Assets", "Liabilities")
            and not _under(p.account, gift_cards)
            and p.units is not None
            and p.units.number < 0
            for p in entry.postings
        )
        if bought and funded:
            return "gift-card"
    return None


def is_forecast(entry: data.Transaction) -> bool:
    if TID_KEY in entry.meta:
        return True
    return any(TID_KEY in (p.meta or {}) for p in entry.postings)


def is_excluded(path: Path, journal_dir: Path, globs: Sequence[str]) -> bool:
    if not globs:
        return False
    try:
        rel = path.resolve().relative_to(journal_dir.resolve()).as_posix()
    except ValueError:
        rel = path.as_posix()
    for pattern in globs:
        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(path.name, pattern):
            return True
        # "**/x.bean" should also match a top-level "x.bean".
        if pattern.startswith("**/") and fnmatch.fnmatch(rel, pattern[3:]):
            return True
    return False


def plan_changes(
    entries: Iterable[data.Directive],
    config: MerchantConfig,
    *,
    journal_dir: Path,
    month: str | None = None,
    files: Sequence[Path] | None = None,
) -> Plan:
    """Decide which transactions to rewrite. Reads no files."""
    wanted = {f.resolve() for f in files} if files else None
    plan = Plan()
    for entry in entries:
        if not isinstance(entry, data.Transaction):
            continue
        filename = entry.meta.get("filename")
        lineno = entry.meta.get("lineno")
        if not filename or not lineno or filename.startswith("<"):
            continue
        path = Path(filename)
        if wanted is not None and path.resolve() not in wanted:
            continue
        if month and entry.date.strftime("%Y-%m") != month:
            continue
        plan.transactions += 1

        def skip(reason: str, payee: str | None = None) -> None:
            plan.skipped[reason] += 1
            if payee is not None:
                plan.unresolved[reason][payee] += 1

        if is_excluded(path, journal_dir, config.exclude_files):
            skip(SKIP_EXCLUDED_FILE)
            continue
        if is_forecast(entry):
            skip(SKIP_FORECAST)
            continue
        if not entry.payee:
            skip(SKIP_NO_PAYEE)
            continue
        scope = entry_scope(entry, config)
        if scope is None:
            skip(SKIP_OUT_OF_SCOPE)
            continue

        narration = entry.narration or ""
        desc = entry.meta.get(DESC_KEY)
        extra = {"narration": narration}
        if isinstance(desc, str) and desc:
            extra["raw"] = desc
        m = merchants.normalize(entry.payee, extra=extra, config=config)
        if not m.is_merchant:
            skip(SKIP_NON_MERCHANT)
            continue
        if m.source not in (merchants.SOURCE_ALIAS, merchants.SOURCE_RULE):
            skip(SKIP_AMBIGUOUS if m.ambiguous else SKIP_UNMAPPED, entry.payee)
            continue
        if m.payee == entry.payee:
            skip(SKIP_ALREADY_CANONICAL)
            continue

        plan.changes.append(
            Change(
                path=path,
                lineno=int(lineno),
                date=entry.date.isoformat(),
                old_payee=entry.payee,
                new_payee=m.payee,
                old_narration=narration,
                new_narration=narration if narration.strip() else m.detail,
                add_desc=DESC_KEY not in entry.meta,
                source=m.source,
                scope=scope,
            )
        )
    return plan


# ---------------------------------------------------------------------------
# Editing text
# ---------------------------------------------------------------------------


def rewrite_header(line: str, change: Change) -> str | None:
    """The header line with new strings, or None if it is not the header the
    ledger reported (the file changed since loading)."""
    m = HEADER_RE.match(line)
    if m is None:
        return None
    if unquote(m["payee"]) != change.old_payee:
        return None
    if unquote(m["narration"]) != change.old_narration:
        return None
    return (
        m["head"]
        + quote(change.new_payee)
        + m["sep"]
        + quote(change.new_narration)
        + m["rest"]
    )


def _line_ending(line: str) -> str:
    stripped = line.rstrip("\r\n")
    return line[len(stripped) :] or "\n"


def _indent_after(lines: list[str], index: int) -> str:
    """The indent of the entry's first body line, defaulting to two spaces."""
    if index + 1 < len(lines):
        nxt = lines[index + 1]
        body = nxt.lstrip(" \t")
        if body.strip() and body != nxt:
            return nxt[: len(nxt) - len(body)]
    return "  "


def apply_to_text(text: str, changes: Sequence[Change]) -> tuple[str, list[Change]]:
    """Apply one file's changes. Returns the new text and the changes that
    could not be applied (header mismatch); those leave their lines as is."""
    lines = text.splitlines(keepends=True)
    by_line = {c.lineno: c for c in changes}
    failed: list[Change] = []
    out: list[str] = []
    for i, line in enumerate(lines):
        change = by_line.get(i + 1)
        if change is None:
            out.append(line)
            continue
        new = rewrite_header(line, change)
        if new is None:
            failed.append(change)
            out.append(line)
            continue
        out.append(new)
        if change.add_desc:
            out.append(
                f"{_indent_after(lines, i)}{DESC_KEY}: {quote(change.old_payee)}"
                f"{_line_ending(line)}"
            )
    return "".join(out), failed


def _read(path: Path) -> str:
    with path.open(encoding="utf-8", newline="") as f:
        return f.read()


def _write(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


def unified_diff(a: list[str], b: list[str], fromfile: str, tofile: str) -> list[str]:
    """difflib.unified_diff without the autojunk heuristic. Bean files repeat
    the same blank and posting lines so often that autojunk misaligns them and
    shows untouched postings as removed and re-added."""
    out = [f"--- {fromfile}\n", f"+++ {tofile}\n"]
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for group in matcher.get_grouped_opcodes(3):
        a1, a2, b1, b2 = group[0][1], group[-1][2], group[0][3], group[-1][4]
        out.append(f"@@ -{a1 + 1},{a2 - a1} +{b1 + 1},{b2 - b1} @@\n")
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                out.extend(" " + line for line in a[i1:i2])
                continue
            out.extend("-" + line for line in a[i1:i2])
            out.extend("+" + line for line in b[j1:j2])
    return out if len(out) > 2 else []


@dataclass
class Result:
    applied: list[Change] = field(default_factory=list)
    failed: list[Change] = field(default_factory=list)
    diff: str = ""


def execute(plan: Plan, *, root: Path, write: bool) -> Result:
    by_file: dict[Path, list[Change]] = defaultdict(list)
    for change in plan.changes:
        by_file[change.path].append(change)
    result = Result()
    diffs: list[str] = []
    for path in sorted(by_file):
        before = _read(path)
        after, failed = apply_to_text(before, by_file[path])
        result.failed.extend(failed)
        result.applied.extend(c for c in by_file[path] if c not in failed)
        if after == before:
            continue
        try:
            rel = path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = path.as_posix()
        diffs.append(
            "".join(
                unified_diff(
                    before.splitlines(keepends=True),
                    after.splitlines(keepends=True),
                    f"a/{rel}",
                    f"b/{rel}",
                )
            )
        )
        if write:
            _write(path, after)
    result.diff = "".join(diffs)
    return result


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def summarize(plan: Plan, result: Result) -> dict:
    applied = result.applied
    per_canonical = Counter(c.new_payee for c in applied)
    per_scope = Counter(c.scope for c in applied)
    skipped = dict(plan.skipped)
    if result.failed:
        skipped[SKIP_HEADER_MISMATCH] = len(result.failed)
    return {
        "transactions": plan.transactions,
        "headers_changed": len(applied),
        "desc_added": sum(1 for c in applied if c.add_desc),
        "narration_filled": sum(
            1 for c in applied if c.new_narration != c.old_narration
        ),
        "files_changed": len({c.path for c in applied}),
        "per_scope": dict(per_scope.most_common()),
        "per_canonical": dict(per_canonical.most_common()),
        "skipped": {k: skipped[k] for k in SKIP_ORDER if skipped.get(k)},
        "unresolved": {
            reason: dict(counter.most_common())
            for reason, counter in plan.unresolved.items()
        },
        "failed": [f"{c.path}:{c.lineno} {c.old_payee!r}" for c in result.failed],
    }


def print_summary(summary: dict, *, dry_run: bool, out=None) -> None:
    out = sys.stderr if out is None else out
    verb = "would change" if dry_run else "changed"
    print(
        f"normalize-payees: {summary['transactions']} transactions scanned, "
        f"{verb} {summary['headers_changed']} headers in "
        f"{summary['files_changed']} files, "
        f"{summary['desc_added']} raw: lines, "
        f"{summary['narration_filled']} narrations filled",
        file=out,
    )
    if summary["per_scope"]:
        print(f"  by scope: {summary['per_scope']}", file=out)
    if summary["per_canonical"]:
        print("  by canonical payee:", file=out)
        for payee, n in summary["per_canonical"].items():
            print(f"    {n:5d}  {payee}", file=out)
    if summary["skipped"]:
        print("  skipped:", file=out)
        for reason, n in summary["skipped"].items():
            print(f"    {n:5d}  {reason}", file=out)
    for reason in (SKIP_AMBIGUOUS, SKIP_UNMAPPED):
        payees = summary["unresolved"].get(reason)
        if payees:
            print(f"  {reason} payees in scope (left unchanged):", file=out)
            for payee, n in payees.items():
                print(f"    {n:5d}  {payee}", file=out)
    for line in summary["failed"]:
        print(f"  header mismatch, not changed: {line}", file=out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _month(value: str) -> str:
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
        raise argparse.ArgumentTypeError(f"expected YYYY-MM, got {value!r}")
    return value


def _resolve_file(value: str, ledger_dir: Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute() or path.exists():
        candidate = path
    else:
        candidate = ledger_dir / path
    if not candidate.is_file():
        raise SystemExit(f"normalize-payees: no such file: {value}")
    return candidate.resolve()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="normalize-payees",
        description="Rewrite merchant payees to the canonical names in "
        "$LEDGER_DIR/config/merchants.yaml.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the unified diff to stdout and write nothing",
    )
    parser.add_argument(
        "--month", type=_month, help="only entries dated in this month (YYYY-MM)"
    )
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        metavar="PATH",
        help="only entries in this .bean file (repeatable; relative paths may be "
        "relative to $LEDGER_DIR)",
    )
    parser.add_argument(
        "--journal", type=Path, help="ledger entry point (default: $LEDGER_DIR)"
    )
    parser.add_argument(
        "--config", type=Path, help="merchants.yaml (default: $LEDGER_DIR/config)"
    )
    parser.add_argument(
        "--summary-json", type=Path, metavar="PATH", help="also write the summary"
    )
    args = parser.parse_args(argv)

    ledger_dir = get_ledger_dir()
    journal = (args.journal or get_journal_file()).resolve()
    config = (
        merchants.load_config(args.config) if args.config else merchants.get_config()
    )
    if config.empty:
        print(
            f"normalize-payees: no merchant map at {config.path}; nothing to do",
            file=sys.stderr,
        )
        return 0
    files = [_resolve_file(f, ledger_dir) for f in args.file]

    entries, errors, _ = loader.load_file(str(journal))
    if errors:
        print(
            f"normalize-payees: warning: the ledger has {len(errors)} error(s); "
            "run bean-check",
            file=sys.stderr,
        )

    plan = plan_changes(
        entries,
        config,
        journal_dir=journal.parent,
        month=args.month,
        files=files or None,
    )
    result = execute(plan, root=journal.parent.parent, write=not args.dry_run)
    if args.dry_run and result.diff:
        sys.stdout.write(result.diff)
    summary = summarize(plan, result)
    print_summary(summary, dry_run=args.dry_run)
    if args.summary_json:
        args.summary_json.write_text(
            json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    return 1 if result.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
