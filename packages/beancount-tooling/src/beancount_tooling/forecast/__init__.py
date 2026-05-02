"""
Forecast transaction generation package.

This package provides modular components for generating and managing
forecasted beancount transactions from templates.yaml configuration.
"""

from .models import (
    TemplatePosting,
    TemplateTransaction,
    get_transaction_tid,
    build_tid_map,
)

__all__ = [
    "TemplatePosting",
    "TemplateTransaction",
    "get_transaction_tid",
    "build_tid_map",
]
