"""
Template generation logic for forecast transactions.

This module handles creating TemplateTransaction objects for:
- Salary payments (from defaults.salary.payments)
- Tesla loan payments (from defaults.tesla_loan)
- Custom templates (from custom_templates)
"""

import copy
import logging
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

from .models import TemplateTransaction, TemplatePosting
from .config import (
    get_account_beancount_name,
    get_account_file_path,
    resolve_date,
    render_template_string,
)

logger = logging.getLogger(__name__)


def merge_payment_override(base_payment: dict, override: dict) -> dict:
    """
    Merge payment override with base payment configuration.

    IMPORTANT: Distribution override replaces entirely, not merges.

    Args:
        base_payment: Base payment configuration
        override: Override configuration (partial)

    Returns:
        Merged payment configuration
    """
    merged = copy.deepcopy(base_payment)

    # Distribution override replaces entirely
    if "distribution" in override:
        merged["distribution"] = override["distribution"]

    # Override other fields if present
    for key in ["date", "payee", "narration", "income_account", "enabled"]:
        if key in override:
            merged[key] = override[key]

    return merged


def create_salary_template(
    year: int,
    month: int,
    day: int,
    account_short_name: str,
    amount: float,
    payee: str,
    narration: str,
    income_account: str,
    tid: str,
    flag: str,
    config: Dict,
) -> TemplateTransaction:
    """
    Create a salary payment template transaction.

    Args:
        year: Year
        month: Month (1-12)
        day: Day of month
        account_short_name: Short account name (TD, BofA, etc.)
        amount: Dollar amount
        payee: Transaction payee
        narration: Transaction narration (supports template strings)
        income_account: Income account to credit
        tid: Transaction ID
        flag: Transaction flag ("!" or "*")
        config: Configuration dictionary

    Returns:
        TemplateTransaction object
    """
    # Get full beancount account name
    account = get_account_beancount_name(config, account_short_name)

    # Render narration template
    rendered_narration = render_template_string(narration, year, month, day)

    # Create postings
    postings = [
        TemplatePosting(account, amount, "USD"),
        TemplatePosting(income_account, None, "USD"),  # Residual
    ]

    return TemplateTransaction(
        tid=tid,
        date=date(year, month, day),
        flag=flag,
        payee=payee,
        narration=rendered_narration,
        postings=postings,
    )


def create_tesla_loan_template(
    year: int, month: int, principal: float, tid: str, flag: str, config: Dict
) -> TemplateTransaction:
    """
    Create a Tesla loan payment template transaction.

    Args:
        year: Year
        month: Month (1-12)
        principal: Principal amount (interest calculated as residual)
        tid: Transaction ID
        flag: Transaction flag
        config: Configuration dictionary

    Returns:
        TemplateTransaction object
    """
    loan_config = config["defaults"]["tesla_loan"]
    total = loan_config["total_payment"]
    day = loan_config["date"]

    # Create postings: checking debit, liability credit, interest residual
    postings = [
        TemplatePosting(loan_config["checking_account"], -total, "USD"),
        TemplatePosting(loan_config["liability_account"], principal, "USD"),
        TemplatePosting(loan_config["interest_account"], None, "USD"),  # Residual
    ]

    return TemplateTransaction(
        tid=tid,
        date=date(year, month, day),
        flag=flag,
        payee=loan_config["payee"],
        narration=loan_config["narration"],
        postings=postings,
    )


def create_custom_template(
    year: int,
    month: int,
    day: int,
    payee: str,
    narration: str,
    posting_configs: List[dict],
    tid: str,
    flag: str,
) -> TemplateTransaction:
    """
    Create a custom template transaction.

    Args:
        year: Year
        month: Month (1-12)
        day: Day of month
        payee: Transaction payee
        narration: Transaction narration (supports template strings)
        posting_configs: List of posting dicts with 'account', 'amount', 'currency'
        tid: Transaction ID
        flag: Transaction flag

    Returns:
        TemplateTransaction object
    """
    # Render narration template
    rendered_narration = render_template_string(narration, year, month, day)

    # Create postings
    postings = []
    for posting_config in posting_configs:
        account = posting_config.get("account", "")
        amount = posting_config.get("amount")  # None for residual
        currency = posting_config.get("currency", "USD")
        postings.append(TemplatePosting(account, amount, currency))

    return TemplateTransaction(
        tid=tid,
        date=date(year, month, day),
        flag=flag,
        payee=payee,
        narration=rendered_narration,
        postings=postings,
    )


def generate_month_salary_templates(
    config: Dict, month: str
) -> List[TemplateTransaction]:
    """
    Generate salary payment template transactions for a month.

    Args:
        config: Configuration dictionary
        month: Month in YYYY-MM format

    Returns:
        List of TemplateTransaction objects
    """
    year, month_num = map(int, month.split("-"))

    # Get default payments
    default_payments = config["defaults"]["salary"]["payments"]

    # Get month-specific overrides if any
    month_config = config.get("months", {}).get(month, {})
    salary_overrides = month_config.get("salary", {}).get("overrides", {})

    # Get global transaction flag
    global_flag = config["forecast"]["transaction_flag"]

    templates = []

    # Process each payment
    for payment in default_payments:
        # Start with default payment config
        payment_config = payment.copy()

        # Apply month-specific override if exists for this payment ID
        payment_id = payment.get("id")
        if payment_id and payment_id in salary_overrides:
            payment_config = merge_payment_override(
                payment, salary_overrides[payment_id]
            )

        # Check if payment is enabled (defaults to True if not specified)
        if not payment_config.get("enabled", True):
            logger.debug(f"Skipping disabled payment '{payment_id}' for {month}")
            continue

        # Extract payment details
        date_value = payment_config["date"]
        payee = payment_config["payee"]
        narration = payment_config["narration"]
        income_account = payment_config["income_account"]
        distribution = payment_config["distribution"]

        # Resolve actual day
        actual_day = resolve_date(year, month_num, date_value)

        # Generate template for each account in distribution
        for account_short_name, amount in distribution.items():
            tid = f"{payment_id}:{month}"

            template = create_salary_template(
                year=year,
                month=month_num,
                day=actual_day,
                account_short_name=account_short_name,
                amount=amount,
                payee=payee,
                narration=narration,
                income_account=income_account,
                tid=tid,
                flag=global_flag,
                config=config,
            )
            templates.append(template)

    logger.debug(f"Generated {len(templates)} salary templates for {month}")
    return templates


