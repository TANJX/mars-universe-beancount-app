"""
Data structures for template transactions.

This module defines the core data models used to represent template transactions
before they are converted to beancount format.
"""

from dataclasses import dataclass
from datetime import date
from typing import Optional, List, Dict
from beancount.core import data, amount
from beancount.core.number import D


@dataclass
class TemplatePosting:
    """
    Represents a posting in a template transaction.

    Attributes:
        account: Beancount account name (e.g., "Assets:Checking:TD")
        amount: Amount for this posting, or None for residual posting
        currency: Currency code (default: "USD")
    """

    account: str
    amount: Optional[float]
    currency: str = "USD"

    def to_beancount_posting(self, meta: Optional[Dict] = None) -> data.Posting:
        """
        Convert to beancount Posting object.

        Args:
            meta: Optional metadata dict to attach to posting

        Returns:
            beancount Posting object
        """
        if meta is None:
            meta = {}

        # Create amount (None for residual posting)
        units = None
        if self.amount is not None:
            # Format with exactly 2 decimal places
            amount_str = f"{self.amount:.2f}"
            units = amount.Amount(D(amount_str), self.currency)

        return data.Posting(
            account=self.account,
            units=units,
            cost=None,
            price=None,
            flag=None,
            meta=meta,
        )


@dataclass
class TemplateTransaction:
    """
    Represents a template transaction before conversion to beancount format.

    Attributes:
        tid: Transaction ID in format "{template_id}:{YYYY-MM}"
        date: Transaction date
        flag: Transaction flag ("!" for pending, "*" for cleared)
        payee: Payee name
        narration: Transaction narration/description
        postings: List of template postings
    """

    tid: str
    date: date
    flag: str
    payee: str
    narration: str
    postings: List[TemplatePosting]

    def to_beancount_transaction(self) -> data.Transaction:
        """
        Convert to beancount Transaction object.

        The tid is attached as metadata to the first posting.

        Returns:
            beancount Transaction object
        """
        # Create transaction metadata
        meta = data.new_metadata("<generate_forecast>", 0)

        # Build postings with metadata
        beancount_postings = []
        for i, posting_template in enumerate(self.postings):
            # Create posting metadata
            posting_meta = {"filename": "<generate_forecast>", "lineno": i}

            # Add tid to first posting
            if i == 0:
                posting_meta["tid"] = self.tid

            # Convert to beancount posting
            posting = posting_template.to_beancount_posting(posting_meta)
            beancount_postings.append(posting)

        # Create transaction
        return data.Transaction(
            meta=meta,
            date=self.date,
            flag=self.flag,
            payee=self.payee,
            narration=self.narration,
            tags=set(),
            links=set(),
            postings=beancount_postings,
        )


def get_transaction_tid(txn: data.Transaction) -> Optional[str]:
    """
    Extract tid from a beancount transaction.

    The tid is stored in the first posting's metadata.

    Args:
        txn: Beancount Transaction object

    Returns:
        Transaction ID string, or None if transaction has no tid
    """
    if txn.postings and txn.postings[0].meta and "tid" in txn.postings[0].meta:
        return txn.postings[0].meta["tid"]
    return None


def build_tid_map(transactions: List[data.Transaction]) -> Dict[str, data.Transaction]:
    """
    Build a lookup map of tid -> Transaction.

    Only includes transactions that have tid metadata.
    Warns if duplicate tids are found (keeps first occurrence).

    Args:
        transactions: List of beancount Transaction objects

    Returns:
        Dict mapping tid string to Transaction object
    """
    tid_map = {}

    for txn in transactions:
        tid = get_transaction_tid(txn)

        if tid is None:
            continue

        if tid in tid_map:
            # Duplicate tid - warn and skip
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                f"Duplicate tid '{tid}' found. "
                f"Keeping first occurrence at {tid_map[tid].date}, "
                f"ignoring duplicate at {txn.date}"
            )
            continue

        tid_map[tid] = txn

    return tid_map
