"""Agent-written dashboard: the files under ``$LEDGER_DIR/config/dashboard/``
and the on-request data document the spec binds to.

Files (all optional; a missing or unreadable one reads as null / empty):

- ``spec.json``: the current issue, written by the daily agent.
- ``spec.lkg.json``: the last spec that passed the check.
- ``issues/YYYY-MM-DD.json``: one archived spec per issue date.
- ``feedback.jsonl``: append-only ``{"ts", "issue", "element", "text"}``.

The data document is the mobile snapshot plus its ``derived`` block, built
from Fava's loaded entries with the same assembly as ``just mobile-snapshot``
and cached until the ledger reloads, a side input changes, or the day turns.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path

DASHBOARD_RELATIVE = Path("config") / "dashboard"
SPEC_FILE = "spec.json"
LKG_FILE = "spec.lkg.json"
ISSUES_DIR = "issues"
FEEDBACK_FILE = "feedback.jsonl"

ISSUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ELEMENT_RE = re.compile(r"^[A-Za-z0-9_\-:.]{1,128}$")
MAX_FEEDBACK_TEXT = 4000
MAX_DATA_ERROR = 300

log = logging.getLogger(__name__)


class DashboardError(Exception):
    """A rejected request (HTTP 400); nothing was written."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def ledger_dir_of(ledger_file_path: str) -> Path:
    """The ledger root: the journal file lives in ``<root>/journal/``."""
    return Path(ledger_file_path).parent.parent


def config_dir_of(ledger_dir: Path) -> Path:
    """``<ledger>/config``: the directory ``just mobile-snapshot`` reads
    through ``paths.get_config_dir()`` when ``LEDGER_DIR`` is this ledger, so
    the endpoint and the CLI gate against the same config."""
    from beancount_tooling.mobile.assemble import config_dir_of as _of

    return _of(ledger_dir)


def dashboard_dir(ledger_dir: Path) -> Path:
    return Path(ledger_dir) / DASHBOARD_RELATIVE


def parse_issue_date(raw) -> str:
    """A ``YYYY-MM-DD`` string that is a real date, else ``DashboardError``."""
    if not isinstance(raw, str) or not ISSUE_RE.match(raw):
        raise DashboardError("date must be YYYY-MM-DD")
    try:
        dt.date.fromisoformat(raw)
    except ValueError as ex:
        raise DashboardError(f"invalid date {raw!r}") from ex
    return raw


def _read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _parse_object(data: bytes | None) -> dict | None:
    if data is None:
        return None
    try:
        doc = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def read_json_object(path: Path) -> dict | None:
    """A JSON object file, or None when it is missing, unreadable or not an
    object."""
    return _parse_object(_read_bytes(path))


def read_spec(ledger_dir: Path) -> dict | None:
    return read_json_object(dashboard_dir(ledger_dir) / SPEC_FILE)


def read_lkg(ledger_dir: Path) -> dict | None:
    return read_json_object(dashboard_dir(ledger_dir) / LKG_FILE)


def read_issue(ledger_dir: Path, date: str) -> dict | None:
    date = parse_issue_date(date)
    return read_json_object(dashboard_dir(ledger_dir) / ISSUES_DIR / f"{date}.json")


def list_issues(ledger_dir: Path) -> list[str]:
    """Archived issue dates, newest first."""
    d = dashboard_dir(ledger_dir) / ISSUES_DIR
    try:
        names = [p.stem for p in d.iterdir() if p.is_file() and p.suffix == ".json"]
    except OSError:
        return []
    out = []
    for n in names:
        try:
            out.append(parse_issue_date(n))
        except DashboardError:
            continue
    return sorted(out, reverse=True)


def validate_feedback(body) -> dict:
    """``{"issue", "element", "text"}`` checked and trimmed, else
    ``DashboardError``. ``issue`` is an issue date; ``element`` is a spec
    element key."""
    if not isinstance(body, dict):
        raise DashboardError("body must be a JSON object")
    issue = parse_issue_date(body.get("issue"))
    element = body.get("element")
    if not isinstance(element, str) or not ELEMENT_RE.match(element):
        raise DashboardError("element must be a spec element key")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise DashboardError("text must be a non-empty string")
    text = text.strip()
    if len(text) > MAX_FEEDBACK_TEXT:
        raise DashboardError(f"text is longer than {MAX_FEEDBACK_TEXT} characters")
    return {"issue": issue, "element": element, "text": text}


