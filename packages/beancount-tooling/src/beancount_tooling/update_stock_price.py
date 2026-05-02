from datetime import date

# from beanprice.sources import coincap
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


# def get_crypto_price(ticker: str, symbol: str) -> list[str]:
#     today = date.today().strftime(dateformat_str)
#     results = coincap.get_latest_price(ticker)
#     price = float(results[0])
#     return [f"{today} price {symbol} {price:.2f} USD"]


ticker_path = str(
    get_journal_dir()
    / "investment"
    / "tickers"
    / f"{date.today().strftime('%Y-%m')}.bean"
)

s_date = date.today().strftime("%Y-%m-%d")
# get_stock_price("AAPL")

# assets = coincap.get_asset_list()

# get all stocks and print their prices
results = []
for ticker, info in get_all_stocks():
    print(f"Getting price for {ticker} {info}")
    max_retries = 3
    retry_count = 0
    while retry_count < max_retries:
        retry_count += 1
        try:
            if info == "Crypto":
                continue
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
