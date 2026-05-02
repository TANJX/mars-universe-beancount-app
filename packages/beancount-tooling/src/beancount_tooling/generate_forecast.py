#!/usr/bin/env python3
"""
Generate forecasted transactions from forecast.yaml

This script reads template configurations and generates .bean files for future months
with forecasted transactions (salary, loan payments, etc.). It uses a tid-based
merging system to update specific transactions while preserving actual imports.

Usage:
    python3 script/generate_forecast.py                    # Generate all configured months
    python3 script/generate_forecast.py --dry-run          # Preview without writing
    python3 script/generate_forecast.py --month 2026-03    # Generate specific month
"""

import argparse
import logging
import sys
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

from beancount_tooling.forecast.config import load_config
from beancount_tooling.forecast.template_generator import generate_month_templates
from beancount_tooling.forecast.file_handler import merge_and_write_file
from beancount_tooling.paths import get_config_dir, get_journal_dir

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def generate_all_months(
    config: Dict,
    journal_base_path: Path,
    months: Optional[List[str]] = None,
    dry_run: bool = False,
) -> Dict[str, List[str]]:
    """
    Generate forecasts for all configured months or specified months.

    Args:
        config: Configuration dictionary
        journal_base_path: Base path to journal directory
        months: List of months to generate (None = all configured)
        dry_run: If True, preview without writing

    Returns:
        Statistics dict with 'created', 'updated', 'skipped', 'failed' lists
    """
    if months is None:
        months = config["forecast"]["months"]

    logger.info(f"Generating forecasts for {len(months)} month(s): {', '.join(months)}")

    stats = {"created": [], "updated": [], "skipped": [], "failed": []}

    today = date.today()

    # Process each month
    for month in months:
        logger.info(f"Processing {month}...")

        # Generate templates for this month
        file_templates = generate_month_templates(config, month)

        # Write each file
        for relative_file_path, templates in file_templates.items():
            # Construct full path
            file_path = journal_base_path / relative_file_path

            # Merge and write
            status = merge_and_write_file(file_path, templates, today, dry_run)

            # Track stats (use relative path for display)
            stats[status].append(str(relative_file_path))

    return stats


def print_summary(stats: Dict[str, List[str]], dry_run: bool = False):
    """Print a summary of what was done."""
    print("\n" + "=" * 60)
    if dry_run:
        print("FORECAST GENERATION PREVIEW (DRY RUN)")
    else:
        print("FORECAST GENERATION SUMMARY")
    print("=" * 60)

    if stats["created"]:
        print(f"\nCreated ({len(stats['created'])}):")
        for item in stats["created"]:
            print(f"  ✓ {item}")

    if stats["updated"]:
        print(f"\nUpdated ({len(stats['updated'])}):")
        for item in stats["updated"]:
            print(f"  ↻ {item}")

    if stats["skipped"]:
        print(f"\nSkipped ({len(stats['skipped'])}):")
        for item in stats["skipped"]:
            print(f"  → {item}")

    if stats["failed"]:
        print(f"\nFailed ({len(stats['failed'])}):")
        for item in stats["failed"]:
            print(f"  ✗ {item}")

    if not any(stats.values()):
        print("\nNo changes made.")

    print("=" * 60 + "\n")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Generate forecasted transactions from forecast.yaml",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                      Generate all configured months
  %(prog)s --dry-run            Preview without writing
  %(prog)s --month 2026-03      Generate specific month only
  %(prog)s -v                   Verbose output
        """,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing files",
    )
    parser.add_argument("--month", help="Generate for specific month only (YYYY-MM)")
    parser.add_argument(
        "--config",
        default=str(get_config_dir() / "forecast.yaml"),
        help="Path to forecast.yaml (default: <LEDGER_DIR>/config/forecast.yaml)",
    )
    parser.add_argument(
        "--journal-path",
        default=str(get_journal_dir()),
        help="Path to journal directory (default: <LEDGER_DIR>/journal)",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Verbose output (DEBUG level)"
    )

    args = parser.parse_args()

    # Set log level
    if args.verbose:
        logger.setLevel(logging.DEBUG)
        logging.getLogger("forecast").setLevel(logging.DEBUG)

    # Load configuration
    try:
        config = load_config(args.config)
    except SystemExit:
        # Config loading already logged the error
        sys.exit(1)

    # Determine months to process
    months = [args.month] if args.month else None

    # Validate month format if specified
    if args.month:
        import re

        if not re.match(r"^\d{4}-\d{2}$", args.month):
            logger.error(f"Invalid month format: {args.month} (expected YYYY-MM)")
            sys.exit(1)

    # Generate forecasts
    try:
        journal_base_path = Path(args.journal_path)
        stats = generate_all_months(
            config, journal_base_path, months, dry_run=args.dry_run
        )
        print_summary(stats, dry_run=args.dry_run)
    except Exception as e:
        logger.error(f"Error generating forecasts: {e}")
        if args.verbose:
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()
