"""Merchant payee normalization: one canonical payee per merchant.

The alias map lives in the ledger working copy at
``$LEDGER_DIR/config/merchants.yaml`` (see ``merchants.example.yaml`` beside
this module for the schema). It is read lazily on first use and cached. A
missing file is an empty map, so every descriptor falls through to the
importer's own cleaned payee and nothing changes for users without one.

Schema::

    merchants:
      "<Canonical>":
        aliases: ["<exact historical payee>", ...]
        details: {"<alias>": "<narration detail>"}
        rules:                      # Python regex, case-insensitive re.search
          - "<pattern>"
          - {pattern: "<pattern>", detail: "{city}"}   # template over named groups
        priority: 10                # higher is tried first (default 0)
        category: "Expenses:..."    # informational only
    ambiguous:
      "<payee>": {candidates: ["<Canonical>", ...], note: "..."}
    non_merchant: ["<exact payee>", ...]
    non_merchant_patterns: ["<regex on the raw descriptor>", ...]
    scope:                          # optional; which entries normalize-payees may rename
      accounts: ["Expenses", ...]   # roots: an entry posting under one is in scope
      gift_cards: ["Assets:..."]    # roots: a funded purchase into one is in scope
      exclude_files: ["**/x.bean"]  # globs, relative to the journal directory

Resolution order in :func:`normalize` (first hit wins):

1. Guard: an exact ``non_merchant`` payee, or a ``non_merchant_patterns`` match
   on the raw descriptor, returns ``is_merchant=False`` with the payee unchanged.
2. Exact alias (case-sensitive) on the raw descriptor or the importer's legacy
   payee. Every canonical name is an alias of itself, so reruns are idempotent.
   A payee listed under ``ambiguous`` is never resolved here.
3. Ambiguous payees resolve only through a rule hit on richer text: the raw
   descriptor when it differs from the payee, plus ``extra`` values (narration,
   ``raw:``, Amex ``Extended Details``, ...). Hits are limited to the
   payee's ``candidates``.
4. Rules, by descending ``priority`` then file order, on the raw descriptor and
   then the legacy payee, after stripping a leading ``AplPay `` and a Robinhood
   ``Refund: `` prefix (which turns into the narration detail ``Refund``) and a
   trailing Discover ``APPLE PAY ENDING IN nnnn``.
5. Fallback: the legacy payee, flagged ``unmapped``. The normalizer never
   invents a name.

When an alias or rule (steps 2 and 4) gives no detail, the same merchant's
rules are tried line by line on the ``extra`` columns (Amex Extended Details
holds the delivery store that the Description cuts off).

``normalize`` is pure: it never mutates its inputs.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from titlecase import titlecase

from beancount_tooling.paths import get_config_dir

CONFIG_FILENAME = "merchants.yaml"

SOURCE_GUARD = "guard"
SOURCE_ALIAS = "alias"
SOURCE_RULE = "rule"
SOURCE_FALLBACK = "fallback"

STATUS_MAPPED = "mapped"
STATUS_UNMAPPED = "unmapped"
STATUS_NON_MERCHANT = "non_merchant"

REFUND_DETAIL = "Refund"

# Without a `scope:` section, normalize-payees only renames expense entries.
DEFAULT_SCOPE_ACCOUNTS = ("Expenses",)
_SCOPE_KEYS = {"accounts", "gift_cards", "exclude_files"}

_APLPAY_PREFIX = re.compile(r"^\s*aplpay\s+", re.IGNORECASE)
_REFUND_PREFIX = re.compile(r"^\s*refund:\s*", re.IGNORECASE)
# Discover glues the wallet onto the descriptor: "...NJAPPLE PAY ENDING IN 1234".
_WALLET_SUFFIX = re.compile(r"\s*APPLE PAY ENDING IN \d+\s*$", re.IGNORECASE)


class MerchantConfigError(ValueError):
    """merchants.yaml is malformed: bad regex, duplicate key or alias clash."""


@dataclass(frozen=True)
class Merchant:
    """Result of :func:`normalize`.

    ``payee`` is the payee to book. ``detail`` is the narration to use when
    the entry has none. ``source`` says which step decided it.
    """

    payee: str
    detail: str = ""
    is_merchant: bool = True
    source: str = SOURCE_FALLBACK
    rule_id: str | None = None
    ambiguous: bool = False

    @property
    def status(self) -> str:
        if not self.is_merchant:
            return STATUS_NON_MERCHANT
        if self.source == SOURCE_FALLBACK:
            return STATUS_UNMAPPED
        return STATUS_MAPPED

    @property
    def mapped(self) -> bool:
        return self.status == STATUS_MAPPED


@dataclass(frozen=True)
class Rule:
    canonical: str
    pattern: re.Pattern[str]
    detail: str | None
    priority: int
    rule_id: str


@dataclass(frozen=True)
class MerchantConfig:
    canonicals: tuple[str, ...] = ()
    aliases: Mapping[str, str] = field(default_factory=dict)
    details: Mapping[str, str] = field(default_factory=dict)
    rules: tuple[Rule, ...] = ()
    ambiguous: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    non_merchant: frozenset[str] = frozenset()
    non_merchant_patterns: tuple[re.Pattern[str], ...] = ()
    scope_accounts: tuple[str, ...] = DEFAULT_SCOPE_ACCOUNTS
    gift_card_accounts: tuple[str, ...] = ()
    exclude_files: tuple[str, ...] = ()
    path: Path | None = None

    @property
    def empty(self) -> bool:
        return not (self.aliases or self.rules or self.non_merchant)


EMPTY_CONFIG = MerchantConfig()


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


class _UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader that rejects duplicate mapping keys (PyYAML keeps the last)."""


