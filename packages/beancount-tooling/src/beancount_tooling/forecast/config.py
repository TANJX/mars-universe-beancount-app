"""
Configuration loading and validation for forecast generation.

This module handles loading templates.yaml, validating required fields,
and providing helper functions for template rendering and account mapping.
"""

import calendar
import logging
import re
import sys
from typing import Dict

import yaml

logger = logging.getLogger(__name__)


def load_config(config_path: str) -> Dict:
    """
    Load and validate templates.yaml configuration.

    Args:
        config_path: Path to templates.yaml file

    Returns:
        Validated configuration dictionary

    Raises:
        SystemExit: If configuration is invalid or cannot be loaded
    """
    try:
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
    except FileNotFoundError:
        logger.error(f"Configuration file not found: {config_path}")
        sys.exit(1)
    except yaml.YAMLError as e:
        logger.error(f"Error parsing YAML: {e}")
        sys.exit(1)

    # Validate required top-level sections
    if "forecast" not in config:
        logger.error("Missing 'forecast' section in config")
        sys.exit(1)
    if "months" not in config["forecast"]:
        logger.error("Missing 'forecast.months' in config")
        sys.exit(1)
    if "defaults" not in config:
        logger.error("Missing 'defaults' section in config")
        sys.exit(1)
    if "accounts" not in config:
        logger.error("Missing 'accounts' section in config")
        sys.exit(1)

    # Validate month formats
    for month in config["forecast"]["months"]:
        if not re.match(r"^\d{4}-\d{2}$", month):
            logger.error(f"Invalid month format: {month} (expected YYYY-MM)")
            sys.exit(1)

    # Validate salary payments have id field
    if "salary" in config["defaults"] and "payments" in config["defaults"]["salary"]:
        for payment in config["defaults"]["salary"]["payments"]:
            if "id" not in payment:
                logger.error(f"Salary payment missing 'id' field: {payment}")
                sys.exit(1)

    # Validate custom templates have id field
    for template in config.get("custom_templates", []):
        if "id" not in template:
            logger.error(f"Custom template missing 'id' field: {template}")
            sys.exit(1)

    logger.debug(
        f"Loaded configuration with {len(config['forecast']['months'])} months"
    )
    return config


def render_template_string(template: str, year: int, month: int, day: int = 1) -> str:
    """
    Render a template string with date variables.

    Supported variables:
        {year}       - Year (e.g., "2026")
        {month}      - Month zero-padded (e.g., "03")
        {day}        - Day zero-padded (e.g., "15")
        {month_name} - Full month name (e.g., "March")
        {month_abbr} - Abbreviated month name (e.g., "Mar")

    Args:
        template: Template string with variables
        year: Year
        month: Month (1-12)
        day: Day of month

    Returns:
        Rendered string with variables substituted

    Example:
        >>> render_template_string("Rent for {month_name} {year}", 2026, 3)
        "Rent for March 2026"
    """
    month_name = calendar.month_name[month]
    month_abbr = calendar.month_abbr[month]

    return template.format(
        year=year,
        month=f"{month:02d}",
        day=f"{day:02d}",
        month_name=month_name,
        month_abbr=month_abbr,
    )


def get_account_beancount_name(config: Dict, account_short_name: str) -> str:
    """
    Map short account name to full beancount account name.

    Args:
        config: Configuration dictionary
        account_short_name: Short name like 'TD', 'BofA', etc.

    Returns:
        Full beancount account name (e.g., "Assets:Checking:TD")

    Example:
        >>> get_account_beancount_name(config, "TD")
        "Assets:Checking:TD"
    """
    if "accounts" not in config:
        logger.error("No 'accounts' section in config")
        return account_short_name

    if account_short_name not in config["accounts"]:
        logger.warning(f"Account {account_short_name} not found in config, using as-is")
        return account_short_name

    return config["accounts"][account_short_name]["beancount_account"]


