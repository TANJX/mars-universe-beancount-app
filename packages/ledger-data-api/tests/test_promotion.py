"""Promotion: a newly closed statement claims the card's expected statement."""

import datetime
import json
import threading

import pytest
from conftest import CARD, card, entries, plan_row, statement_mode, stmt_line
from ledger_data_api import cc_statements, store
from ledger_data_api.cc_statements import load_statement_data, promotions
from ledger_data_api.models import ExpectedStatement

EXPECTED = {
    CARD: {
        "id": "2030-06-20",
        "dueDate": "2030-07-15",
        "estimatedBalance": "850.00",
        "afterId": "2030-05-20",
        "createdAt": "2030-06-01T12:00:00+00:00",
        "updatedAt": "2030-06-01T12:00:00+00:00",
    }
}


def _setup(h, *closed_after, expected=EXPECTED):
    """One closed statement (05-20), an expected one (06-20) with an override
    plan and an unrelated plan, then the statements in `closed_after`."""
    statement_mode(h, stmt_line("2030-05-20"), *closed_after)
    h.write_expected(expected)
    h.write_plans(
        [
            plan_row(
                "p1",
                "2030-07-10",
                "-500.00",
                ccCardRef=CARD,
                ccStatementId="2030-06-20",
            ),
            plan_row(
                "keep",
                "2030-06-12",
                "-700.00",
                ccCardRef=CARD,
                ccStatementId="2030-05-20",
            ),
            plan_row("rent", "2030-06-20", "-900.00"),
        ]
    )


def _tags(plans) -> dict:
    return {p.id: p.ccStatementId for p in plans}


def _disk_expected(h) -> dict:
    """The expected records on disk (the promotion tombstones aside)."""
    raw = json.loads(h.expected_file.read_text())
    return {k: v for k, v in raw.items() if k != store.PROMOTED_KEY}


def test_promotion_when_dates_differ(h):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))
    data = load_statement_data(h.path)

    assert data.promoted == {CARD: ("2030-06-20", "2030-06-18")}
    assert data.persisted is True
    assert data.expected == {}
    assert _tags(data.plans) == {"p1": "2030-06-18", "keep": "2030-05-20", "rent": None}
    # On disk: the plan is re-pointed, the expected record (and its estimate)
    # is gone.
    assert _tags(store.list_plans(h.path)) == _tags(data.plans)
    assert _disk_expected(h) == {}
    # What claimed it is remembered, so a request still naming the old
    # expected id can be mapped.
    assert store.list_promotions(h.path) == {CARD: ("2030-06-20", "2030-06-18")}
    assert store.list_expected_statements(h.path) == {}
    moved = next(p for p in store.list_plans(h.path) if p.id == "p1")
    assert (moved.date, moved.amount, moved.ccCardRef) == (
        "2030-07-10",
        "-500.00",
        CARD,
    )
    assert moved.updatedAt != "2030-06-01T00:00:00+00:00"


def test_promotion_when_dates_equal(h):
    _setup(h, stmt_line("2030-06-20", "640.00", "2030-07-15"))
    before = h.plans_file.read_bytes()
    data = load_statement_data(h.path)
    assert data.promoted == {CARD: ("2030-06-20", "2030-06-20")}
    assert _tags(data.plans)["p1"] == "2030-06-20"
    assert _disk_expected(h) == {}
    # Same id: the plan rows already point at it, nothing to rewrite.
    assert _tags(store.list_plans(h.path))["p1"] == "2030-06-20"
    assert h.plans_file.read_bytes() == before


def test_promotion_when_closed_date_far_from_expected(h):
    # 12 days later than predicted: it still claims the expected statement.
    _setup(h, stmt_line("2030-07-02", "640.00", "2030-07-27"))
    data = load_statement_data(h.path)
    assert data.promoted == {CARD: ("2030-06-20", "2030-07-02")}
    assert _tags(store.list_plans(h.path))["p1"] == "2030-07-02"
    assert _disk_expected(h) == {}