def _construct_unique_mapping(loader, node, deep=False):
    seen: set[Any] = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise MerchantConfigError(
                f"duplicate key {key!r} (line {key_node.start_mark.line + 1})"
            )
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


def _compile(pattern: Any, where: str) -> re.Pattern[str]:
    if not isinstance(pattern, str) or not pattern:
        raise MerchantConfigError(f"{where}: pattern must be a non-empty string")
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise MerchantConfigError(f"{where}: bad regex {pattern!r}: {e}") from e


def _str_list(value: Any, where: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise MerchantConfigError(f"{where}: expected a list of strings")
    return value


def parse_config(raw: Any, path: Path | None = None) -> MerchantConfig:
    """Validate a parsed merchants.yaml document and build the lookup tables."""
    if raw is None:
        return MerchantConfig(path=path)
    if not isinstance(raw, dict):
        raise MerchantConfigError("top level must be a mapping")

    merchants = raw.get("merchants") or {}
    if not isinstance(merchants, dict):
        raise MerchantConfigError("merchants: expected a mapping")

    aliases: dict[str, str] = {}
    details: dict[str, str] = {}
    rules: list[tuple[int, int, Rule]] = []

    def add_alias(alias: str, canonical: str) -> None:
        owner = aliases.get(alias)
        if owner is not None and owner != canonical:
            raise MerchantConfigError(
                f"alias {alias!r} maps to both {owner!r} and {canonical!r}"
            )
        aliases[alias] = canonical

    # Canonical names first, so an explicit alias equal to another merchant's
    # name is reported as a clash whichever order they appear in.
    for canonical in merchants:
        if not isinstance(canonical, str) or not canonical:
            raise MerchantConfigError(f"merchant key {canonical!r} is not a string")
        add_alias(canonical, canonical)

    order = 0
    for canonical, spec in merchants.items():
        spec = spec or {}
        if not isinstance(spec, dict):
            raise MerchantConfigError(f"{canonical}: expected a mapping")
        for alias in _str_list(spec.get("aliases"), f"{canonical}.aliases"):
            add_alias(alias, canonical)
        spec_details = spec.get("details") or {}
        if not isinstance(spec_details, dict):
            raise MerchantConfigError(f"{canonical}.details: expected a mapping")
        for key, detail in spec_details.items():
            if aliases.get(key) != canonical:
                raise MerchantConfigError(
                    f"{canonical}.details: {key!r} is not an alias of {canonical!r}"
                )
            details[key] = "" if detail is None else str(detail)
        try:
            priority = int(spec.get("priority") or 0)
        except (TypeError, ValueError) as e:
            raise MerchantConfigError(f"{canonical}.priority: not an integer") from e
        for i, rule in enumerate(spec.get("rules") or []):
            where = f"{canonical}.rules[{i}]"
            if isinstance(rule, dict):
                pattern, detail = rule.get("pattern"), rule.get("detail")
                if detail is not None and not isinstance(detail, str):
                    raise MerchantConfigError(f"{where}.detail: expected a string")
            else:
                pattern, detail = rule, None
            compiled = _compile(pattern, where)
            rules.append(
                (
                    -priority,
                    order,
                    Rule(canonical, compiled, detail, priority, f"{canonical}#{i}"),
                )
            )
            order += 1

    ambiguous: dict[str, tuple[str, ...]] = {}
    for payee, spec in (raw.get("ambiguous") or {}).items():
        spec = spec or {}
        if not isinstance(spec, dict):
            raise MerchantConfigError(f"ambiguous.{payee}: expected a mapping")
        candidates = _str_list(spec.get("candidates"), f"ambiguous.{payee}.candidates")
        for c in candidates:
            if c not in merchants:
                raise MerchantConfigError(
                    f"ambiguous.{payee}: candidate {c!r} is not a merchant"
                )
        ambiguous[payee] = tuple(candidates)

    non_merchant = frozenset(_str_list(raw.get("non_merchant"), "non_merchant"))
    patterns = tuple(
        _compile(p, f"non_merchant_patterns[{i}]")
        for i, p in enumerate(
            _str_list(raw.get("non_merchant_patterns"), "non_merchant_patterns")
        )
    )

    scope = raw.get("scope") or {}
    if not isinstance(scope, dict):
        raise MerchantConfigError("scope: expected a mapping")
    unknown = set(scope) - _SCOPE_KEYS
    if unknown:
        raise MerchantConfigError(f"scope: unknown key(s) {sorted(unknown)}")
    scope_accounts = tuple(
        a.rstrip(":") for a in _str_list(scope.get("accounts"), "scope.accounts")
    )
    gift_cards = tuple(
        a.rstrip(":") for a in _str_list(scope.get("gift_cards"), "scope.gift_cards")
    )
    exclude_files = tuple(_str_list(scope.get("exclude_files"), "scope.exclude_files"))

    rules.sort(key=lambda r: (r[0], r[1]))
    return MerchantConfig(
        canonicals=tuple(merchants),
        aliases=aliases,
        details=details,
        rules=tuple(r for _, _, r in rules),
        ambiguous=ambiguous,
        non_merchant=non_merchant,
        non_merchant_patterns=patterns,
        scope_accounts=scope_accounts or DEFAULT_SCOPE_ACCOUNTS,
        gift_card_accounts=gift_cards,
        exclude_files=exclude_files,
        path=path,
    )


def load_config(path: Path | str) -> MerchantConfig:
    """Read and validate one merchants.yaml. A missing file is an empty map."""
    path = Path(path)
    if not path.is_file():
        return MerchantConfig(path=path)
    try:
        with path.open(encoding="utf-8") as f:
            raw = yaml.load(f, Loader=_UniqueKeyLoader)
    except MerchantConfigError as e:
        raise MerchantConfigError(f"{path}: {e}") from e
    except yaml.YAMLError as e:
        raise MerchantConfigError(f"{path}: invalid YAML: {e}") from e
    try:
        return parse_config(raw, path)
    except MerchantConfigError as e:
        raise MerchantConfigError(f"{path}: {e}") from e


_cached: MerchantConfig | None = None


def get_config() -> MerchantConfig:
    """The ledger's merchant map, loaded on first use and cached."""
    global _cached
    if _cached is None:
        _cached = load_config(get_config_dir() / CONFIG_FILENAME)
    return _cached


def set_config(config: MerchantConfig | Path | str | None) -> None:
    """Replace the cached map (tests, tools). ``None`` re-reads on next use."""
    global _cached
    if config is None or isinstance(config, MerchantConfig):
        _cached = config
    else:
        _cached = load_config(config)


# ---------------------------------------------------------------------------
# Normalizing
# ---------------------------------------------------------------------------


def _strip_prefixes(text: str) -> tuple[str, bool]:
    """Drop a leading 'AplPay ' and 'Refund: ' (either order) and a trailing
    Discover 'APPLE PAY ENDING IN nnnn'. Returns the stripped text and whether
    a refund prefix was present."""
    refund = False
    while True:
        if m := _APLPAY_PREFIX.match(text):
            text = text[m.end() :]
            continue
        if m := _REFUND_PREFIX.match(text):
            text = text[m.end() :]
            refund = True
            continue
        return _WALLET_SUFFIX.sub("", text).strip(), refund


def _tidy(value: str) -> str:
    value = " ".join(value.split())
    # Bank descriptors are upper case; "NEW YORK" reads as "New York".
    if value.isupper():
        value = titlecase(value.lower())
    return value


class _GroupDict(dict):
    def __missing__(self, key: str) -> str:
        return ""


def _render_detail(rule: Rule, match: re.Match[str]) -> str:
    if not rule.detail:
        return ""
    groups = _GroupDict(
        {k: _tidy(v) for k, v in match.groupdict().items() if v is not None}
    )
    try:
        rendered = rule.detail.format_map(groups)
    except (ValueError, IndexError, KeyError):
        rendered = rule.detail
    return " ".join(rendered.split())


def _first_rule_hit(
    config: MerchantConfig,
    texts: list[str],
    candidates: tuple[str, ...] | None = None,
) -> tuple[Rule, re.Match[str]] | None:
    for text in texts:
        if not text:
            continue
        for rule in config.rules:
            if candidates is not None and rule.canonical not in candidates:
                continue
            if m := rule.pattern.search(text):
                return rule, m
    return None


def _detail_from_extra(
    config: MerchantConfig, canonical: str, extra: Mapping[str, str] | None
) -> str:
    """The first non-empty detail a rule of ``canonical`` renders on one line
    of the extra columns. Amex keeps the delivery store in Extended Details
    ('DD *DOORDASH DEMOMART') while the Description is cut short."""
    for value in (extra or {}).values():
        for line in (value or "").splitlines():
            text, _ = _strip_prefixes(line)
            if not text:
                continue
            for rule in config.rules:
                if rule.canonical != canonical or not rule.detail:
                    continue
                if (m := rule.pattern.search(text)) and (
                    detail := _render_detail(rule, m)
                ):
                    return detail
    return ""


def _with_refund(detail: str, refund: bool) -> str:
    if not refund or detail.casefold().startswith(REFUND_DETAIL.casefold()):
        return detail
    return f"{REFUND_DETAIL}: {detail}" if detail else REFUND_DETAIL


def _unique(items: list[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item and item not in out:
            out.append(item)
    return out


def normalize(
    raw: str,
    legacy_payee: str | None = None,
    *,
    extra: Mapping[str, str] | None = None,
    config: MerchantConfig | None = None,
) -> Merchant:
    """Canonical payee for one transaction.

    ``raw`` is the untouched bank descriptor (or, for migrated history, the
    current payee). ``legacy_payee`` is the payee the importer would book
    today (titlecased / cleaned); it defaults to ``raw``. ``extra`` carries
    other text for ambiguous payees (narration, ``raw:``, extra CSV columns).
    """
    config = get_config() if config is None else config
    raw = raw or ""
    legacy = raw if legacy_payee is None else legacy_payee
    fallback_payee = legacy or raw

    # 1. Guard.
    stripped_raw, refund_raw = _strip_prefixes(raw)
    stripped_legacy, refund_legacy = _strip_prefixes(legacy)
    refund = refund_raw or refund_legacy
    if raw in config.non_merchant or legacy in config.non_merchant:
        return Merchant(fallback_payee, is_merchant=False, source=SOURCE_GUARD)
    for pattern in config.non_merchant_patterns:
        if any(pattern.search(t) for t in _unique([raw, stripped_raw])):
            return Merchant(fallback_payee, is_merchant=False, source=SOURCE_GUARD)

    keys = _unique([raw, legacy, stripped_raw, stripped_legacy])
    ambiguous_key = next((k for k in keys if k in config.ambiguous), None)

    # 2. Exact alias (ambiguous payees excluded).
    for key in keys:
        if key in config.ambiguous:
            continue
        canonical = config.aliases.get(key)
        if canonical is not None:
            detail = config.details.get(key, "") or _detail_from_extra(
                config, canonical, extra
            )
            return Merchant(
                canonical, _with_refund(detail, refund), source=SOURCE_ALIAS
            )

    # 3. Ambiguous: only richer text than the payee itself may resolve it.
    if ambiguous_key is not None:
        candidates = config.ambiguous[ambiguous_key] or None
        texts = [stripped_raw] + [
            _strip_prefixes(v)[0] for v in (extra or {}).values() if v
        ]
        texts = [t for t in _unique(texts) if t.casefold() != ambiguous_key.casefold()]
        hit = _first_rule_hit(config, texts, candidates)
        if hit is None:
            return Merchant(
                fallback_payee,
                _with_refund("", refund),
                source=SOURCE_FALLBACK,
                ambiguous=True,
            )
        rule, m = hit
        return Merchant(
            rule.canonical,
            _with_refund(_render_detail(rule, m), refund),
            source=SOURCE_RULE,
            rule_id=rule.rule_id,
            ambiguous=True,
        )

    # 4. Rules.
    hit = _first_rule_hit(config, _unique([stripped_raw, stripped_legacy]))
    if hit is not None:
        rule, m = hit
        detail = _render_detail(rule, m) or _detail_from_extra(
            config, rule.canonical, extra
        )
        return Merchant(
            rule.canonical,
            _with_refund(detail, refund),
            source=SOURCE_RULE,
            rule_id=rule.rule_id,
        )

    # 5. Fallback.
    return Merchant(fallback_payee, _with_refund("", refund), source=SOURCE_FALLBACK)


# ---------------------------------------------------------------------------
# Learned routing
# ---------------------------------------------------------------------------


def pick_merchant_accounts(rows: Iterable[tuple[Any, str, str]]) -> dict[str, str]:
    """payee -> account from (date, payee, account) rows: the account a payee
    was booked to most often, ties going to the most recently used one.

    Last-wins would let one odd row (a TV bought at a grocery chain) decide
    the route for every row once payee variants collapse into one canonical
    payee."""
    counts = defaultdict(Counter)
    last_seen: dict[tuple[str, str], Any] = {}
    for date, payee, account in rows:
        if not payee:
            continue
        counts[payee][account] += 1
        key = (payee, account)
        if key not in last_seen or date >= last_seen[key]:
            last_seen[key] = date
    return {
        payee: max(
            by_account,
            key=lambda account: (by_account[account], last_seen[(payee, account)]),
        )
        for payee, by_account in counts.items()
    }


EXPENSE_ROOT = "Expenses"


def _is_expense(account: str) -> bool:
    return account == EXPENSE_ROOT or account.startswith(EXPENSE_ROOT + ":")


class MerchantRoutes(dict):
    """payee -> learned account, as built by :func:`learn_merchant_routes`.

    A value of ``None`` means the payee is known but its usual destination is
    not an expense (a gift-card or reimbursable purchase): the importer must
    not route it on its own. ``mixed`` holds the payees booked to both kinds;
    for those, ``variants`` (raw descriptor or pre-normalization payee, from
    ``raw:``) -> account is consulted first, because the descriptor variant
    often tells the two apart (a web store selling gift cards vs a warehouse).
    """

    def __init__(self, routes=(), *, variants=None, mixed=()):
        super().__init__(routes)
        self.variants: dict[str, str | None] = dict(variants or {})
        self.mixed: frozenset[str] = frozenset(mixed)


def learn_merchant_routes(
    rows: Iterable[tuple[Any, str, str | None, str]],
) -> MerchantRoutes:
    """Routing from (date, payee, desc, account) rows, one per destination
    posting: every ``Expenses`` posting, plus purchases into the other in-scope
    roots (gift cards, reimbursable receivables).

    Each payee goes to its most frequent account (:func:`pick_merchant_accounts`);
    a non-expense winner becomes ``None`` so the row is prompted or left as
    ``Equity:FIXME`` instead of being booked to an expense in silence."""
    rows = [r for r in rows if r[1]]
    kinds: dict[str, set[bool]] = defaultdict(set)
    for _, payee, _, account in rows:
        kinds[payee].add(_is_expense(account))
    mixed = {payee for payee, k in kinds.items() if len(k) == 2}

    def routable(picked: dict[str, str]) -> dict[str, str | None]:
        return {k: (v if _is_expense(v) else None) for k, v in picked.items()}

    routes = routable(pick_merchant_accounts((d, p, a) for d, p, _, a in rows))
    variants = routable(
        pick_merchant_accounts(
            (d, desc, a) for d, p, desc, a in rows if p in mixed and desc
        )
    )
    return MerchantRoutes(routes, variants=variants, mixed=mixed)
