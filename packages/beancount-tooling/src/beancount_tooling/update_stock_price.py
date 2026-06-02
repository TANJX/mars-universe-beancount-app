from datetime import date

from beanquery import query
from beancount import loader
from decimal import Decimal
import requests

from beancount_tooling.paths import get_journal_dir, get_journal_file

dateformat_str = "%Y-%m-%d"
excluded_currencies = [
    "USD",
    "CNY",
    "HKD",
    "JPY",
]


def get_all_stocks() -> set[tuple[str, str]]:
    entries, _, options_map = loader.load_file(str(get_journal_file()))
    _, rrows = query.run_query(
        entries,
        options_map,
        "SELECT units(sum(position)), account as units GROUP BY currency, cost_currency, account",
    )
    stocks = set()
    for row in rrows:
        # Get the first (and only) key from the dict which represents the currency
        currency = next(iter(row[0].keys()))[0] if not row[0].is_empty() else None
        if not currency or currency in excluded_currencies:
            continue
        if "Crypto" in row[1] or "MetaMask" in row[1]:
            stocks.add((currency, "Crypto"))
        else:
            stocks.add((currency, "Stock"))

    return stocks


def parse_response(response: requests.models.Response):
    """Process as response from Yahoo.

    Raises:
      YahooError: If there is an error in the response.
    """
    json = response.json(parse_float=Decimal)
    content = next(iter(json.values()))
    if response.status_code != requests.codes.ok:
        raise Exception("Status {}: {}".format(response.status_code, content["error"]))
    if len(json) != 1:
        raise Exception(
            "Invalid format in response from Yahoo; many keys: {}".format(
                ",".join(json.keys())
            )
        )
    if content["error"] is not None:
        raise Exception("Error fetching Yahoo data: {}".format(content["error"]))
    if not content["result"]:
        raise Exception(
            "No data returned from Yahoo, ensure that the symbol is correct"
        )
    return content["result"][0]


def get_stock_price(ticker: str) -> list[str]:
    results = []

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
        }
    )
    # This populates the correct cookies in the session
    attempts = 0
    crumb = None
    while attempts < 3 and not isinstance(crumb, str):
        session.get("https://fc.yahoo.com")
        crumb = session.get("https://query1.finance.yahoo.com/v1/test/getcrumb").text
        attempts += 1
    if not isinstance(crumb, str):
        raise Exception("Failed to get valid crumb after 3 attempts")

    url = "https://query1.finance.yahoo.com/v7/finance/quote"
    fields = ["symbol", "regularMarketPrice", "regularMarketTime"]
    payload = {
        "symbols": ticker,
        "fields": ",".join(fields),
        "exchange": "NYSE",
        "crumb": crumb,
        "lang": "en-US",
        "corsDomain": "finance.yahoo.com",
        ".tsrc": "finance",
    }
    response = session.get(url, params=payload)
    try:
        result = parse_response(response)
        p = Decimal(result["regularMarketPrice"])
        results.append(
            f"{date.today().strftime(dateformat_str)} price {ticker} {p:.2f} USD"
        )
    except KeyError as exc:
        raise Exception("Invalid response from Yahoo: {}".format(repr(result))) from exc

    return results


# CoinGecko coin ids keyed by the ledger's commodity symbol. Symbols are not
# unique across CoinGecko (many coins share e.g. "BTC"), so map them explicitly.
# Add a row here when you start holding a new coin.
crypto_ids = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "DOGE": "dogecoin",
    "XLM": "stellar",
    "XRP": "ripple",
}


def get_crypto_prices(tickers: list[str]) -> list[str]:
    """Fetch USD prices for several coins in a single CoinGecko request.

    Batching keeps us under the free-tier rate limit (one request for all
    coins instead of one per coin, which hits HTTP 429).
    """
    id_to_ticker = {}
    for ticker in tickers:
        coin_id = crypto_ids.get(ticker)
        if coin_id is None:
            raise Exception(
                f"No CoinGecko id for {ticker}; add it to crypto_ids in update_stock_price.py"
            )
        id_to_ticker[coin_id] = ticker

    response = requests.get(
        "https://api.coingecko.com/api/v3/simple/price",
        params={"ids": ",".join(id_to_ticker), "vs_currencies": "usd"},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json(parse_float=Decimal)

    today = date.today().strftime(dateformat_str)
    results = []
    for coin_id, ticker in id_to_ticker.items():
        if coin_id not in data or "usd" not in data[coin_id]:
            raise Exception(
                f"No USD price for {ticker} ({coin_id}) from CoinGecko: {data}"
            )
        p = Decimal(data[coin_id]["usd"])
        results.append(f"{today} price {ticker} {p:.2f} USD")
    return results


def main():
    ticker_path = str(
        get_journal_dir()
        / "investment"
        / "tickers"
        / f"{date.today().strftime('%Y-%m')}.bean"
    )

    holdings = get_all_stocks()
    results = []

    # Crypto: one batched CoinGecko request for all coins at once.
    crypto_tickers = sorted(t for t, info in holdings if info == "Crypto")
    if crypto_tickers:
        print(f"Getting prices for crypto: {', '.join(crypto_tickers)}")
        max_retries = 3
        for retry_count in range(1, max_retries + 1):
            try:
                results.extend(get_crypto_prices(crypto_tickers))
                break
            except Exception as e:
                if retry_count == max_retries:
                    print(f"Error getting crypto prices after {max_retries} retries: {e}")
                else:
                    print(f"Retry {retry_count}/{max_retries} for crypto after error: {e}")

    # Stocks: one Yahoo request each.
    for ticker, info in holdings:
        if info == "Crypto":
            continue
        print(f"Getting price for {ticker} {info}")
        max_retries = 3
        retry_count = 0
        while retry_count < max_retries:
            retry_count += 1
            try:
                results.extend(get_stock_price(ticker))
                break
            except Exception as e:
                if retry_count == max_retries:
                    print(
                        f"Error getting price for {ticker} after {max_retries} retries: {e}"
                    )
                else:
                    print(
                        f"Retry {retry_count}/{max_retries} for {ticker} after error: {e}"
                    )

    # sort the results
    results.sort()

    # append to the journal
    with open(ticker_path, "a") as f:
        for r in results:
            f.write(r + "\n")


if __name__ == "__main__":
    main()
