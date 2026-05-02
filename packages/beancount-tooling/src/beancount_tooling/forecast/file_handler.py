"""
File I/O and transaction merging for forecast generation.

This module handles:
- Loading existing bean files with beancount parser
- Merging template transactions with existing transactions
- Writing merged transactions back to files
"""

import logging
from datetime import date
from pathlib import Path
from typing import List, Set, Tuple
import re

from beancount import loader
from beancount.core import data
from beancount.parser import printer

from .models import TemplateTransaction

logger = logging.getLogger(__name__)


def load_existing_file(
    file_path: Path,
) -> Tuple[List[data.Transaction], List[data.Directive]]:
    """
    Load and parse existing bean file.

    Uses beancount loader to parse the file and separate transactions
    from other directives (comments, Open, etc.).

    Args:
        file_path: Path to bean file

    Returns:
        Tuple of (transactions, other_directives)
        - transactions: List of Transaction objects
        - other_directives: List of non-transaction directives

    Note:
        Returns empty lists if file doesn't exist or has parse errors
    """
    if not file_path.exists():
        logger.debug(f"File does not exist: {file_path}")
        return [], []

    try:
        entries, errors, options = loader.load_file(str(file_path))
    except Exception as e:
        logger.error(f"Failed to load {file_path}: {e}")
        return [], []

    # Note: Beancount may return validation errors (like "unknown account")
    # These are warnings, not syntax errors. We only skip on syntax errors.
    # Validation errors are expected for files without Open directives.
    if errors:
        # Check if there are actual syntax errors (not just validation warnings)
        syntax_errors = [
            e
            for e in errors
            if "Syntax error" in str(e) or "unexpected" in str(e).lower()
        ]
        if syntax_errors:
            logger.error(f"Syntax errors in {file_path}:")
            for error in syntax_errors:
                logger.error(f"  {error}")
            logger.warning("Skipping file to avoid corruption")
            return [], []
        else:
            # Just validation warnings - log at debug level
            logger.debug(
                f"Validation warnings in {file_path} (ignored): {len(errors)} warnings"
            )

    # Separate transactions from other directives
    transactions = [e for e in entries if isinstance(e, data.Transaction)]
    other_directives = [e for e in entries if not isinstance(e, data.Transaction)]

    logger.debug(f"Loaded {len(transactions)} transactions from {file_path}")
    return transactions, other_directives


def split_forecasted_and_actual(file_path: Path) -> Tuple[int, str]:
    """
    Find where forecasted transactions end and actual transactions begin.

    Reads file as text and finds the line number where the first non-forecasted
    transaction (no tid) appears.

    Args:
        file_path: Path to bean file

    Returns:
        Tuple of (line_number_of_first_actual, remaining_content)
        - line_number: Line where actual transactions start (0 if no actuals)
        - remaining_content: Raw text of everything after forecasted section
    """
    if not file_path.exists():
        return 0, ""

    try:
        with open(file_path, "r") as f:
            lines = f.readlines()
    except Exception as e:
        logger.error(f"Failed to read {file_path}: {e}")
        return 0, ""

    # Find first transaction that is NOT a replaceable forecast
    # A transaction is a "replaceable forecast" only if:
    # - It has a tid: metadata, AND
    # - It is marked as pending (!) not cleared (*)
    in_transaction = False
    transaction_start = -1
    has_tid = False
    is_cleared = False

    for i, line in enumerate(lines):
        # Check if line starts a transaction
        if line.strip() and line[0].isdigit():
            # Save previous transaction state
            if in_transaction and transaction_start >= 0:
                # Transaction is "actual" (preserved) if no tid OR if cleared
                if not has_tid or is_cleared:
                    # Found first non-forecasted transaction
                    remaining = "".join(lines[transaction_start:])
                    logger.debug(
                        f"Actual transactions start at line {transaction_start + 1}"
                    )
                    return transaction_start, remaining

            # Start new transaction
            in_transaction = True
            transaction_start = i
            has_tid = False
            # Check if this is a cleared (*) transaction
            is_cleared = " * " in line

        # Check if current transaction has tid
        elif in_transaction and "tid:" in line:
            has_tid = True

    # Check the last transaction
    if in_transaction and transaction_start >= 0:
        if not has_tid or is_cleared:
            remaining = "".join(lines[transaction_start:])
            logger.debug(f"Actual transactions start at line {transaction_start + 1}")
            return transaction_start, remaining

    # If we get here, no actual transactions found
    # Return empty string (all transactions are forecasted or file is empty)
    return len(lines), ""


