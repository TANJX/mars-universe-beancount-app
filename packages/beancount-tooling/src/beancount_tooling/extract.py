import os
import collections
import re
import sys
import yaml
from pathlib import Path
from beancount.parser import printer
from beangulp import extract, identify
from beancount import loader
from beanquery import query
from beangulp.utils import walk

from beancount_tooling.paths import (
    get_config_dir,
    get_journal_file,
    get_statements_dir,
    get_transactions_dir,
)
from beancount_tooling.importer.amex import AmexImporter
from beancount_tooling.importer.bofa_checking import BofACheckingImporter
from beancount_tooling.importer.discover import DiscoverImporter
from beancount_tooling.importer.chase import ChaseImporter
from beancount_tooling.importer.chase_checking import ChaseCheckingImporter
from beancount_tooling.importer.bofa import BofAImporter
from beancount_tooling.importer.bilt import BiltImporter
from beancount_tooling.importer.apple import AppleImporter
from beancount_tooling.importer.apple_saving import AppleSavingImporter
from beancount_tooling.importer.discover_saving import DiscoverSavingImporter
from beancount_tooling.importer.wells_fargo_checking import WellsFargoCheckingImporter
from beancount_tooling.importer.td_checking import TDCheckingImporter
from beancount_tooling.importer.robinhood import RobinhoodImporter


def load_config():
    config_path = get_config_dir() / "extract.yaml"
    if not config_path.is_file():
        sys.exit(
            f"extract config not found at {config_path}. "
            "Set LEDGER_DIR to point at a ledger working copy with config/extract.yaml."
        )
    with config_path.open("r") as f:
        return yaml.safe_load(f)


CONFIG = load_config()

BANKS = list(set(account["bank"] for account in CONFIG["accounts"]))

main_journal_path = str(get_journal_file())


def read_all_usd_accounts():
    """Read all accounts that have USD currency from the ledger"""
    entries, _, options_map = loader.load_file(main_journal_path)

    # Query all accounts that have USD transactions and isn't Equity account
    _, rrows = query.run_query(
        entries,
        options_map,
        'select distinct account where currency = "USD" and account !~ "Equity"',
    )

    # Extract account names
    accounts = [row[0] for row in rrows]

    # Filter out excluded accounts based on config patterns
    excluded_patterns = CONFIG.get("importers", {}).get("excluded_accounts", [])
    if excluded_patterns:
        import re

        filtered_accounts = []
        for account in accounts:
            # Check if account matches any exclusion pattern
            is_excluded = False
            for pattern in excluded_patterns:
                if re.search(pattern, account):
                    is_excluded = True
                    break
            if not is_excluded:
                filtered_accounts.append(account)
        accounts = filtered_accounts

    # Sort accounts
    accounts = sorted(accounts)

    # Add Equity:FIXME as the un-determined-leg placeholder. Picking this in
    # the interactive prompt produces a valid beancount account (bare "FIXME"
    # would fail to load) and matches the non-interactive fallback in helper.py.
    accounts.append("Equity:FIXME")

    return accounts


def read_merchant_map():
    """Read existing merchant to account mappings from the journal"""
    merchant_map = dict()

    entries, _, options_map = loader.load_file(main_journal_path)
    _, rrows = query.run_query(
        entries, options_map, 'select payee, account where account ~ "Expense"'
    )
    for row in rrows:
        merchant_map[row[0]] = row[1]  # Store full account path
    return merchant_map


def build_importer(
    account_config, bank_refs, merchant_map, all_accounts, payment_account
):
    """Build an importer instance from config"""
    importer_class = account_config["importer"]
    bank = account_config["bank"]
    account_type, card_name = account_config["path"].split("/")
    options = account_config.get("options", {})

    # Get the importer class by name
    importer_classes = {
        "AmexImporter": AmexImporter,
        "BofACheckingImporter": BofACheckingImporter,
        "DiscoverImporter": DiscoverImporter,
        "ChaseImporter": ChaseImporter,
        "ChaseCheckingImporter": ChaseCheckingImporter,
        "BofAImporter": BofAImporter,
        "BiltImporter": BiltImporter,
        "AppleImporter": AppleImporter,
        "AppleSavingImporter": AppleSavingImporter,
        "DiscoverSavingImporter": DiscoverSavingImporter,
        "WellsFargoCheckingImporter": WellsFargoCheckingImporter,
        "TDCheckingImporter": TDCheckingImporter,
        "RobinhoodImporter": RobinhoodImporter,
    }

    importer_cls = importer_classes[importer_class]

    # Build kwargs for importer
    kwargs = {"existing_refs": bank_refs.get(bank, [])}

    # Add options if present
    if options:
        kwargs.update(options)

    # Credit card importers need additional parameters
    if account_type == "credit":
        kwargs["payment_account"] = payment_account
        kwargs["merchant_map"] = merchant_map
        kwargs["merchant_patterns"] = (
            CONFIG["categorization"].get("merchant_patterns") or []
        )
        kwargs["all_accounts"] = all_accounts

    # First positional argument is card_name
    return importer_cls(card_name, **kwargs)


