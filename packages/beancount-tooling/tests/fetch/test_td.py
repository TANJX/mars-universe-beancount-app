"""TD fetcher: pure helpers only (no browser, no real site)."""

from decimal import Decimal

import pytest
from beancount_tooling.fetch.banks import td


def test_parse_amounts_reads_row_columns_in_order():
    row = '- row "DEMO CHECKING x1111 $3,302.28 $3,300.00 -$2.28":'
    assert td.parse_amounts(row) == [
        Decimal("3302.28"),
        Decimal("3300.00"),
        Decimal("-2.28"),
    ]
    assert td.parse_amounts(row)[td.BEGINNING_BALANCE_INDEX] == Decimal("3300.00")


def test_account_cell_name_matches_whole_digit_group():
    pattern = td.account_cell_name("1111")
    assert pattern.search("DEMO CHECKING x1111")
    assert not pattern.search("DEMO CHECKING x11112")
    with pytest.raises(td.TDStepError, match="last4"):
        td.account_cell_name(None)