_feedback_lock = threading.Lock()


def append_feedback(ledger_dir: Path, body, now: dt.datetime | None = None) -> dict:
    """Validate and append one line to ``feedback.jsonl``; returns the record."""
    fields = validate_feedback(body)
    ts = (now or dt.datetime.now(dt.UTC)).replace(microsecond=0)
    record = {"ts": ts.isoformat().replace("+00:00", "Z"), **fields}
    path = dashboard_dir(ledger_dir) / FEEDBACK_FILE
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _feedback_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(line)
    return record


# ---------- data document ----------


@dataclass
class _Cached:
    entries: list
    key: tuple
    data: dict
    data_hash: str


_cache: dict[str, _Cached] = {}
_cache_lock = threading.Lock()


def _hash(*parts: bytes) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(len(p).to_bytes(8, "big"))
        h.update(p)
    return h.hexdigest()


def build_data(ledger_dir: Path, entries: list, asof: dt.date) -> dict:
    """The snapshot plus ``derived`` for loaded entries (uncached)."""
    from beancount_tooling.mobile.assemble import assemble_snapshot

    ledger_dir = Path(ledger_dir)
    return assemble_snapshot(
        ledger_dir, entries, asof, config_dir=config_dir_of(ledger_dir)
    )


def get_data(
    ledger_dir: Path, entries: list, asof: dt.date, load_mark=None
) -> tuple[dict, str]:
    """The data document and its content hash, cached per ledger.

    The cache holds while Fava has not reloaded (the same ``entries`` list
    object and ``load_mark``, e.g. the ledger's mtime), ``asof`` is the same
    day and no side input (mobile.yaml, ui.yaml, findings.json, plan files,
    statements, fetch-status) or git state (HEAD, index, branch ref) changed.
    Assembly errors propagate."""
    from beancount_tooling.mobile.assemble import inputs_signature

    ledger_dir = Path(ledger_dir)
    slot = str(ledger_dir.resolve())
    key = (
        load_mark,
        asof.isoformat(),
        inputs_signature(ledger_dir, config_dir_of(ledger_dir)),
    )
    with _cache_lock:
        hit = _cache.get(slot)
        if hit is not None and hit.entries is entries and hit.key == key:
            return hit.data, hit.data_hash
    data = build_data(ledger_dir, entries, asof)
    data_hash = _hash(json.dumps(data, sort_keys=True, default=str).encode())
    with _cache_lock:
        _cache[slot] = _Cached(entries, key, data, data_hash)
    return data, data_hash


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _short(msg: str) -> str:
    line = " ".join(msg.split())
    return line if len(line) <= MAX_DATA_ERROR else line[: MAX_DATA_ERROR - 1] + "…"


def dashboard_payload(
    ledger_dir: Path, entries: list, asof: dt.date, load_mark=None
) -> dict:
    """``GET dashboard``: ``{spec, lkg, data, version, issues}``.

    ``version`` changes whenever spec.json, spec.lkg.json, the issue archive
    or the data change. When the data cannot be built (an invalid mobile
    config, a bad side file, a crash in assembly), ``data`` is null and
    ``dataError`` says why in one short line; the traceback goes to the server
    log and the request still succeeds, so the page can show the spec tier's
    fallback with the real cause."""
    from beancount_tooling.mobile.config import MobileConfigError

    ddir = dashboard_dir(ledger_dir)
    spec_bytes = _read_bytes(ddir / SPEC_FILE)
    lkg_bytes = _read_bytes(ddir / LKG_FILE)
    issues = list_issues(ledger_dir)
    data_error = None
    try:
        data, data_hash = get_data(ledger_dir, entries, asof, load_mark)
    except MobileConfigError as ex:
        data, data_hash, data_error = None, "", _short(str(ex))
    except Exception as ex:  # any assembly failure is a data error
        log.exception("dashboard: building the data document failed")
        data, data_hash = None, ""
        data_error = _short(f"could not build dashboard data: {type(ex).__name__}: {ex}")
    version = _hash(
        spec_bytes or b"",
        lkg_bytes or b"",
        "\n".join(issues).encode(),
        data_hash.encode(),
        (data_error or "").encode(),
    )[:16]
    return {
        "spec": _parse_object(spec_bytes),
        "lkg": _parse_object(lkg_bytes),
        "data": data,
        "version": version,
        "issues": issues,
        "dataError": data_error,
    }
