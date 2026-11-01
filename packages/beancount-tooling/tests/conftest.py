"""Shared fixtures for the beancount-tooling tests."""

from pathlib import Path

import pytest
from beancount_tooling import merchants

MERCHANTS_FIXTURE = Path(__file__).parent / "fixtures" / "merchants.yaml"


@pytest.fixture(autouse=True)
def _no_ledger_merchant_map():
    """Never read the real $LEDGER_DIR/config/merchants.yaml in tests: `just
    test` exports LEDGER_DIR, and a private map would change payees under
    synthetic rows. Each test starts with an empty map."""
    merchants.set_config(merchants.EMPTY_CONFIG)
    yield
    merchants.set_config(None)


@pytest.fixture
def merchant_map():
    """Install the synthetic tests/fixtures/merchants.yaml as the active map."""
    config = merchants.load_config(MERCHANTS_FIXTURE)
    merchants.set_config(config)
    return config
