# syntax=docker/dockerfile:1.6
# Build context: monorepo root.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter web...

FROM base AS build
COPY --from=deps /app /app
COPY apps/web ./apps/web
# Next.js evaluates `rewrites()` at build time, so FAVA_INTERNAL_URL and
# FAVA_LEDGER_SLUG must be set here (not at runtime) for the proxy destination
# to bake in correctly.
ARG FAVA_INTERNAL_URL=http://fava:5000
ARG FAVA_LEDGER_SLUG=ledger
# Truthy ("1"/"true") shows the welcome dialog. Inlined into the client
# bundle by Next.js because of the NEXT_PUBLIC_ prefix.
ARG NEXT_PUBLIC_DEMO_MODE=
# logo.dev publishable key (`pk_…`). Without it, merchant + repo-link logos
# render as letter / placeholder marks. Inlined into the client bundle.
ARG NEXT_PUBLIC_LOGO_DEV_TOKEN=
# Browser-tab title. SSR can't read the per-request /ui-config payload, so the
# page-title metadata bakes this in. Keep it in sync with `branding.title` in
# the ledger's config/ui.yaml. Empty falls back to "Ledger".
ARG NEXT_PUBLIC_APP_TITLE=
ENV FAVA_INTERNAL_URL=${FAVA_INTERNAL_URL}
ENV FAVA_LEDGER_SLUG=${FAVA_LEDGER_SLUG}
ENV NEXT_PUBLIC_DEMO_MODE=${NEXT_PUBLIC_DEMO_MODE}
ENV NEXT_PUBLIC_LOGO_DEV_TOKEN=${NEXT_PUBLIC_LOGO_DEV_TOKEN}
ENV NEXT_PUBLIC_APP_TITLE=${NEXT_PUBLIC_APP_TITLE}
RUN pnpm --filter web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
# Next.js standalone bundle: ./apps/web/server.js + node_modules at /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
