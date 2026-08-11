# card-balance-browser-extension

Chrome Manifest V3 extension ("Credit Card Balance Viewer") that overlays the user's beancount account balances on top of bank/brokerage websites. Per-site extractors can also scrape transactions into beancount syntax.

## Build

```bash
just build-extension
```

Output: `packages/card-balance-browser-extension/build/` — load this folder as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → "Load unpacked"). Chrome keeps serving the previously loaded bundle until you hit reload on the extension card, so a rebuild alone changes nothing in the browser.

Use the recipe, not `pnpm --filter card-balance-browser-extension build` directly: the Justfile's `set dotenv-load` exports the repo-root `.env`, which is where `FAVA_LEDGER_SLUG` lives (see below). Running the raw `pnpm` script skips it and silently bakes in the `acme-demo` default.

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

The overlay fetches `http://127.0.0.1:5000/<FAVA_LEDGER_SLUG>/extension/LedgerDataApi/get_balance?account=<key>` — served by [`ledger-data-api`](../ledger-data-api/) running inside Fava (`just fava`). The `127.0.0.1:5000/*` host permission in `src/manifest.json` is what allows that cross-origin fetch.

`FAVA_LEDGER_SLUG` is Fava's slugification of your journal's `option "title"`. Set it in the **repo-root `.env`** (gitignored, so the slug never gets checked into this public repo), which `just` exports to the build:

```ini
# <repo>/.env
FAVA_LEDGER_SLUG=my-ledger
```

Or for a one-off: `FAVA_LEDGER_SLUG=my-ledger just build-extension`.

Default is `acme-demo` (the public demo ledger). `build.js` inlines the value through webpack's `DefinePlugin`, so it's fixed at build time — changing the slug means rebuilding and reloading the extension. Verify what actually shipped:

```sh
grep -c my-ledger build/content.js   # expect 1
grep -c acme-demo build/content.js   # expect 0
```

A wrong slug returns a 404 from Fava and the overlay renders no balance. Note that `apps/web/.env` is **not** read by this build — only the root `.env` is.

## Extractors

Per-site transaction scrapers live in `src/extractors/` (currently `amex.js`, `future.js`, `robinhood.js`). They render a dialog showing beancount-formatted transactions pasteable into the ledger.
