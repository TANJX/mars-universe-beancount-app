"""``config/dashboard/context.json`` -> ``derived.context``. All data synthetic."""

import json

import pytest
from beancount_tooling.mobile import context as ctx
from beancount_tooling.mobile.assemble import inputs_signature
from beancount_tooling.mobile.context import empty_context, parse_context, read_context
from beancount_tooling.mobile.derived import build_derived

SHAPE_KEYS = {"generatedAt", "market", "news", "plan", "insights"}
MARKET_KEYS = {"asOf", "indices", "holdings", "note"}

INDEX = {
    "symbol": "IDX",
    "name": "Index A",
    "price": 100.5,
    "change": 1.5,
    "changePct": 0.015,
}
HOLDING = {"symbol": "FUNDA", "name": "Fund A", "changePct": -0.004, "weight": 0.4}
NEWS = {
    "id": "n1",
    "title": "Rates held steady",
    "source": "Example Wire",
    "url": "https://example.com/a",
    "publishedAt": "2030-03-09",
    "relevance": "Touches the savings rate",
    "tags": ["rates", "savings"],
}
PLAN = {
    "id": "p1",
    "date": "2030-03-20",
    "title": "Renew lease",
    "detail": "Sign by the 20th",
    "source": "docs/planning/short-term.md#housing",
    "status": "upcoming",
}
INSIGHT = {
    "id": "i1",
    "kind": "risk",
    "title": "Cash dips mid month",
    "body": "Two bills land together",
    "date": "2030-03-15",
    "source": "docs/planning/short-term.md",
    "amount": 1200,
}
GOOD = {
    "generatedAt": "2030-03-10T08:00:00Z",
    "market": {
        "asOf": "2030-03-09T21:00:00Z",
        "indices": [INDEX],
        "holdings": [HOLDING],
        "note": "  Quiet week  ",
    },
    "news": [NEWS],
    "plan": [PLAN],
    "insights": [INSIGHT],
}


def _write(cfg, doc):
    path = cfg / ctx.CONTEXT_RELATIVE
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(doc, bytes):
        path.write_bytes(doc)
    else:
        path.write_text(
            doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8"
        )


def _assert_shape(c):
    assert set(c) == SHAPE_KEYS
    assert set(c["market"]) == MARKET_KEYS
    for key in ("news", "plan", "insights"):
        assert isinstance(c[key], list)
    for key in ("indices", "holdings"):
        assert isinstance(c["market"][key], list)
    json.dumps(c)


def test_missing_file_reads_as_the_empty_shape(tmp_path):
    assert read_context(None) == empty_context()
    assert read_context(tmp_path / "config") == empty_context()
    _assert_shape(empty_context())


@pytest.mark.parametrize(
    "bad", ["not json", "", "[]", "null", "42", '"x"', b"\xff\xfe", "[" * 5000]
)
def test_invalid_json_reads_as_the_empty_shape(tmp_path, bad):
    cfg = tmp_path / "config"
    _write(cfg, bad)
    assert read_context(cfg) == empty_context()


def test_a_valid_file_round_trips(tmp_path):
    cfg = tmp_path / "config"
    _write(cfg, GOOD)
    c = read_context(cfg)
    _assert_shape(c)
    assert c["generatedAt"] == "2030-03-10T08:00:00Z"
    assert c["market"] == {
        "asOf": "2030-03-09T21:00:00Z",
        "indices": [INDEX | {"price": 100.5, "change": 1.5}],
        "holdings": [HOLDING],
        "note": "Quiet week",
    }
    assert c["news"] == [NEWS]
    assert c["plan"] == [PLAN]
    assert c["insights"] == [INSIGHT | {"amount": 1200.0}]
    assert isinstance(c["insights"][0]["amount"], float)


def test_optional_fields_default(tmp_path):
    c = parse_context(
        {
            "news": [
                {
                    k: v
                    for k, v in NEWS.items()
                    if k not in ("publishedAt", "relevance", "tags")
                }
            ],
            "plan": [PLAN | {"date": None, "detail": None}],
            "insights": [INSIGHT | {"date": None, "amount": None}],
            "market": {"indices": [{"symbol": "IDX", "name": "Index A"}]},
        }
    )
    assert c["news"][0]["publishedAt"] is None
    assert c["news"][0]["relevance"] == "" and c["news"][0]["tags"] == []
    assert c["plan"][0]["date"] is None and c["plan"][0]["detail"] == ""
    assert c["insights"][0]["date"] is None and c["insights"][0]["amount"] is None
    assert c["market"]["indices"] == [
        {
            "symbol": "IDX",
            "name": "Index A",
            "price": None,
            "change": None,
            "changePct": None,
        },
    ]
    assert c["market"]["asOf"] is None and c["market"]["note"] is None
    assert c["generatedAt"] is None


