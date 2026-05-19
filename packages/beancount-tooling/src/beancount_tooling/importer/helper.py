import sys
import time
import questionary
from questionary import Style


def cls():
    pass
    # os.system('cls' if os.name=='nt' else 'clear')


# Custom style for questionary prompts - beautiful purple/blue theme
custom_style = Style(
    [
        ("qmark", "fg:#5f87ff bold"),  # Cyan question mark
        ("question", "fg:#ffffff bold"),  # White question text
        ("answer", "fg:#5fff5f bold"),  # Green selected answer
        ("pointer", "fg:#ff87d7 bold"),  # Pink pointer
        ("highlighted", "fg:#5f87ff bold"),  # Cyan highlighted choice
        ("selected", "fg:#5f87ff"),  # Cyan selected
        ("separator", "fg:#6c6c6c"),  # Gray separator
        ("instruction", "fg:#9e9e9e"),  # Gray instructions
        ("text", "fg:#ffffff"),  # White text
        ("disabled", "fg:#6c6c6c italic"),  # Gray disabled
    ]
)


def prompt_user_select(trans_desc: str, info: list, all_accounts: list = []) -> str:
    """
    Prompt user to select an account with fuzzy search and pretty UI.

    Args:
        trans_desc: Transaction description
        info: Additional transaction info to display
        categories: Expense categories (for backward compatibility - not used)
        all_accounts: All available USD accounts to choose from

    Returns:
        The selected account name (full path)
    """
    cls()

    # Non-interactive fallback: return Equity:FIXME when stdin is not a terminal.
    # Equity:FIXME is the canonical un-determined-leg placeholder — neutral about
    # the eventual category, so the reconciler resolves it on its own without
    # being nudged toward "this should be an expense".
    if not sys.stdin.isatty():
        print(f"[non-interactive] Defaulting to Equity:FIXME for: {trans_desc}")
        return "Equity:FIXME"

    # Print beautiful transaction info box
    box_width = 80
    print()
    print("┌" + "─" * (box_width - 2) + "┐")
    print(f"│ {'TRANSACTION DETAILS':<{box_width - 4}} │")
    print("├" + "─" * (box_width - 2) + "┤")
    print(
        f"│ \033[1m{trans_desc[: box_width - 6]}\033[0m{' ' * max(0, box_width - 6 - len(trans_desc))} │"
    )
    print("├" + "─" * (box_width - 2) + "┤")

    for line in info:
        line_str = str(line)[: box_width - 6]
        print(f"│  {line_str:<{box_width - 6}} │")

    print("└" + "─" * (box_width - 2) + "┘")
    print()

    # Sort accounts by category for better UX
    # Priority: Expenses, Income, Assets, Liabilities, then others
    def account_sort_key(account):
        if account == "Equity:FIXME":
            return (5, account)  # FIXME at the end
        elif account.startswith("Expenses:"):
            return (0, account)
        elif account.startswith("Income:"):
            return (1, account)
        elif account.startswith("Assets:"):
            return (2, account)
        elif account.startswith("Liabilities:"):
            return (3, account)
        else:
            return (4, account)

    sorted_accounts = sorted(all_accounts, key=account_sort_key)

    # Create the autocomplete selection with fuzzy matching
    selected = questionary.autocomplete(
        "🔍 Select account (type to filter, ↑↓ to navigate, Enter to confirm):",
        choices=sorted_accounts,
        style=custom_style,
        match_middle=True,  # Enable fuzzy matching in the middle of words
        qmark="",
    ).ask()

    if not selected:
        # User cancelled (Ctrl+C)
        raise KeyboardInterrupt("Selection cancelled")

    # Show confirmation with a nice checkmark
    cls()
    print()
    print("┌" + "─" * (box_width - 2) + "┐")
    print(
        f"│ \033[92m✓\033[0m \033[1m{trans_desc[: box_width - 8]}\033[0m{' ' * max(0, box_width - 8 - len(trans_desc))} │"
    )
    print("├" + "─" * (box_width - 2) + "┤")
    print(f"│  → {selected[: box_width - 8]:<{box_width - 8}} │")
    print("└" + "─" * (box_width - 2) + "┘")
    print()
    time.sleep(0.3)

    return selected


def hash_string(s, prefix=""):
    hash_value = 0
    for char in s:
        hash_value = (hash_value * 31 + ord(char)) % (10**9 + 9)
    # print(f"hashing {s} -> {hash_value}")
    return prefix + str(hash_value)
