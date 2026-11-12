"""Display names for payees: read-time cleanup of raw bank text.

The ledger keeps the payee its importer extracted. For merchant purchases that
is a canonical merchant name, but transfers, card payments, payroll, P2P
settlements and interest keep the bank's own wording ("Zelle Payment From ...
Conf# ...", "ACME DES:PAYROLL ID:... INDN:... CO ID:... PPD"). This module turns
that text into a short title for the phone app when the snapshot is built. The
ledger is never changed.

It is presentation only. The caller classifies the row, resolves its logo and
orders it from the original transaction; only the shown ``payee`` / ``note`` /
``narration`` / ``label`` text comes from here, and a row whose title changed
also carries the original string (``rawPayee``, ``rawLabel`` for upcoming).

Precedence, first that applies wins for the title:

1. An empty payee is left alone.
2. Personal labels (``payees:`` in mobile.yaml): the first pattern that matches
   the raw payee gives the title, and its narration fills an empty narration.
   They exist for descriptors only the owner can name (an employer's payroll
   code, a card's account number).
3. Structure, when the text (after step 4's parsing and cleanup) says nothing
   but bank boilerplate ("Payment - Thank You", "Online Payment Conf# ...",
   "ACH Withdrawal to Account"): a card payment row reads "Card payment"; an
   interest row reads "Interest"; a transfer reads "Transfer to/from <account>"
   when the other side is one known own account, else "Transfer in/out". Text
   that names something (a person, a company, a destination) beats structure,
   because the structure of a row booked through a clearing account only knows
   its own side. A plain "Transfer to savings" is boilerplate too, so a row
   whose other side is one own account reads "Transfer to <that account>".
4. Generic parsers, first match: Zelle ("payment from/to NAME [for MEMO]"),
   NACHA ("COMPANY Des:WHAT Id:... Indn:... Co Id:... PPD"), ATM withdrawals,
   "Contribution to X from Y", own-account transfer wording ("Internal
   Transfer to ...", "ACH Deposit from ..."), card-linked offers ("Offer:X"),
   and "<Name> Payment/E-payment/Funds". On expense rows only the bank-format
   parsers (Zelle, NACHA, ATM) run, so a merchant whose name contains
   "Payment" or "Transfer" keeps it. A memo or description the parser finds
   fills an empty narration. Everything is then scrubbed of confirmation
   numbers, account-number fragments, stray quotes and trailing punctuation,
   and ALL-CAPS text is re-cased (short consonant-only words such as "TD" stay
   upper case). Text no rule recognises passes through with only that scrub
   and re-casing, so a mixed-case merchant name is never rewritten.

The row's own narration always wins over a parsed memo or a label's narration:
it was written by hand. When the title changed or the narration was filled, a
narration that only repeats the title is dropped, and one that starts with the
title loses that prefix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

KIND_EXPENSE = "expense"
KIND_INCOME = "income"
KIND_TRANSFER = "transfer"
KIND_CARD_PAYMENT = "card payment"
KIND_LOAN_PAYMENT = "loan payment"


@dataclass(frozen=True)
class PayeeLabel:
    """A personal display label: ``pattern`` is searched in the raw payee
    (case-insensitive); ``title`` replaces it, ``narration`` fills an empty
    narration."""

    pattern: re.Pattern[str]
    title: str
    narration: str | None = None


@dataclass(frozen=True)
class RowContext:
    """What the generator already knows about a row, for structure-derived
    titles. ``counterpart`` is the display name of the one own account on the
    other side of a transfer (None when it went through a clearing account)."""

    kind: str | None = None
    category: str | None = None
    amount: float = 0.0
    counterpart: str | None = None


@dataclass(frozen=True)
class Display:
    payee: str
    narration: str
    raw: str

    @property
    def changed(self) -> bool:
        return self.payee != self.raw


# ---- scrubbing ---------------------------------------------------------------

_CONF = re.compile(r"[;,]?\s*\b(?:Conf(?:irmation)?|Ref)\s*#\s*\S*", re.I)
_ACCT = re.compile(
    r"\s*\b(?:Acct|Account)\s*#\s*\S+"  # Acct# 1234
    r"|\s+\bCHK\s*\d+"  # CHK 1234
    r"|\s*\bending\s+in\s+\d+"  # Account Ending in 1234
    r"|\s*\*{2,}\d+"  # ********1234
    r"|\s+-\s+\d{4}\b",  # Banking - 1234
    re.I,
)
_TRAIL = re.compile(r"[\s\";,:]+$")
_LEAD = re.compile(r"^[\s\";,:]+")
_WS = re.compile(r"\s+")


def _scrub(s: str) -> str:
    s = _CONF.sub("", s)
    s = _ACCT.sub("", s)
    # Stray quotes a bank CSV quirk leaves before ';' or at the end; an odd
    # count of quotes means none of them pairs up.
    s = re.sub(r"\"(?=\s*;)", "", s)
    if s.count('"') % 2:
        s = s.replace('"', "")
    s = _WS.sub(" ", s)
    return _LEAD.sub("", _TRAIL.sub("", s))


# ---- casing ------------------------------------------------------------------

_SMALL = {"of", "and", "the", "for", "at", "in", "on", "to", "a", "an", "from", "by"}
# Bank abbreviations that title-cased exports mangle ("Td", "Atm").
_ACRONYMS = {"td": "TD", "atm": "ATM", "ach": "ACH", "ira": "IRA", "hsa": "HSA",
             "usa": "USA", "nyc": "NYC", "llc": "LLC", "ccb": "CCB"}


def _word_case(w: str, first: bool) -> str:
    low = w.lower()
    if low in _ACRONYMS:
        return _ACRONYMS[low]
    letters = re.sub(r"[^a-z]", "", low)
    if letters and len(letters) <= 3 and not re.search(r"[aeiouy]", letters):
        return w.upper()  # TD, BNY, CVS
    if not first and low in _SMALL:
        return low
    return "-".join(p[:1].upper() + p[1:] for p in low.split("-"))


def _is_shouting(s: str) -> bool:
    letters = re.sub(r"[^A-Za-z]", "", s)
    return len(letters) >= 4 and letters.isupper() and len(s.split()) >= 2


def tidy_case(s: str) -> str:
    """Re-case ALL-CAPS text; anything already mixed-case is left alone."""
    if not _is_shouting(s):
        return s
    return " ".join(_word_case(w, i == 0) for i, w in enumerate(s.split()))


def _fix_acronyms(s: str) -> str:
    """'Td' -> 'TD' in text a parser produced (never in untouched names)."""
    return " ".join(_ACRONYMS.get(w.lower(), w) if w.istitle() else w for w in s.split())


def _cap_first(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


# ---- boilerplate -------------------------------------------------------------

_BOILER = {
    "payment", "payments", "pmt", "autopay", "thank", "you", "mobile", "online",
    "internet", "scheduled", "ach", "deposit", "transfer", "xfer", "from", "to",
    "account", "acct", "ending", "in", "chk", "checking", "savings", "saving",
    "personal", "epayment", "e", "withdrawal", "withdrwl", "electronic", "bill",
    "pay", "web", "ppd", "ccd", "realtime", "the", "a", "of", "internal",
    "inter", "entity", "received", "sent", "credit", "card", "inst", "xfr",
}
_INTEREST = _BOILER | {"interest", "paid", "iod", "on", "cash", "balance", "earned", "dividend"}


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z]+", s.lower())


def _is_boilerplate(s: str | None) -> bool:
    w = _words(s or "")
    return not w or all(x in _BOILER for x in w)


# ---- parsers -----------------------------------------------------------------

_ZELLE = re.compile(
    r"^(?:TD\s+)?Zelle\s+(?:Payment\s+|Transfer\s+)?(from|to)\s+(.+?)(?:\s+for\s+(.+))?$",
    re.I,
)
_TD_ZELLE = re.compile(r"^TD\s+Zelle\s+(Received|Sent)\s+\S*\d\S*\s+Zelle\s+(.+)$", re.I)
_NACHA = re.compile(r"^(?P<co>.+?)\s+Des:\s*(?P<desc>\S*)\s+Id:", re.I)
_NACHA_ID = re.compile(r"^[A-Z]{0,2}\d{4,}\s+", re.I)
_NACHA_DESC = {
    "payroll": "Payroll",
    "dirdep": "Direct deposit",
    "payment": "Payment",
    "epayment": "Payment",
    "epay": "Payment",
    "transfer": "Transfer",
    "funds": "Transfer",
    "cashout": "Cash-out",
    "cashreward": "Cash reward",
    "rewards": "Rewards",
    "refund": "Refund",
    "deposit": "Deposit",
    "interest": "Interest",
}
_ATM = re.compile(r"\bATM\b", re.I)
_ATM_VERB = re.compile(r"\b(?:Withdrwl|Withdrawal|Wdl|Withdraw)\b", re.I)
_CONTRIB = re.compile(r"^Contribution\s+to\s+(.+?)\s+from\s+(.+)$", re.I)
_OFFER = re.compile(r"^Offer\s*:\s*(.+)$", re.I)
_XFER = re.compile(
    r"^(?P<lead>(?:(?:Internal|Inter-Entity|ACH|Online|Internet|Wire|Realtime|"
    r"Deposit|Withdrawal|Transfer|Xfer)\s+)*)"
    r"(?P<verb>Transfer|Xfer|Deposit|Withdrawal)\s+(?P<dir>to|from)\b\s*(?P<dest>.*)$",
    re.I,
)
_TAIL_PAY = re.compile(
    r"^(?P<name>.+?)\s+(?P<what>E-?payment(?:\s+ACH)?(?:\s+PMT)?|Payment|PMT|Funds)$",
    re.I,
)
_LONG_NUMBER = re.compile(r"\s+\d{6,}$")


def _parse_zelle(s: str) -> tuple[str, str | None] | None:
    m = _TD_ZELLE.match(s)
    if m:
        return tidy_case(m.group(2)), None
    m = _ZELLE.match(s)
    if not m:
        return None
    name = tidy_case(m.group(2).strip())
    memo = m.group(3)
    return name, (_cap_first(tidy_case(memo.strip())) if memo else None)


def _parse_nacha(s: str) -> tuple[str, str | None] | None:
    m = _NACHA.match(s)
    if not m:
        return None
    co = _NACHA_ID.sub("", m.group("co")).strip()
    co = _fix_acronyms(tidy_case(co))
    desc = m.group("desc").strip().lower()
    what = _NACHA_DESC.get(desc)
    if what is None and desc.isalpha() and 2 < len(desc) <= 15:
        what = _cap_first(desc)
    return co, what


def _parse_atm(s: str) -> tuple[str, str | None] | None:
    if not (_ATM.search(s) and (_ATM_VERB.search(s) or re.search(r"\bcash\b", s, re.I))):
        return None
    m = _ATM_VERB.search(s)
    where = s[m.end():] if m else ""
    where = re.sub(r"#?\d[\d/#-]*", "", where)
    where = _WS.sub(" ", where).strip(" ,-")
    if where:
        words = tidy_case(where).split()
        if len(words) > 1 and len(words[-1]) == 2 and words[-1].isalpha():
            words[-1] = words[-1].upper()  # a state code: "Ny" -> "NY"
        where = " ".join(words)
    return "ATM withdrawal", where or None


def _parse_contribution(s: str) -> tuple[str, str | None] | None:
    m = _CONTRIB.match(s)
    if not m:
        return None
    to = _fix_acronyms(tidy_case(m.group(1).strip()))
    src = _fix_acronyms(tidy_case(m.group(2).strip()))
    return f"{to} contribution", f"From {src}"


def _parse_offer(s: str) -> tuple[str, str | None] | None:
    m = _OFFER.match(s)
    if not m:
        return None
    name = " ".join(_cap_first(w) for w in tidy_case(m.group(1).strip()).split())
    return name, "Card offer"


def _parse_transfer(s: str) -> tuple[str | None, str | None] | None:
    m = _XFER.match(s)
    if not m:
        return None
    if not m.group("lead") and m.group("verb").lower() == "transfer":
        return None  # plain "Transfer to savings" is already readable
    dest = re.sub(r",?\s+N\.?A\.?$", "", m.group("dest").strip(), flags=re.I)
    dest = _fix_acronyms(tidy_case(dest.strip(" ,")))
    if _is_boilerplate(dest):
        # "Internal Transfer to Personal Savings": keep the account type when
        # the text has one, else let structure name it.
        kind = next((w for w in ("savings", "checking") if w in _words(dest)), None)
        way = m.group("dir").lower()
        return (f"Transfer {way} {kind}" if kind else None), None
    return f"Transfer {m.group('dir').lower()} {dest}", None


def _parse_tail_payment(s: str) -> tuple[str, str | None] | None:
    m = _TAIL_PAY.match(s)
    if not m:
        return None
    name = m.group("name").strip()
    if _is_boilerplate(name) or set(_words(name)) & {"interest", "dividend"}:
        return None
    what = "Transfer" if m.group("what").lower() == "funds" else "Payment"
    return _fix_acronyms(tidy_case(name)), what


# Bank-format parsers, safe on any row: these shapes are never a merchant name.
_PARSERS = (_parse_zelle, _parse_nacha, _parse_atm)
# Wording parsers, skipped on expense rows so a merchant called "... Payment"
# or "... Transfer" keeps its name.
_MONEY_PARSERS = (
    _parse_contribution,
    _parse_offer,
    _parse_transfer,
    _parse_tail_payment,
)


def _parse(
    raw: str, kind: str | None = None
) -> tuple[str | None, str | None, bool]:
    """(title, memo, recognised) from the text alone. A None title means the
    text is boilerplate and the row's structure should name it; recognised is
    True when a parser named the row (structure then stays out)."""
    s = _scrub(raw)
    parsers = _PARSERS if kind == KIND_EXPENSE else _PARSERS + _MONEY_PARSERS
    for parse in parsers:
        hit = parse(s)
        if hit is not None:
            title, memo = hit
            return (
                (_scrub(title) if title else None),
                (_scrub(memo) if memo else None),
                title is not None,
            )
    s = _LONG_NUMBER.sub("", s)
    return tidy_case(s), None, False


def _structural(
    title: str | None, raw: str, ctx: RowContext
) -> tuple[str, str | None] | None:
    if ctx.kind == KIND_CARD_PAYMENT and _is_boilerplate(title):
        return "Card payment", ("Autopay" if "autopay" in raw.lower() else None)
    if (
        ctx.kind == KIND_INCOME
        and ctx.category == "Interest"
        and title
        and "interest" in _words(title)
        and all(w in _INTEREST for w in _words(title))
    ):
        return "Interest", None
    if ctx.kind in (KIND_TRANSFER, KIND_LOAN_PAYMENT) and _is_boilerplate(title):
        way = "to" if ctx.amount < 0 else "from"
        if ctx.counterpart:
            return f"Transfer {way} {ctx.counterpart}", None
        return ("Transfer out" if ctx.amount < 0 else "Transfer in"), None
    return None


def _dedupe(title: str, narration: str) -> str:
    if not narration:
        return narration
    tw, nw = _words(title), _words(narration)
    if nw and set(nw) <= set(tw):
        return ""
    if narration.lower().startswith(title.lower() + " "):
        rest = narration[len(title) :].lstrip(" ,:;-\u2013\u2014")
        return _cap_first(rest) if rest else ""
    return narration


def display(
    payee: str,
    narration: str = "",
    ctx: RowContext | None = None,
    labels: tuple[PayeeLabel, ...] = (),
) -> Display:
    """The title and narration to show for one row (see the module docstring)."""
    raw = payee or ""
    narration = narration or ""
    if not raw.strip():
        return Display(raw, narration, raw)

    label = next((lab for lab in labels if lab.pattern.search(raw)), None)
    if label is not None:
        title = label.title
        memo = label.narration if label.narration is not None else _parse(raw)[1]
    else:
        title, memo, named = _parse(raw, ctx.kind if ctx is not None else None)
        st = _structural(title, raw, ctx) if ctx is not None and not named else None
        if st is not None:
            title, memo = st[0], memo or st[1]
        if not title:
            title = _scrub(raw) or raw

    if title == raw and (narration or not memo):
        return Display(raw, narration, raw)
    shown = narration if narration.strip() else (memo or "")
    return Display(title, _dedupe(title, shown), raw)
