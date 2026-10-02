"""Bank fetchers. See banks/base.py for the Fetcher contract and registry."""

from beancount_tooling.fetch.banks.base import (
    REGISTRY,
    Fetcher,
    StagedFile,
    get_fetcher,
)

__all__ = ["REGISTRY", "Fetcher", "StagedFile", "get_fetcher"]