def test_closed_statement_not_after_after_id_does_not_claim(h):
    # Only statements at or before afterId (an older one backfilled).
    _setup(h, stmt_line("2030-04-20", "300.00", "2030-05-15"))
    before = (h.plans_file.read_bytes(), h.expected_file.read_bytes())
    data = load_statement_data(h.path)
    assert data.promoted == {}
    assert data.expected[CARD].id == "2030-06-20"
    assert _tags(data.plans)["p1"] == "2030-06-20"
    assert (h.plans_file.read_bytes(), h.expected_file.read_bytes()) == before


def test_promotion_picks_earliest_newer_closed_statement(h):
    _setup(
        h,
        stmt_line("2030-07-19", "410.00", "2030-08-13"),
        stmt_line("2030-06-18", "640.00", "2030-07-13"),
    )
    data = load_statement_data(h.path)
    assert data.promoted == {CARD: ("2030-06-20", "2030-06-18")}
    assert _tags(data.plans)["p1"] == "2030-06-18"

    exp = {CARD: ExpectedStatement(CARD, "2030-06-20")}  # no afterId: any closed id
    assert promotions(exp, data.statements) == {CARD: ("2030-06-20", "2030-05-20")}
    assert promotions(exp, {}) == {}


def test_promotion_idempotent_rerun(h):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))
    first = load_statement_data(h.path)
    after_first = (h.plans_file.read_bytes(), h.expected_file.read_bytes())
    second = load_statement_data(h.path)
    assert (h.plans_file.read_bytes(), h.expected_file.read_bytes()) == after_first
    assert second.promoted == {}
    assert second.expected == {}
    assert _tags(second.plans) == _tags(first.plans)


def test_promotion_finishes_after_a_crash_between_the_two_writes(h, monkeypatch):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))

    def boom(*a, **k):
        raise PermissionError("read-only")

    # Plans were re-pointed, then the record delete failed.
    monkeypatch.setattr(store, "_write_json_atomic", boom)
    assert load_statement_data(h.path).persisted is False
    assert _tags(store.list_plans(h.path))["p1"] == "2030-06-18"
    assert CARD in _disk_expected(h)
    monkeypatch.undo()

    plans_before = h.plans_file.read_bytes()
    data = load_statement_data(h.path)
    assert data.persisted is True
    assert _disk_expected(h) == {}
    assert h.plans_file.read_bytes() == plans_before  # no second re-point


def test_promotion_read_only_filesystem(h, monkeypatch):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))
    before = (h.plans_file.read_bytes(), h.expected_file.read_bytes())

    def read_only(*a, **k):
        raise PermissionError("read-only file system")

    monkeypatch.setattr(store, "_write_json_atomic", read_only)
    monkeypatch.setattr(store, "append_plan_events", read_only)

    for _ in range(2):  # every read maps the same way
        data = load_statement_data(h.path)
        assert data.persisted is False
        assert _tags(data.plans)["p1"] == "2030-06-18"
        assert data.expected == {}
        assert data.promoted == {CARD: ("2030-06-20", "2030-06-18")}
        assert (h.plans_file.read_bytes(), h.expected_file.read_bytes()) == before

    # The grid shows the override on the closed statement.
    out = h.grid(datetime.date(2030, 6, 22))
    locked = [
        e for e in entries(out, "cc-locked") if e["ccStatementId"] == "2030-06-18"
    ]
    assert locked == []
    plans = {
        e["id"]: (e["ccStatementId"], e["ccStatementKind"])
        for e in entries(out, "plan")
    }
    assert plans["p1"] == ("2030-06-18", "closed")
    c = card(out)
    assert c["activeStatement"]["id"] == "2030-06-18"
    assert c["expectedStatement"] is None
    assert c["overrideTotal"] == "500.00"
    assert (h.plans_file.read_bytes(), h.expected_file.read_bytes()) == before

    # A save against the old expected id is accepted as the closed id, and
    # then fails loudly on the write (POSTs do not survive a read-only mount).
    with pytest.raises(PermissionError):
        cc_statements.save_override(
            h.path, {"cardAccountPath": CARD, "statementId": "2030-06-20", "plans": []}
        )


