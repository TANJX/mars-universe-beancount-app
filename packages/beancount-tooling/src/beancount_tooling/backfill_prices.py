#!/usr/bin/env python3
"""
Backfill historical `price` directives so every held commodity has at least one
price per ISO week.

`update-stock-price` only ever writes today's spot quote, so coverage is limited
to the days it happened to be run. This fills the holes from Yahoo's chart
endpoint, which returns a full daily history in a single unauthenticated request
per ticker (the crumb handshake is a v7 `quote` requirement only).

Three things keep the output honest:

* **Holding windows.** Each commodity is only backfilled between its first
  acquisition and the date the position last went flat, so closed positions
  (SNOW, TQQQ, SCHG, VEIRX, VIGIX) stop where they actually stopped.
* **Split un-adjustment.** Yahoo restates historical closes for later splits,
  but the ledger records as-traded prices (TQQQ reads 99.19 on 2025-11-18 and
  48.42 on 2025-11-21 across its 2:1). Closes are multiplied back out by the
  cumulative ratio of every split dated after them.
* **Idempotence.** A week that already has a price for that ticker is skipped,
  so reruns are no-ops and hand-entered prices are never overwritten.

Usage:
    uv run backfill-prices                      # all held commodities, full history
    uv run backfill-prices --dry-run            # report what would be written
    uv run backfill-prices --since 2025-01      # only weeks on/after that month
    uv run backfill-prices --ticker NVDA --ticker TQQQ
"""

import argparse
import logging
import re
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import requests
from beancount import loader
from beancount.core import data

from beancount_tooling.paths import get_journal_dir, get_journal_file
from beancount_tooling.update_stock_price import crypto_ids, excluded_currencies

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

PRICE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) price ([A-Z0-9.]+)\s")
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)
INVESTMENT_PREFIX = "Assets:Investment"
MAX_RETRIES = 3
REQUEST_PAUSE_SECONDS = 0.4


def iso_week(day: date) -> tuple[int, int]:
    year, week, _ = day.isocalendar()
    return year, week


def get_tickers_dir() -> Path:
    return get_journal_dir() / "investment" / "tickers"


def holding_windows(today: date) -> dict[str, tuple[date, date]]:
    """First acquisition -> last date held, per commodity.

    Future-dated `!` forecast entries are ignored; including them would invent a
    holding window ahead of today. A position that goes flat and stays flat ends
    on the date it closed, so we never fetch prices for something no longer held.
    """
    entries, errors, _ = loader.load_file(str(get_journal_file()))
    if errors:
        logger.warning("Ledger loaded with %d error(s)", len(errors))

    moves: dict[str, list[tuple[date, Decimal]]] = defaultdict(list)
    for entry in entries:
        if not isinstance(entry, data.Transaction) or entry.date > today:
            continue
        for posting in entry.postings:
            if not posting.account.startswith(INVESTMENT_PREFIX):
                continue
            currency = posting.units.currency
            if currency in excluded_currencies:
                continue
            moves[currency].append((entry.date, posting.units.number))

    windows: dict[str, tuple[date, date]] = {}
    for currency, postings in moves.items():
        postings.sort(key=lambda item: item[0])
        balance = Decimal(0)
        flat_since: date | None = None
        for day, units in postings:
            balance += units
            if balance == 0:
                if flat_since is None:
                    flat_since = day
            else:
                flat_since = None
        end = flat_since if (balance == 0 and flat_since) else today
        windows[currency] = (postings[0][0], end)
    return windows


def existing_weeks() -> dict[str, set[tuple[int, int]]]:
    """ISO weeks that already carry a price, per ticker.

    Reads every file under tickers/, including the legacy per-ticker ones
    (spy.bean, nvda.bean, ...), so their coverage counts as filled.
    """
    weeks: dict[str, set[tuple[int, int]]] = defaultdict(set)
    for path in sorted(get_tickers_dir().glob("*.bean")):
        for line in path.read_text().splitlines():
            match = PRICE_RE.match(line)
            if match:
                weeks[match.group(2)].add(iso_week(date.fromisoformat(match.group(1))))
    return weeks