def generate_month_tesla_template(
    config: Dict, month: str
) -> Optional[TemplateTransaction]:
    """
    Generate Tesla loan payment template transaction for a month.

    Args:
        config: Configuration dictionary
        month: Month in YYYY-MM format

    Returns:
        TemplateTransaction object or None if not configured
    """
    year, month_num = map(int, month.split("-"))

    # Get month-specific principal or use default
    month_config = config.get("months", {}).get(month, {})
    tesla_config = month_config.get("tesla_loan", {})

    principal = tesla_config.get(
        "principal", config["defaults"]["tesla_loan"]["principal"]
    )

    # Get global transaction flag
    global_flag = config["forecast"]["transaction_flag"]

    # Generate tid
    tid = f"tesla_loan:{month}"

    template = create_tesla_loan_template(
        year=year,
        month=month_num,
        principal=principal,
        tid=tid,
        flag=global_flag,
        config=config,
    )

    logger.debug(f"Generated Tesla loan template for {month}")
    return template


def generate_month_custom_templates(
    config: Dict, month: str
) -> List[TemplateTransaction]:
    """
    Generate custom template transactions for a month.

    Args:
        config: Configuration dictionary
        month: Month in YYYY-MM format

    Returns:
        List of TemplateTransaction objects
    """
    year, month_num = map(int, month.split("-"))

    # Get custom templates from config
    custom_templates_config = config.get("custom_templates", [])

    # Get global transaction flag
    global_flag = config["forecast"]["transaction_flag"]

    templates = []

    for template_config in custom_templates_config:
        # Check if this template applies to this month
        if "months" in template_config:
            if month not in template_config["months"]:
                continue

        # Get template details
        template_id = template_config["id"]
        date_value = template_config.get("date", 1)
        payee = template_config.get("payee", "")
        narration = template_config.get("narration", "")
        enabled = template_config.get("enabled", True)
        posting_configs = template_config.get("postings", [])

        # Support custom transaction_flag per template
        flag = template_config.get("transaction_flag", global_flag)

        # Skip if disabled
        if not enabled:
            logger.debug(
                f"Skipping disabled custom template '{template_id}' for {month}"
            )
            continue

        # Resolve actual day
        actual_day = resolve_date(year, month_num, date_value)

        # Generate tid
        tid = f"{template_id}:{month}"

        # Create template
        template = create_custom_template(
            year=year,
            month=month_num,
            day=actual_day,
            payee=payee,
            narration=narration,
            posting_configs=posting_configs,
            tid=tid,
            flag=flag,
        )
        templates.append(template)

    logger.debug(f"Generated {len(templates)} custom templates for {month}")
    return templates


def generate_month_templates(
    config: Dict, month: str
) -> Dict[Path, List[TemplateTransaction]]:
    """
    Generate all forecast templates for a month, grouped by file.

    Args:
        config: Configuration dictionary
        month: Month in YYYY-MM format

    Returns:
        Dict mapping file Path to list of TemplateTransaction objects
    """
    year, month_num = map(int, month.split("-"))

    # Generate all templates
    salary_templates = generate_month_salary_templates(config, month)
    tesla_template = generate_month_tesla_template(config, month)
    custom_templates = generate_month_custom_templates(config, month)

    # Group templates by target file
    file_templates = defaultdict(list)

    # Add salary templates
    for template in salary_templates:
        # Extract account from first posting
        account = template.postings[0].account
        # Reverse lookup to get short name
        account_short = None
        for short_name, account_config in config["accounts"].items():
            if account_config["beancount_account"] == account:
                account_short = short_name
                break

        if account_short:
            file_path = get_account_file_path(config, account_short, year, month_num)
            file_templates[Path(file_path)].append(template)
        else:
            logger.warning(f"Could not find short name for account {account}")

    # Add Tesla loan template
    if tesla_template:
        td_file_path = get_account_file_path(config, "TD", year, month_num)
        file_templates[Path(td_file_path)].append(tesla_template)

    # Add custom templates
    for template in custom_templates:
        # Get template config to find target account
        template_id = template.tid.split(":")[0]  # Extract ID from tid

        # Find the template config
        template_config = None
        for t in config.get("custom_templates", []):
            if t["id"] == template_id and month in t.get("months", []):
                template_config = t
                break

        if template_config and "account" in template_config:
            target_account = template_config["account"]
            file_path = get_account_file_path(config, target_account, year, month_num)
            file_templates[Path(file_path)].append(template)
        else:
            logger.warning(
                f"Could not determine file path for custom template {template_id}"
            )

    logger.info(
        f"Generated {sum(len(t) for t in file_templates.values())} templates for {month} across {len(file_templates)} files"
    )
    return file_templates
