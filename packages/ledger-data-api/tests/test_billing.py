"""The billing reader. Same vectors as beancount-tooling (the two packages
do not depend on each other; the fixture file is byte-identical in both)."""

import json
from pathlib import Path

import pytest
from conftest import stmt_line
from ledger_data_api import billing

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "billing_vectors.json").read_text()
)


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_reducer_vectors(tmp_path, vector):
    path = tmp_path / "billing" / "credit" / "DemoCard.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(
        "".join(
            (ln if isinstance(ln, str) else json.dumps(ln)) + "\n"
            for ln in vector["lines"]
        )
    )
    got = billing.read_statements(tmp_path, VECTORS["account"])
    assert [s.to_dict() for s in got] == vector["expected"]


def test_read_all(tmp_path):
    assert billing.read_all(tmp_path) == {}
    assert billing.read_statements(tmp_path, "Liabilities:Credit:DemoCard") == []

    root = tmp_path / "billing" / "credit"
    root.mkdir(parents=True)
    demo, other = "Liabilities:Credit:DemoCard", "Liabilities:Credit:Other"
    (root / "DemoCard.jsonl").write_text(
        "\n".join(
            json.dumps(ln)
            for ln in [
                stmt_line("2030-06-20", account=demo),
                stmt_line("2030-05-20", account=demo),
                # A record for another card in this file does not count.
                stmt_line("2030-05-20", account=other),
            ]
        )
    )
    (root / "Other.jsonl").write_text(
        json.dumps(stmt_line("2030-04-11", account=other)) + "\n"
    )
    # Every record voided: the account is absent.
    (root / "Gone.jsonl").write_text(
        json.dumps(stmt_line("2030-04-11", account="Liabilities:Credit:Gone"))
        + "\n"
        + json.dumps(
            {"account": "Liabilities:Credit:Gone", "id": "2030-04-11", "void": True}
        )
        + "\n"
    )
    (root / "notes.txt").write_text("ignored")
    (root / "Broken.jsonl").mkdir()  # unreadable as a file: skipped

    got = billing.read_all(tmp_path)
    assert sorted(got) == [demo, other]
    assert [s.id for s in got[demo]] == ["2030-05-20", "2030-06-20"]
    assert [s.id for s in got[other]] == ["2030-04-11"]
    assert billing.card_file(tmp_path, demo) == root / "DemoCard.jsonl"
