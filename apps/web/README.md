# apps/web

Next.js 16 viewer for the beancount ledger — the primary planner UI. Reads all of its data from Fava over a same-origin proxy, so it holds no ledger state of its own. Built with shadcn/ui on Tailwind v4.

## Running

```bash
just fava      # terminal 1 — Fava must be up; the app is a proxy client
just web-dev   # terminal 2 — http://localhost:3000
```

Then `just web-build` + `just web` for the production build. Use the recipes rather than `pnpm --filter web dev`: the Justfile's `set dotenv-load` exports the repo-root `.env`, and without it the Fava proxy falls back to the public-demo defaults.

## Data flow

Nothing is fetched from Fava directly by the browser. `next.config.mjs` rewrites two prefixes onto the Fava origin, which keeps requests same-origin and avoids CORS:

| App request | Proxied to |
|---|---|
| `/api/fava/*` | `<FAVA_INTERNAL_URL>/<FAVA_LEDGER_SLUG>/api/*` |
| `/api/ext/*` | `<FAVA_INTERNAL_URL>/<FAVA_LEDGER_SLUG>/extension/LedgerDataApi/*` |

The second one hits [`ledger-data-api`](../../packages/ledger-data-api/), the Fava extension that serves this app's custom endpoints (`/ui-config`, `get_balance`, …).

## Environment

Two files, deliberately split:

**Repo-root `.env`** (`../../.env.example`) — loaded by `just`, shared with the Chrome extension build:

| Var | Purpose | Default |
|---|---|---|
| `FAVA_LEDGER_SLUG` | Fava's URL prefix, from its slugification of the journal's `option "title"` | `acme-demo` |
| `FAVA_INTERNAL_URL` | Fava origin to proxy to | `http://127.0.0.1:5000` |

**`apps/web/.env`** (see `.env.example`) — web-app-only, and everything `NEXT_PUBLIC_*` is inlined into the client bundle:

| Var | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_LOGO_DEV_TOKEN` | logo.dev publishable key (`pk_…`) for merchant logos | unset → letter marks |
| `NEXT_PUBLIC_DEMO_MODE` | truthy shows the first-visit welcome dialog | unset → hidden |
| `NEXT_PUBLIC_APP_TITLE` | browser-tab title | `Ledger` |

`NEXT_PUBLIC_APP_TITLE` exists because SSR can't read the per-request `/ui-config` payload, so the page-title metadata has to bake in at build time. Keep it in sync with `branding.title` in `<LEDGER_DIR>/config/ui.yaml`, which drives the in-app sidebar header. Everything else about presentation (display names, account colors, category icons, merchants, bookmarks) is runtime config from that same YAML — see `lib/config/ui.example.yaml`.

### Nothing here is read at runtime

Every var above is consumed at build time. `FAVA_LEDGER_SLUG` and `FAVA_INTERNAL_URL` are baked when `next.config.mjs` is evaluated at server start; `NEXT_PUBLIC_*` values are inlined into the bundle by `next build`.

So after editing either file:

- **dev** — restart `next dev`. Saving `.env` triggers only a `Reload env` in the dev server; it does *not* re-evaluate `rewrites()`, so a changed slug appears to be ignored.
- **docker** — `docker compose build web`. Passed as build args, not `environment:`; see `deploy/web/Dockerfile`.

A stale or wrong slug surfaces as a 404 on `/api/fava/*` that is served by **Fava** (`Server: Cheroot` in the response headers), not by Next. If you see that, compare your slug against where Fava's root redirects: `curl -sI http://127.0.0.1:5000/ | grep -i location`.

## Adding components

```bash
pnpm --filter web exec shadcn@latest add button
```

Components land in `components/ui/`; import them as `@/components/ui/button`.
