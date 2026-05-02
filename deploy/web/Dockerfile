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
ENV FAVA_INTERNAL_URL=${FAVA_INTERNAL_URL}
ENV FAVA_LEDGER_SLUG=${FAVA_LEDGER_SLUG}
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