def extract_cleared_tids(actual_section: str) -> Set[str]:
    """
    Extract tids from cleared (*) transactions in the actual section.

    Args:
        actual_section: Raw text of actual transactions

    Returns:
        Set of tid values from cleared transactions
    """
    cleared_tids = set()
    lines = actual_section.split("\n")

    in_cleared_txn = False
    for line in lines:
        # Check if line starts a transaction
        if line.strip() and line[0].isdigit():
            # Check if it's a cleared (*) transaction
            in_cleared_txn = " * " in line

        # Extract tid from cleared transactions
        elif in_cleared_txn and "tid:" in line:
            match = re.search(r'tid:\s*"([^"]+)"', line)
            if match:
                cleared_tids.add(match.group(1))

    return cleared_tids


def generate_forecasted_section(templates: List[TemplateTransaction]) -> str:
    """
    Generate the forecasted transactions section.

    Formats all template transactions and combines them with proper spacing.

    Args:
        templates: List of TemplateTransaction objects

    Returns:
        Formatted string of all forecasted transactions
    """
    if not templates:
        return ""

    # Convert templates to beancount transactions
    transactions = [t.to_beancount_transaction() for t in templates]

    # Sort by date
    transactions.sort(key=lambda t: t.date)

    # Format each transaction
    lines = []
    for txn in transactions:
        lines.append(printer.format_entry(txn))

    return "\n".join(lines)


def write_file_with_forecasts(
    file_path: Path, forecasted_section: str, actual_section: str, dry_run: bool = False
) -> str:
    """
    Write file with forecasted transactions at top, actual transactions below.

    Args:
        file_path: Path to write to
        forecasted_section: Formatted forecasted transactions
        actual_section: Raw text of actual transactions (unchanged)
        dry_run: If True, don't actually write file

    Returns:
        Status: 'created', 'updated', or 'failed'
    """
    existed = file_path.exists()

    # Combine forecasted and actual sections
    if forecasted_section and actual_section:
        content = forecasted_section + "\n" + actual_section
    elif actual_section:
        content = actual_section
    else:
        content = forecasted_section

    # Dry run - don't write
    if dry_run:
        logger.info(f"Would {'update' if existed else 'create'}: {file_path}")
        logger.debug(f"Forecasted section: {len(forecasted_section)} chars")
        logger.debug(f"Actual section: {len(actual_section)} chars")
        return "updated" if existed else "created"

    # Write file
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w") as f:
            f.write(content)
        logger.info(f"{'Updated' if existed else 'Created'}: {file_path}")
        return "updated" if existed else "created"
    except IOError as e:
        logger.error(f"Failed to write {file_path}: {e}")
        return "failed"


def merge_and_write_file(
    file_path: Path,
    template_txns: List[TemplateTransaction],
    today: date,
    dry_run: bool = False,
) -> str:
    """
    Update forecasted section at top of file, preserve actual transactions below.

    Strategy:
    1. Split file into forecasted (top) and actual (bottom) sections
    2. Generate new forecasted section from templates
    3. Write: new forecasted section + unchanged actual section

    Args:
        file_path: Path to bean file
        template_txns: List of TemplateTransaction objects
        today: Current date for past/future comparison (unused in new approach)
        dry_run: If True, don't actually write file

    Returns:
        Status: 'created', 'updated', 'skipped', or 'failed'
    """
    # Find where actual transactions start
    split_line, actual_section = split_forecasted_and_actual(file_path)

    # Extract tids from cleared transactions (these should not be regenerated)
    cleared_tids = extract_cleared_tids(actual_section)

    # Filter templates:
    # 1. Only include future dates (skip past/today forecasts)
    # 2. Skip templates whose tid already has a cleared transaction
    future_templates = [
        t for t in template_txns if t.date >= today and t.tid not in cleared_tids
    ]

    # Generate new forecasted section from filtered templates
    forecasted_section = generate_forecasted_section(future_templates)

    # Write file
    status = write_file_with_forecasts(
        file_path, forecasted_section, actual_section, dry_run
    )

    return status
