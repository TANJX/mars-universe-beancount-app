"""Chase fetcher: pure helpers only (no browser, no real site)."""

import pytest

from beancount_tooling.fetch.banks import chase
from beancount_tooling.fetch.banks.base import get_fetcher


def test_registered():
    assert get_fetcher("chase") is chase.ChaseFetcher


def test_account_option_matches_whole_digit_group():
    pattern = chase.account_option_name("1111")
    assert pattern.search("Freedom Unlimited (...1111)")
    assert not pattern.search("Freedom Unlimited (...11112)")
    with pytest.raises(chase.ChaseStepError, match="last4"):
        chase.account_option_name("TODO")