def get_account_file_path(
    config: Dict, account_short_name: str, year: int = None, month: int = None
) -> str:
    """
    Get the relative file path for an account from configuration.

    The path is rendered from a template string that may include:
    {year}, {month}, {day}, {month_name}, {month_abbr}

    Args:
        config: Configuration dictionary
        account_short_name: Short name like 'TD', 'BofA', 'Rent'
        year: Year for template rendering (optional)
        month: Month for template rendering (optional)

    Returns:
        Relative file path string (e.g., "transactions/2026-01/checking/TD.bean")

    Example:
        >>> get_account_file_path(config, "TD", 2026, 1)
        "transactions/2026-01/checking/TD.bean"
    """
    if "accounts" not in config:
        logger.error("No 'accounts' section in config")
        # Fallback: construct a simple path
        if year and month:
            return f"{year}-{month:02d}/checking/{account_short_name}.bean"
        return f"checking/{account_short_name}.bean"

    if account_short_name not in config["accounts"]:
        logger.warning(f"Account {account_short_name} not found in config")
        # Fallback: construct a simple path
        if year and month:
            return f"{year}-{month:02d}/checking/{account_short_name}.bean"
        return f"checking/{account_short_name}.bean"

    # Get file path from config (template string format)
    file_path_template = config["accounts"][account_short_name]["file"]

    # Render template if year and month provided
    if (
        year
        and month
        and ("{year}" in file_path_template or "{month}" in file_path_template)
    ):
        file_path = render_template_string(file_path_template, year, month)
    else:
        file_path = file_path_template

    return file_path


def get_last_weekday_on_or_before(year: int, month: int, day: int) -> int:
    """
    Get the last weekday (Mon-Fri) on or before the specified day.

    Note: This only checks for weekends, not holidays.

    Args:
        year: Year
        month: Month (1-12)
        day: Day of month

    Returns:
        Day of month that is a weekday (Mon-Fri)

    Example:
        >>> get_last_weekday_on_or_before(2026, 2, 15)  # Feb 15, 2026 is Sunday
        13  # Friday Feb 13
    """
    from datetime import date as dt_date

    current_day = day
    while current_day > 0:
        d = dt_date(year, month, current_day)
        # weekday(): Monday=0, Sunday=6
        if d.weekday() < 5:  # Mon-Fri
            return current_day
        current_day -= 1

    # Fallback (shouldn't happen with valid input)
    return day


def resolve_date(year: int, month: int, day_spec) -> int:
    """
    Resolve day specification to actual day number.

    Supported formats:
        - Integer (e.g., 15): Specific day of month
        - Integer -1: Last day of month
        - String "weekday:N": Last weekday (Mon-Fri) on or before day N
        - String "weekday:-1" or "weekday:last": Last weekday of month

    Args:
        year: Year
        month: Month (1-12)
        day_spec: Day specification (int or string)

    Returns:
        Actual day of month

    Example:
        >>> resolve_date(2026, 2, -1)
        28
        >>> resolve_date(2026, 2, 15)
        15
        >>> resolve_date(2026, 2, "weekday:15")  # Feb 15, 2026 is Sunday
        13  # Friday Feb 13
        >>> resolve_date(2026, 2, "weekday:-1")  # Last weekday of Feb
        27  # Friday Feb 27
    """
    # Handle string weekday specifications
    if isinstance(day_spec, str):
        if day_spec.startswith("weekday:"):
            target = day_spec[8:]  # Remove "weekday:" prefix
            if target == "last" or target == "-1":
                # Last weekday of month
                last_day = calendar.monthrange(year, month)[1]
                return get_last_weekday_on_or_before(year, month, last_day)
            else:
                # Last weekday on or before specified day
                target_day = int(target)
                return get_last_weekday_on_or_before(year, month, target_day)
        else:
            raise ValueError(f"Unknown date specification: {day_spec}")

    # Handle integer specifications
    if day_spec == -1:
        return calendar.monthrange(year, month)[1]
    return day_spec


def get_account_short_name(config: Dict, beancount_account: str) -> str:
    """
    Reverse lookup: get short account name from beancount account.

    Args:
        config: Configuration dictionary
        beancount_account: Full beancount account name

    Returns:
        Short account name (e.g., "TD")

    Raises:
        ValueError: If no mapping found for the beancount account

    Example:
        >>> get_account_short_name(config, "Assets:Checking:TD")
        "TD"
    """
    if "accounts" not in config:
        raise ValueError("No 'accounts' section in config")

    for short_name, account_config in config["accounts"].items():
        if account_config["beancount_account"] == beancount_account:
            return short_name

    raise ValueError(f"No account mapping for {beancount_account}")
