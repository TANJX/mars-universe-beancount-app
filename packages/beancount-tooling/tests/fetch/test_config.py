import copy

import pytest
import yaml
from beancount_tooling.fetch.config import (
    ConfigError,
    load_config,
    parse_config,
    render_archive_name,
)

from .conftest import EXTRACT_YAML, FETCH_YAML


@pytest.fixture
def raw():
    return yaml.safe_load(FETCH_YAML)


@pytest.fixture
def extract():
    return yaml.safe_load(EXTRACT_YAML)


def test_load_config_from_ledger_dir(ledger_dir):
    cfg = load_config()
    assert list(cfg.banks) == ["bofa", "amex"]
    assert cfg.login_timeout_minutes == 2
    assert cfg.profile_dir.is_absolute()
    assert cfg.payment_account == "Assets:Pending-Transfer"
    checking, card = cfg.banks["bofa"].accounts
    assert checking.kind == "checking" and checking.name == "DemoChecking"
    assert checking.extract["importer"] == "BofACheckingImporter"
    assert card.archive_name(2030, 9) == "September2030_1111.csv"
    amex = cfg.banks["amex"].accounts[0]
    assert amex.kind == "credit"  # derived from path
    assert amex.last5 == "TODO"
    assert amex.archive_name(2030, 9) == "2030-09.csv"
    assert cfg.banks["amex"].credentials.source == "keychain"


def test_select_filters_and_rejects_unknown(raw, extract):
    cfg = parse_config(raw, extract)
    assert [b.key for b in cfg.select(["amex"])] == ["amex"]
    assert [b.key for b in cfg.select([])] == ["bofa", "amex"]
    with pytest.raises(ConfigError, match="unknown bank"):
        cfg.select(["nope"])


def test_render_archive_name():
    assert (
        render_archive_name("{MonthName}{YYYY}_x.csv", 2031, 1) == "January2031_x.csv"
    )
    assert render_archive_name("{YYYY}-{MM}.csv", 2031, 12) == "2031-12.csv"


def _mutate(raw, fn):
    raw = copy.deepcopy(raw)
    fn(raw["fetch"])
    return raw


@pytest.mark.parametrize(
    "mutation, message",
    [
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(path="checking/Unknown"),
            "extract.yaml",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(path="nopath"),
            "<type>/<name>",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(kind="credit"),
            "does not match",
        ),
        (lambda f: f["banks"]["bofa"]["accounts"][0].update(last4="12"), "4-digit"),
        (lambda f: f["banks"]["bofa"]["accounts"][0].update(last5="12345"), "not both"),
        (lambda f: f["banks"]["bofa"]["accounts"][0].pop("rolling"), "rolling"),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(rolling="../x.csv"),
            "bare file name",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][1].update(archive="{Year}.csv"),
            "placeholder",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][1].update(archive="{YYYY}.csv"),
            "month",
        ),
        (lambda f: f["banks"]["bofa"]["accounts"][0].update(extra=1), "unknown key"),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(overview_name="  "),
            "overview_name",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(account_number="12a"),
            "digit string",
        ),
        (
            lambda f: f["banks"]["bofa"]["accounts"][0].update(history_start="2026"),
            "must be a date",
        ),
        (lambda f: f["banks"]["bofa"].update(accounts=[]), "non-empty list"),
        (lambda f: f["banks"]["bofa"].pop("credentials"), "credentials: missing"),
        (
            lambda f: f["banks"]["bofa"]["credentials"].update(source="clipboard"),
            "source",
        ),
        (lambda f: f["banks"]["bofa"]["credentials"].pop("id"), "id: required"),
        (
            lambda f: f["banks"]["amex"]["credentials"].pop("service"),
            "service: required",
        ),
        (lambda f: f.update(login_timeout_minutes=0), "positive"),
        (lambda f: f.update(profile_dir="relative/dir"), "absolute"),
        (lambda f: f.pop("profile_dir"), "profile_dir"),
        (lambda f: f.update(banks={}), "non-empty mapping"),
        (
            lambda f: f["banks"]["bofa"]["accounts"].append(
                dict(f["banks"]["bofa"]["accounts"][0])
            ),
            "already written",
        ),
    ],
)
def test_validation_errors(raw, extract, mutation, message):
    with pytest.raises(ConfigError, match=message):
        parse_config(_mutate(raw, mutation), extract)


def test_missing_top_level(extract):
    with pytest.raises(ConfigError, match="fetch:"):
        parse_config({}, extract)


def test_missing_files(tmp_path):
    with pytest.raises(ConfigError, match="fetch.yaml not found"):
        load_config(tmp_path)