def test_concurrent_reconcile_calls_converge(h):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))
    lines_before = h.plans_file.read_text().count("\n")
    barrier = threading.Barrier(4)
    results, errors = [], []

    def run():
        try:
            barrier.wait(timeout=5)
            results.append(load_statement_data(h.path))
        except Exception as ex:  # noqa: BLE001
            errors.append(ex)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert errors == []
    assert len(results) == 4
    for data in results:
        assert _tags(data.plans)["p1"] == "2030-06-18"
        assert data.expected == {}
    # Final reduced state is right, and the plan was re-pointed exactly once.
    assert _tags(store.list_plans(h.path)) == {
        "p1": "2030-06-18",
        "keep": "2030-05-20",
        "rent": None,
    }
    assert _disk_expected(h) == {}
    assert h.plans_file.read_text().count("\n") == lines_before + 1


# ---------- a snapshot that cannot straddle a promotion ----------


def test_load_reads_plans_and_expected_under_the_plan_lock(h, monkeypatch):
    _setup(h, stmt_line("2030-06-18", "640.00", "2030-07-13"))
    held: list[bool] = []
    for name in ("list_plans", "list_expected_statements"):
        real = getattr(store, name)

        def spy(path, _real=real):
            held.append(store.PLAN_LOCK._is_owned())
            return _real(path)

        monkeypatch.setattr(store, name, spy)
    load_statement_data(h.path)
    assert held and all(held)


def test_auto_clear_does_not_write_back_tags_read_before_a_promotion(h):
    # plan_grid used to read plans first and statements later. A promotion
    # persisted in between left it holding plans tagged with the deleted
    # expected id, and auto-clearing a pending one wrote that tag back.
    from decimal import Decimal

    from ledger_data_api.merge import auto_clear_pending

    _setup(h)
    h.write_plans(
        [
            plan_row(
                "p1",
                "2030-07-10",
                "-500.00",
                ccCardRef=CARD,
                ccStatementId="2030-06-20",
                state="pending",
            )
        ]
    )
    stale = store.list_plans(h.path)  # read before the statement closed
    h.write_statements(
        "DemoCard",
        [stmt_line("2030-05-20"), stmt_line("2030-06-18", "640.00", "2030-07-13")],
    )
    assert load_statement_data(h.path).promoted  # another request persists it
    assert _tags(store.list_plans(h.path))["p1"] == "2030-06-18"

    cleared = {("2030-07-10", "Assets:Checking:Acme"): [Decimal("-500.00")]}
    out = auto_clear_pending(h.path, stale, cleared)
    assert next(p for p in out if p.id == "p1").state is None
    on_disk = next(p for p in store.list_plans(h.path) if p.id == "p1")
    assert (on_disk.ccStatementId, on_disk.state) == ("2030-06-18", None)

    # A plan deleted since it was read is not written back either.
    store.delete_plan(h.path, "keep")
    stale_keep = [
        cc_statements.dataclasses.replace(p, state="pending")
        for p in stale
        if p.id == "keep"
    ]
    auto_clear_pending(
        h.path,
        stale_keep,
        {("2030-06-12", "Assets:Checking:Acme"): [Decimal("-700.00")]},
    )
    assert "keep" not in _tags(store.list_plans(h.path))


# ---------- a corrected closing date is not the next statement ----------


def test_corrected_closing_date_of_previous_statement_does_not_claim(h):
    # 05-20 was a typo for 05-22: voided, then re-entered. The expected
    # statement (06-20) belongs to the NEXT cycle and must survive.
    void = {"account": CARD, "id": "2030-05-20", "void": True}
    _setup(h, void, stmt_line("2030-05-22"))
    assert (
        promotions(
            store.list_expected_statements(h.path), store.list_statements(h.path)
        )
        == {}
    )
    data = load_statement_data(h.path)
    assert data.promoted == {}
    assert data.expected[CARD].id == "2030-06-20"
    assert _tags(store.list_plans(h.path))["p1"] == "2030-06-20"

    # The real next statement still claims it, however far from 06-20.
    h.write_statements(
        "DemoCard",
        [
            stmt_line("2030-05-20"),
            void,
            stmt_line("2030-05-22"),
            stmt_line("2030-06-09"),
        ],
    )
    data = load_statement_data(h.path)
    assert data.promoted == {CARD: ("2030-06-20", "2030-06-09")}
    assert _tags(store.list_plans(h.path))["p1"] == "2030-06-09"
