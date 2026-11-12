"""Merchant logos for snapshot rows: the web viewer's resolver, in Python.

The web app turns a transaction into a logo in ``apps/web/lib/merchants/``
(``resolve.ts``, ``match.ts``, ``patterns.ts``). This module follows the same
rules far enough to answer one question per row: which domain's logo, if any.

Inputs, all optional:

- ``DEFAULT_MERCHANTS``: the bundled universal brands, a copy of
  ``apps/web/lib/config/defaults/merchants.ts`` (a test keeps the two equal).
- ``$LEDGER_DIR/config/ui.yaml``: the user's ``merchants:`` (name -> domain,
  aliases) and ``accounts.logos`` (account path -> merchant name). Personal
  merchants live only there; nothing personal is built in.

A row gets a domain when the web would render a logo for it: the payee names
a registry merchant, or (transfers, card and loan payments, income) one of its
accounts maps to one. Investment rows and pure rebates show a glyph on the
web, so they get none here either.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

UI_CONFIG_FILENAME = "ui.yaml"
LOGO_SIZE_PLACEHOLDER = "{size}"
LOGO_DOMAIN_PLACEHOLDER = "{domain}"

# name, domain, aliases. Keep equal to apps/web/lib/config/defaults/merchants.ts.
DEFAULT_MERCHANTS: tuple[tuple[str, str | None, tuple[str, ...]], ...] = (
    ("Tesla", "tesla.com", ()),
    ("Uber", "uber.com", ()),
    ("Lyft", "lyft.com", ()),
    ("NJ Transit", "njtransit.com", ()),
    ("MTA", "mta.info", ()),
    ("JR East", "jreast.co.jp", ()),
    ("Suica", None, ()),
    ("Delta", "delta.com", ()),
    ("American Airlines", "aa.com", ()),
    ("Cathay Pacific", "cathaypacific.com", ()),
    ("Alaska Airlines", "alaskaair.com", ()),
    ("Costco", "costco.com", ()),
    ("Whole Foods", "wholefoodsmarket.com", ()),
    ("Trader Joe", "traderjoes.com", ()),
    ("Starbucks", "starbucks.com", ()),
    ("Blue Bottle Coffee", "bluebottlecoffee.com", ()),
    ("Doordash", "doordash.com", ()),
    ("Grubhub", "grubhub.com", ()),
    ("Netflix", "netflix.com", ()),
    ("Spotify", "spotify.com", ()),
    ("YouTube", "youtube.com", ()),
    ("Apple", "apple.com", ()),
    ("Google", "google.com", ()),
    ("Microsoft", "microsoft.com", ()),
    ("Adobe", "adobe.com", ()),
    ("Robinhood", "robinhood.com", ()),
    ("Chase", "chase.com", ()),
    ("Bank of America", "bankofamerica.com", ()),
    ("Discover", "discover.com", ()),
    ("Citi", "citi.com", ()),
    ("Wells Fargo", "wellsfargo.com", ()),
    ("Coinbase", "coinbase.com", ()),
    ("Webull", "webull.com", ()),
    ("American Express", "americanexpress.com", ()),
    ("Bilt", "biltrewards.com", ()),
    ("Con Edison", "coned.com", ("consolidated edison", "coned")),
    ("Verizon", "verizon.com", ("verizon wireless",)),
    ("T-Mobile", "t-mobile.com", ("tmobile",)),
    ("Optum", "optum.com", ()),
    ("CVS", "cvs.com", ()),
    ("PSEG", "pseg.com", ("public service",)),
    ("Amazon", "amazon.com", ()),
    ("Stripe", "stripe.com", ()),
    ("Alipay", "alipay.com", ()),
    ("Ticketmaster", "ticketmaster.com", ()),
    ("Zelle", "zellepay.com", ()),
    ("PayPal", "paypal.com", ()),
    ("Venmo", "venmo.com", ()),
)

# `<rail>*<merchant>`: the text after the separator is the brand (patterns.ts).
RAIL_PREFIXES = (
    "Sq *",
    "Sq*",
    "Tst*",
    "Pp*",
    "Py *",
    "Dd *",
    "Paypal *",
    "Paddle.Net*",
    "Paddle.Net *",
    "Apple Pay - ",
    "Google Pay - ",
    "ACH — ",
    "ACH - ",
)

_SUFFIX_STRIPS = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\s*apple\s*pay\s+ending\s+in\s+\d+\s*$",
        r"\s*(google|samsung)\s*pay\s+ending\s+in\s+\d+\s*$",
        r"\s+\d{3,4}-\d{3,4}-\d{4}.*$",  # phone numbers
        r"\s+\d{2,4}/\d{2}/\d{2,4}\s*$",  # dates
        r"\s+#\d+\s*$",  # terminal #1234
        r"\s+\d{5}(-\d{4})?\s*$",  # ZIP codes
        r"\s+[A-Z]{2}\s*$",  # trailing US state
    )
)

_TM = re.compile(r"^Tm \*", re.IGNORECASE)
_BRAND_STAR = re.compile(r"^([A-Za-z][A-Za-z0-9.&'-]{1,})\s?\*")
_TLD = re.compile(r"\.(com|net|org|us|co)$", re.IGNORECASE)
_ACH_DES = re.compile(
    r"\bDes:\s*([A-Za-z0-9 .&_-]+?)(?=\s+(?:Id:|Indn:|Tel:|$))", re.IGNORECASE
)
_ALNUM = re.compile(r"[a-z0-9]")
# Below this length a needle must match a whole word (match.ts SHORT_NEEDLE).
_SHORT_NEEDLE = 5


@dataclass(frozen=True)
class Merchant:
    name: str
    domain: str | None = None
    aliases: tuple[str, ...] = ()


@dataclass
class LogoResolver:
    """The merged merchant registry plus the account -> merchant table."""

    registry: dict[str, Merchant] = field(default_factory=dict)
    account_logos: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._lookup: dict[str, Merchant] = {}
        for m in self.registry.values():
            self._lookup[m.name.lower()] = m
            for alias in m.aliases:
                self._lookup[alias.lower()] = m
        self._cache: dict[str, Merchant | None] = {}

    # -- payee -> merchant (match.ts) --------------------------------------

    def match(self, payee: str | None) -> Merchant | None:
        if not payee:
            return None
        if payee not in self._cache:
            self._cache[payee] = self._match(payee)
        return self._cache[payee]

    def _match(self, payee: str) -> Merchant | None:
        name, token = _pattern(payee)
        if name and name in self.registry:
            return self.registry[name]
        if token and token in self._lookup:
            return self._lookup[token]
        cleaned = clean_payee(payee).lower()
        if not cleaned:
            return None
        if cleaned in self._lookup:
            return self._lookup[cleaned]
        best: tuple[str, Merchant] | None = None
        for needle, m in self._lookup.items():
            if not _contains_at_word_boundary(cleaned, needle):
                continue
            if best is None or len(needle) > len(best[0]):
                best = (needle, m)
        return best[1] if best else None

    # -- account -> merchant (accounts.ts lookupAccountLogo) ----------------

    def account(self, path: str) -> Merchant | None:
        cur = path
        while True:
            name = self.account_logos.get(cur)
            if name:
                return self.registry.get(name)
            if ":" not in cur:
                return None
            cur = cur.rsplit(":", 1)[0]

    # -- one row -----------------------------------------------------------

    def domain(
        self,
        payee: str | None,
        *,
        kind: str = "expense",
        accounts: tuple[str, ...] | list[str] = (),
        pure_rebate: bool = False,
    ) -> str | None:
        """Logo domain for one transaction, None when the web shows no logo.

        ``accounts`` are the posting accounts to fall back on when the payee
        names no merchant, most telling first (the category leg for income,
        the other side then the row's own account for a transfer).
        """
        if kind == "investment" or pure_rebate:
            return None
        hit = self.match(payee)
        if hit is None:
            for path in accounts:
                hit = self.account(path)
                if hit is not None:
                    break
        return hit.domain if hit is not None and hit.domain else None


def clean_payee(raw: str) -> str:
    """Strip banking-format noise so the residual can match a merchant name."""
    out = raw.strip()
    lower = out.lower()
    for p in RAIL_PREFIXES:
        if lower.startswith(p.lower()):
            out = out[len(p) :].strip()
            break
    for _ in _SUFFIX_STRIPS:
        before = out
        for pattern in _SUFFIX_STRIPS:
            out = pattern.sub("", out).strip()
        if out == before:
            break
    return out


def _pattern(payee: str) -> tuple[str | None, str | None]:
    """(merchant name, lookup token) from the payee-shape rules (patterns.ts)."""
    if _TM.match(payee):
        return "Ticketmaster", None
    m = _BRAND_STAR.match(payee)
    if m:
        lower = m.group(0).lower()
        if not any(lower.startswith(p.lower()) for p in RAIL_PREFIXES):
            token = _TLD.sub("", m.group(1).lower()).strip()
            if token:
                return None, token
    m = _ACH_DES.search(payee)
    if m:
        token = re.sub(r"[\s.]+", " ", m.group(1).lower().strip())
        if token:
            return None, token
    return None, None


def _contains_at_word_boundary(haystack: str, needle: str) -> bool:
    """``needle in haystack`` where the hit starts on a word boundary; a short
    needle must also end on one."""
    if not needle:
        return False
    strict = len(needle) < _SHORT_NEEDLE
    start = 0
    while True:
        i = haystack.find(needle, start)
        if i < 0:
            return False
        if i == 0 or not _ALNUM.match(haystack[i - 1]):
            if not strict:
                return True
            after = haystack[i + len(needle) : i + len(needle) + 1]
            if not after or not _ALNUM.match(after):
                return True
        start = i + 1


def build_resolver(ui_config: Any = None) -> LogoResolver:
    """Bundled defaults merged with a parsed ui.yaml (user entries win)."""
    registry = {
        name: Merchant(name, domain, aliases)
        for name, domain, aliases in DEFAULT_MERCHANTS
    }
    doc = ui_config if isinstance(ui_config, dict) else {}
    user = doc.get("merchants")
    if isinstance(user, dict):
        for name, fields in user.items():
            fields = fields if isinstance(fields, dict) else {}
            existing = registry.get(str(name))
            domain = fields.get("domain")
            aliases = fields.get("aliases")
            registry[str(name)] = Merchant(
                str(name),
                str(domain)
                if isinstance(domain, str) and domain
                else (existing.domain if existing else None),
                tuple(str(a) for a in aliases)
                if isinstance(aliases, list) and aliases
                else (existing.aliases if existing else ()),
            )
    accounts = doc.get("accounts")
    logos = accounts.get("logos") if isinstance(accounts, dict) else None
    return LogoResolver(
        registry,
        {str(k): str(v) for k, v in logos.items()} if isinstance(logos, dict) else {},
    )


def load_resolver(ui_config_path: Path | str | None) -> LogoResolver:
    """Resolver for a ledger's ``config/ui.yaml``. A missing or unreadable
    file leaves the bundled defaults."""
    doc = None
    if ui_config_path is not None:
        try:
            with Path(ui_config_path).open(encoding="utf-8") as f:
                doc = yaml.safe_load(f)
        except (OSError, yaml.YAMLError):
            doc = None
    return build_resolver(doc)


def url_template(token: str | None) -> str | None:
    """logo.dev image URL with ``{domain}`` and ``{size}`` left to fill in.
    None without a publishable token. The web viewer builds the same URL in
    ``apps/web/lib/merchants/logodev.ts`` (it asks for webp; PNG decodes
    everywhere)."""
    if not token:
        return None
    return (
        f"https://img.logo.dev/{LOGO_DOMAIN_PLACEHOLDER}?token={token}"
        f"&size={LOGO_SIZE_PLACEHOLDER}&format=png&retina=true"
    )
