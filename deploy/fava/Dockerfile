# syntax=docker/dockerfile:1.6
# Build context: monorepo root.

FROM python:3.13-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy

# uv binary
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# git: needed by uv to fetch the CORS-patched fava fork at build time.
# Kept in the runtime image too so a future "uv pip install" inside a running
# container doesn't fail; remove if you want to slim further.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
# Fava's wheel build (`_build_backend.py`) runs `npm install` + `npm run build`
# to bundle the Svelte frontend. Node is needed at build time, not runtime.
# Fava's frontend requires Node >= 22.18; Debian's apt nodejs is 18, so use
# NodeSource for a current LTS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Workspace metadata + lock — enough for uv to resolve everything.
COPY pyproject.toml uv.lock README.md ./
COPY packages/beancount-tooling/pyproject.toml packages/beancount-tooling/
COPY packages/ledger-data-api/pyproject.toml packages/ledger-data-api/README.md packages/ledger-data-api/
# Workspace member sources (small; needed because uv builds them as workspace deps)
COPY packages/beancount-tooling/src packages/beancount-tooling/src
COPY packages/ledger-data-api/src packages/ledger-data-api/src
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    --mount=type=cache,id=npm,target=/root/.npm \
    uv sync --frozen --no-dev

FROM base AS runner
COPY --from=deps /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    FAVA_LEDGER=/repo/journal/journal.beancount
EXPOSE 5000
# `sh -c` so $FAVA_LEDGER is expanded at runtime, not baked into JSON CMD.
CMD ["sh", "-c", "exec fava \"$FAVA_LEDGER\" -H 0.0.0.0 --port 5000"]