def test_bad_records_are_dropped_one_by_one():
    c = parse_context(
        {
            "news": [
                NEWS,
                NEWS | {"title": "repeated id"},
                NEWS | {"id": "a", "title": "  "},
                NEWS | {"id": "b", "source": 3},
                NEWS | {"id": "c", "publishedAt": "2030-02-31"},
                NEWS | {"id": "d", "tags": "rates"},
                {k: v for k, v in NEWS.items() if k != "url"} | {"id": "e"},
                "not an object",
            ],
            "plan": [
                PLAN | {"id": "x", "status": "someday"},
                PLAN | {"id": "y", "source": ""},
                PLAN | {"id": "z", "date": "next week"},
                {k: v for k, v in PLAN.items() if k != "title"} | {"id": "w"},
                PLAN,
            ],
            "insights": [
                INSIGHT | {"id": "x", "kind": "hunch"},
                INSIGHT | {"id": "y", "amount": "1200"},
                INSIGHT | {"id": "z", "amount": True},
                INSIGHT | {"id": "w", "amount": float("nan")},
                INSIGHT | {"id": "v", "body": None},
                INSIGHT | {"id": 7},
                INSIGHT,
            ],
            "market": {
                "asOf": "yesterday",
                "indices": [
                    INDEX | {"price": "100"},
                    INDEX | {"name": None},
                    INDEX,
                    INDEX | {"name": "dup symbol"},
                ],
                "holdings": [HOLDING | {"weight": float("inf")}, HOLDING],
                "note": 5,
            },
            "generatedAt": "not a date",
        }
    )
    _assert_shape(c)
    assert [n["id"] for n in c["news"]] == ["n1"]
    assert c["news"][0]["title"] == NEWS["title"]
    assert [p["id"] for p in c["plan"]] == ["p1"]
    assert [i["id"] for i in c["insights"]] == ["i1"]
    assert c["market"]["indices"] == [INDEX]
    assert c["market"]["holdings"] == [HOLDING]
    assert c["market"]["asOf"] is None and c["market"]["note"] is None
    assert c["generatedAt"] is None


def test_a_wrong_section_type_empties_only_that_section():
    c = parse_context(GOOD | {"news": {"id": "n1"}, "market": ["x"]})
    assert c["news"] == [] and c["market"] == empty_context()["market"]
    assert [p["id"] for p in c["plan"]] == ["p1"]
    assert [i["id"] for i in c["insights"]] == ["i1"]


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "ftp://example.com/a",
        "//example.com/a",
        "/relative/path",
        "https://",
        "https://exa mple.com/a",
        "  ",
    ],
)
def test_news_urls_must_be_http_or_https(url):
    assert parse_context({"news": [NEWS | {"url": url}]})["news"] == []


@pytest.mark.parametrize("url", ["http://example.com", "HTTPS://example.com/a?b=c#d"])
def test_http_and_https_urls_pass(url):
    assert parse_context({"news": [NEWS | {"url": url}]})["news"][0]["url"] == url


def test_publication_datetimes_are_cut_to_dates():
    c = parse_context({"news": [NEWS | {"publishedAt": "2030-03-09T14:30:00+00:00"}]})
    assert c["news"][0]["publishedAt"] == "2030-03-09"


def test_limits():
    many = lambda rec, n, key="id": [rec | {key: f"{rec[key]}-{i}"} for i in range(n)]
    c = parse_context(
        {
            "news": many(NEWS, 20),
            "plan": many(PLAN, 30),
            "insights": many(INSIGHT, 20),
            "market": {
                "indices": many(INDEX, 20, "symbol"),
                "holdings": many(HOLDING, 30, "symbol"),
            },
        }
    )
    assert len(c["news"]) == ctx.MAX_NEWS == 8
    assert len(c["plan"]) == ctx.MAX_PLAN == 20
    assert len(c["insights"]) == ctx.MAX_INSIGHTS == 8
    assert len(c["market"]["indices"]) == ctx.MAX_INDICES == 8
    assert len(c["market"]["holdings"]) == ctx.MAX_HOLDINGS == 15
    # The limit counts valid records, so a bad one early does not cost a slot.
    c = parse_context(
        {"news": [NEWS | {"id": "bad", "url": "ftp://x"}, *many(NEWS, 8)]}
    )
    assert len(c["news"]) == 8


def test_strings_are_trimmed_and_cut():
    c = parse_context(
        {
            "news": [
                NEWS
                | {
                    "title": "  " + "t" * 500 + "  ",
                    "relevance": "r" * 900,
                    "tags": [" a ", "", 3, "a", "b" * 99, *"cdefghijk"],
                }
            ],
            "plan": [PLAN | {"detail": "d" * 900}],
            "insights": [INSIGHT | {"body": "b" * 900}],
            "market": {"note": "n" * 900},
        }
    )
    assert c["news"][0]["title"] == "t" * ctx.MAX_TITLE and ctx.MAX_TITLE == 160
    assert len(c["news"][0]["relevance"]) == ctx.MAX_TEXT == 400
    tags = c["news"][0]["tags"]
    assert tags[:2] == ["a", "b" * ctx.MAX_TAG] and len(tags) == ctx.MAX_TAGS
    assert len(c["plan"][0]["detail"]) == 400
    assert len(c["insights"][0]["body"]) == 400
    assert len(c["market"]["note"]) == 400


def test_context_merges_into_derived(tmp_path):
    snap = {"asOf": "2030-03-10"}
    assert build_derived(snap, tmp_path)["context"] == empty_context()
    _write(tmp_path / "config", GOOD)
    assert [p["id"] for p in build_derived(snap, tmp_path)["context"]["plan"]] == ["p1"]
    other = tmp_path / "elsewhere"
    assert build_derived(snap, tmp_path, config_dir=other)["context"] == empty_context()
    _write(other, GOOD | {"plan": [PLAN | {"id": "q"}]})
    assert [
        p["id"]
        for p in build_derived(snap, tmp_path, config_dir=other)["context"]["plan"]
    ] == ["q"]


def test_inputs_signature_moves_with_context(tmp_path):
    before = inputs_signature(tmp_path)
    _write(tmp_path / "config", {})
    assert inputs_signature(tmp_path) != before
    other = tmp_path / "other-config"
    before = inputs_signature(tmp_path, other)
    _write(other, {})
    assert inputs_signature(tmp_path, other) != before
