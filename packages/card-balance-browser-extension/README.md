# card-balance-browser-extension

Chrome Manifest V3 extension ("Credit Card Balance Viewer") that overlays the user's beancount account balances on top of bank/brokerage websites. Per-site extractors can also scrape transactions into beancount syntax.

## Build

```bash
just build-extension
# or: pnpm --filter card-balance-browser-extension build
```

Output: `packages/card-balance-browser-extension/build/` — load this folder as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → "Load unpacked").

## Supported domains

Host permissions + content-script matches live in `src/manifest.json`. Currently:

| Domain | Account key |
|---|---|
| `americanexpress.com` | `amex` |
| `chase.com` | `chase` |
| `bankofamerica.com` | `bofa` |
| `bilt.com` | `bilt` |
| `discover.com` | `discover` |
| `robinhood.com` | `robinhood` |
| `future.green` | `future` |
| `td.com`, `tdbank.com` | `td` |

Mapping lives in `src/index.js`. To add a domain: add a `host_permissions` entry + `content_scripts.matches` entry in `manifest.json` and a `url.includes(...)` branch in `index.js`.

## Backend

The overlay fetches `http://127.0.0.1:5000/<FAVA_LEDGER_SLUG>/extension/LedgerDataApi/get_balance?account=<key>` — served by [`ledger-data-api`](../ledger-data-api/) running inside Fava (`just fava`). The slug is set in `src/balanceDialog.js` (default `acme-demo`); change it to match your journal's `option "title"`. The `127.0.0.1:5000/*` host permission is required for the cross-origin fetch.

## Extractors

Per-site transaction scrapers live in `src/extractors/` (currently `amex.js`, `future.js`, `robinhood.js`). They render a dialog showing beancount-formatted transactions pasteable into the ledger.