def read_all_ref():
    # list all files in journal folder recursively
    journal_path = os.path.dirname(main_journal_path)
    # init all bank ref
    bank_refs = dict()
    for bank in BANKS:
        bank_refs[bank] = []
    for dirpath, _, filenames in os.walk(journal_path):
        for file in filter(lambda x: x.endswith(".bean"), filenames):
            # Example:
            #   Liabilities:Credit:Amex-Gold  -11.98 USD
            #     ref: "320233450046771733"
            lines_pair = list(enumerate(open(os.path.join(dirpath, file))))
            refs_pair = list(
                filter(lambda x: re.match(r'^ +ref: "\d+[a-z]*"\s*$', x[1]), lines_pair)
            )
            refs_lines = list(map(lambda x: re.findall(r"\d+", x[1])[0], refs_pair))
            # find all lines number with ref - 1
            bank_lines = list(map(lambda x: lines_pair[x[0] - 1][1], refs_pair))
            for i, bank_line in enumerate(bank_lines):
                for bank in BANKS:
                    if bank in bank_line:
                        if refs_lines[i] in bank_refs[bank]:
                            pass
                            # print(f"{refs_lines[i]} has duplicates!")
                        bank_refs[bank].append(refs_lines[i])
    return bank_refs


def main():
    # Load data from journal
    bank_refs = read_all_ref()
    merchant_map = read_merchant_map()
    all_accounts = read_all_usd_accounts()
    entries = loader.load_file(main_journal_path)[0]

    output_path = str(get_transactions_dir())
    data_dir = str(get_statements_dir())

    # Get payment account from config
    payment_account = CONFIG["categorization"]["payment_account"]

    # Build ALL_ACCOUNTS from config
    ALL_ACCOUNTS = []
    for account_config in CONFIG["accounts"]:
        account_type, card_name = account_config["path"].split("/")
        importer = build_importer(
            account_config, bank_refs, merchant_map, all_accounts, payment_account
        )

        ALL_ACCOUNTS.append(
            {
                "type": account_type,
                "name": card_name,
                "importer": importer,
            }
        )

    # Track statistics for delta reporting
    account_stats = []
    total_entries = 0

    # Process each account
    for account in ALL_ACCOUNTS:
        # print(f"Importing {account['type']} {account['name']}")

        month_dict = collections.defaultdict(list)

        # Run all the importers and gather their result sets.
        new_entries_list = []
        # iterate over all files in data_dir
        for filename in walk([os.path.realpath(data_dir)]):
            importer = identify.identify([account["importer"]], filename)
            if importer:
                new_entries_list.extend(
                    extract.extract_from_file(importer, filename, entries)
                )

        for transaction in new_entries_list:
            month = transaction.date.strftime("%Y-%m")
            month_dict[month].append(printer.format_entry(transaction) + "\n")

        # Track statistics for this account
        account_entry_count = len(new_entries_list)
        if account_entry_count > 0:
            month_breakdown = {
                month: len(entries) for month, entries in month_dict.items()
            }
            account_stats.append(
                {
                    "name": account["name"],
                    "type": account["type"],
                    "total": account_entry_count,
                    "months": month_breakdown,
                }
            )
            total_entries += account_entry_count

        # append to main journal
        for month in month_dict:
            lines = month_dict[month]
            account_journal_path = f"{output_path}/{month}/{account['type']}"
            Path(account_journal_path).mkdir(parents=True, exist_ok=True)

            f = open(f"{account_journal_path}/{account['name']}.bean", "a")
            f.writelines(lines)
            f.close()

    # Print summary of extracted entries
    if total_entries > 0:
        print("\n" + "=" * 50)
        print("EXTRACTION SUMMARY")
        print("=" * 50)
        for stat in account_stats:
            print(f"\n{stat['name']}: {stat['total']} entries added")
            for month in sorted(stat["months"].keys()):
                print(f"  {month}: {stat['months'][month]} entries")
        print("\n" + "-" * 50)
        print(f"Total: {total_entries} entries added")
        print("=" * 50 + "\n")
    else:
        print("\nNo new entries found.\n")


if __name__ == "__main__":
    main()