def yahoo_symbol(ticker: str) -> str:
    """Crypto trades as a pair on Yahoo; equities and funds use the bare symbol."""
    return f"{ticker}-USD" if ticker in crypto_ids else ticker


def _epoch(day: date) -> int:
    return int(
        datetime.combine(day, datetime.min.time())
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )


def fetch_history(
    session: requests.Session, ticker: str, start: date, end: date, today: date
) -> list[tuple[date, Decimal]]:
    """Daily as-traded closes for `ticker` between `start` and `end` inclusive.

    The request always runs through `today` rather than stopping at `end`:
    Yahoo only reports split events that fall inside the requested window, but
    it adjusts closes for every split up to the present. Asking for a window
    that ends before a split therefore returns silently adjusted prices with no
    event to correct them by. Bars are trimmed back to [start, end] afterwards.
    """
    period1 = _epoch(start - timedelta(days=1))
    period2 = _epoch(max(end, today) + timedelta(days=1))
    response = session.get(
        CHART_URL.format(symbol=yahoo_symbol(ticker)),
        params={
            "period1": period1,
            "period2": period2,
            "interval": "1d",
            "events": "split",
        },
        timeout=30,
    )
    payload = response.json(parse_float=Decimal)
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise Exception(f"Yahoo error for {ticker}: {chart['error']}")
    results = chart.get("result")
    if not results:
        raise Exception(f"No chart data for {ticker}")

    result = results[0]
    timestamps = result.get("timestamp") or []
    closes = result["indicators"]["quote"][0].get("close") or []
    # gmtoffset maps each bar to its exchange-local trading date, so the result
    # does not depend on the timezone of the machine running this.
    offset = int(result.get("meta", {}).get("gmtoffset") or 0)

    splits = (result.get("events") or {}).get("splits") or {}
    split_points: list[tuple[date, Decimal]] = []
    for event in splits.values():
        split_day = datetime.fromtimestamp(
            int(event["date"]) + offset, tz=timezone.utc
        ).date()
        ratio = Decimal(str(event["numerator"])) / Decimal(str(event["denominator"]))
        split_points.append((split_day, ratio))
    split_points.sort()
    if split_points:
        logger.info(
            "  %s: un-adjusting %s",
            ticker,
            ", ".join(f"{d} {r:f}:1" for d, r in split_points),
        )

    history: list[tuple[date, Decimal]] = []
    for timestamp, close in zip(timestamps, closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(int(timestamp) + offset, tz=timezone.utc).date()
        if day < start or day > end:
            continue
        price = Decimal(str(close))
        # Yahoo restates pre-split closes; multiply back out to the traded price.
        for split_day, ratio in split_points:
            if day < split_day:
                price *= ratio
        history.append((day, price))
    return history


def weekly_picks(
    history: list[tuple[date, Decimal]], wanted: set[tuple[int, int]]
) -> dict[tuple[int, int], tuple[date, Decimal]]:
    """Last trading day of each wanted week, with its close."""
    picks: dict[tuple[int, int], tuple[date, Decimal]] = {}
    for day, price in history:
        week = iso_week(day)
        if week not in wanted:
            continue
        if week not in picks or day > picks[week][0]:
            picks[week] = (day, price)
    return picks


def format_price(day: date, ticker: str, price: Decimal) -> str:
    # Sub-dollar coins (DOGE, XLM, ADA) round to nothing at 2dp.
    places = Decimal("0.01") if price >= 1 else Decimal("0.00000001")
    return f"{day} price {ticker} {price.quantize(places).normalize():f} USD"


def merge_into_month_files(
    new_rows: list[tuple[date, str, Decimal]], dry_run: bool
) -> None:
    """Rewrite each touched month file as a sorted, deduplicated price list.

    The existing appender only sorts within a single run, so files drift out of
    order. Rewriting keeps them scannable. `just format` prunes tickers/, so
    nothing else reformats these.
    """
    tickers_dir = get_tickers_dir()
    by_month: dict[str, list[tuple[date, str, Decimal]]] = defaultdict(list)
    for day, ticker, price in new_rows:
        by_month[f"{day:%Y-%m}"].append((day, ticker, price))

    for month in sorted(by_month):
        path = tickers_dir / f"{month}.bean"
        lines: dict[tuple[date, str], str] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                match = PRICE_RE.match(line)
                if match:
                    key = (date.fromisoformat(match.group(1)), match.group(2))
                    lines[key] = line
        added = 0
        for day, ticker, price in by_month[month]:
            key = (day, ticker)
            if key in lines:  # never clobber a price already on record
                continue
            lines[key] = format_price(day, ticker, price)
            added += 1
        logger.info("%s: +%d prices (%d total)", path.name, added, len(lines))
        if not dry_run:
            body = "\n".join(lines[key] for key in sorted(lines))
            path.write_text(body + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Report what would change, write nothing"
    )
    parser.add_argument(
        "--since", help="Only backfill weeks on/after this month (YYYY-MM)"
    )
    parser.add_argument(
        "--ticker",
        action="append",
        dest="tickers",
        help="Limit to this commodity (repeatable)",
    )
    args = parser.parse_args()

    today = date.today()
    floor: date | None = None
    if args.since:
        try:
            floor = datetime.strptime(args.since, "%Y-%m").date()
        except ValueError:
            parser.error("--since must be YYYY-MM")

    windows = holding_windows(today)
    covered = existing_weeks()
    selected = sorted(args.tickers) if args.tickers else sorted(windows)
    unknown = [t for t in selected if t not in windows]
    if unknown:
        parser.error(f"not held in this ledger: {', '.join(unknown)}")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    new_rows: list[tuple[date, str, Decimal]] = []
    failed: list[str] = []

    for ticker in selected:
        start, end = windows[ticker]
        if floor and floor > start:
            start = floor
        if start > end:
            continue

        wanted: set[tuple[int, int]] = set()
        cursor = start
        while cursor <= end:
            week = iso_week(cursor)
            if week not in covered.get(ticker, set()):
                wanted.add(week)
            cursor += timedelta(days=1)
        if not wanted:
            logger.info("%s: already weekly-complete", ticker)
            continue

        logger.info(
            "%s: %d week(s) missing between %s and %s", ticker, len(wanted), start, end
        )
        history: list[tuple[date, Decimal]] = []
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                history = fetch_history(session, ticker, start, end, today)
                break
            except Exception as exc:
                if attempt == MAX_RETRIES:
                    logger.error(
                        "  %s failed after %d attempts: %s", ticker, MAX_RETRIES, exc
                    )
                    failed.append(ticker)
                else:
                    logger.warning(
                        "  retry %d/%d for %s: %s", attempt, MAX_RETRIES, ticker, exc
                    )
                    time.sleep(attempt)
        time.sleep(REQUEST_PAUSE_SECONDS)
        if not history:
            continue

        picks = weekly_picks(history, wanted)
        for day, price in picks.values():
            new_rows.append((day, ticker, price))
        missed = wanted - set(picks)
        if missed:
            # Market holidays and pre-listing weeks legitimately have no bar.
            logger.info("  %s: %d week(s) with no trading data", ticker, len(missed))

    if not new_rows:
        logger.info("Nothing to backfill")
        return 1 if failed else 0

    logger.info(
        "%s %d price directive(s) across %d ticker(s)",
        "Would write" if args.dry_run else "Writing",
        len(new_rows),
        len({ticker for _, ticker, _ in new_rows}),
    )
    merge_into_month_files(new_rows, args.dry_run)

    if failed:
        logger.error("Failed tickers: %s", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
