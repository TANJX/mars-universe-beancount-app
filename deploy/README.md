# Deploy — Docker Compose stack

Three services:

| Service   | What                              | Port      |
| --------- | --------------------------------- | --------- |
| `gitsync` | Polls GitHub, mirrors repo → vol  | —         |
| `fava`    | Patched Fava on the cloned ledger | (private) |
| `web`     | Next.js viewer, proxies to Fava   | 3000      |

Only `web` is exposed on the host. `fava` is reachable only inside the compose network at `http://fava:5000`. `web`'s `next.config.mjs` proxies to it; the destination is baked at image build time via the `FAVA_INTERNAL_URL` build arg (Next.js evaluates `rewrites()` during `next build`, not at startup), so changing the target requires a `docker compose build web`.

A single named volume `repo` holds the cloned monorepo. `gitsync` writes; `fava` reads it `:ro`. `web` doesn't touch the volume — it talks to `fava` over the Compose network.

## First-time setup

```sh
cd deploy
cp .env.example .env
$EDITOR .env        # set GIT_PAT if the repo is private
docker compose build
docker compose up -d
```

Watch logs:

```sh
docker compose logs -f gitsync   # confirm clone succeeded
docker compose logs -f fava      # confirm ledger parsed
```

Once `gitsync` reports `cloning ...` then `fava` starts, hit:

- `http://<host>:3000/` — viewer

To peek at Fava directly for debugging, either temporarily add `ports: ["5000:5000"]` under the `fava:` service, or `docker compose exec fava curl http://localhost:5000/<FAVA_LEDGER_SLUG>/` (e.g. `acme-demo` for the demo data repo).

## Updating

- **Ledger commits** — push to `main`; `gitsync` picks up within `GIT_PULL_INTERVAL` (default 5 min). Fava `auto-reload` re-parses on file change. No restart needed.
- **App code (web/fava image)** — `docker compose build && docker compose up -d`.
- **Fava fork patches** — push to `mars-dev`, bump the SHA in root `pyproject.toml`, rebuild the `fava` image.

## Networking

The compose binds `web` to `0.0.0.0:3000` by default. `fava` has no host port. To restrict `web`:

- **NAS firewall** — allow inbound `:3000` only from the ZeroTier subnet. Easiest.
- **Bind override** — set `WEB_BIND=10.147.x.y:3000` in `.env` to listen only on the ZeroTier interface.

Do **not** expose `:3000` to the public internet — Fava (which `web` proxies to) has no auth, and the ledger contains personal financial data.

## Synology DS220+ runbook

Specific instructions for the production target — Synology DSM 7.2, Intel J4025, 2 GB RAM. The 1.7 GiB usable RAM means we **cross-build on the laptop** (Apple Silicon → linux/amd64 via QEMU) and ship images to the NAS. Building Next.js on the J4025 OOMs.

### One-time setup on the NAS

1. **Install Container Manager** via DSM Package Center (uninstall the legacy "Docker" package first if present — configs are preserved). This is the only way to get `docker compose` v2.
2. **Enable SSH** in Control Panel → Terminal & SNMP → Enable SSH.
3. **SSH in** and verify:
   ```sh
   sudo docker-compose version  # DSM 7.2.1 ships compose v2 as `docker-compose` (with hyphen), not as a `docker compose` plugin
   ```
4. **Create the project directory** and clone the repo (only `deploy/` and the build-context paths are needed at the NAS; runtime working copy lives in the named volume — but cloning the whole thing once is simpler than sparse-checkout):
   ```sh
   sudo mkdir -p /volume1/docker
   sudo chown $(whoami) /volume1/docker
   cd /volume1/docker
   git clone https://github.com/TANJX/mars-universe-beancount-app.git
   cd mars-universe-beancount-app/deploy
   cp .env.example .env
   ```
5. **Edit `.env`**:
   ```ini
   GIT_REPO_URL=https://github.com/TANJX/mars-universe-beancount-demo.git
   GIT_BRANCH=main
   GIT_PAT=<fine-grained PAT, contents:read>
   GIT_PULL_INTERVAL=300
   WEB_BIND=172.30.40.192:3000   # ZeroTier IP — restricts listener to the overlay
   ```

### Per-deploy: build on laptop, ship to NAS

From the monorepo on the laptop:

```sh
NAS_USER=<your-synology-user> NAS_HOST=172.30.40.192 \
  deploy/scripts/ship.sh
```

That script:
1. Cross-builds `web`/`fava`/`gitsync` for `linux/amd64` on the laptop.
2. `docker save` the three images, gzipped and streamed straight into `docker load` on the NAS over SSH. No intermediate file.

### Bringing it up on the NAS

```sh
cd /volume1/docker/mars-universe-beancount-app/deploy
sudo docker-compose up -d
sudo docker-compose logs -f
```

You should see `gitsync` clone → `fava` start (after healthcheck passes) → `web` start. Then from any ZeroTier-connected device:

- `http://172.30.40.192:3000/` — the planner

### Updates

| What changed | Where to do it |
| --- | --- |
| Ledger commit pushed to GitHub | Nothing — `gitsync` picks it up within `GIT_PULL_INTERVAL` |
| `apps/web/`, `packages/ledger-data-api/`, fava SHA bump | Re-run `ship.sh` on laptop, then `sudo docker-compose up -d` on NAS |
| `deploy/.env` | Edit on NAS, `sudo docker-compose up -d` to apply |
| `docker-compose.yml` | `git pull` on NAS in the project dir, then `sudo docker-compose up -d` |

### NAS-specific gotchas

- **DSM owns `:5000` and `:5001`** for its admin UI. We don't expose Fava on the host so this never collides — but if you ever uncomment `ports: ["5000:5000"]` for Fava, change the host port (`5005:5000` or similar).
- **2 GB RAM** is enough to *run* the stack (Fava ~150 MB, web ~80 MB, gitsync ~5 MB) but not to *build* it. Always ship from laptop.
- **Container Manager auto-start**: containers come back after a NAS reboot via `restart: unless-stopped` — no extra config needed.
- **Sudo every time**: `docker` requires it on Synology unless you fight DSM's user management. Path of least resistance: prefix every command.

---

## Notes / caveats

- **First fava image build is slow (~4-5 min).** Fava's wheel build runs `npm install` + a Svelte bundle inside the container. uv and npm cache mounts make subsequent builds skip this entirely unless the fava SHA in `pyproject.toml` bumps.
- **Fava fork is fetched from GitHub at build time** (`https://github.com/TANJX/fava.git`). The repo must be public, or the build needs additional auth (BuildKit secret mount).
- **Ledger repo private?** Set `GIT_PAT` to a fine-grained PAT with `contents: read`. Public repos can leave it blank.
- **Cold start** is dominated by `gitsync`'s clone (depth=50). Fava waits on the healthcheck so it doesn't crash-loop trying to read a missing journal file.
- **No write paths** — `fava` reads the volume RO; `web` doesn't touch it. The whole stack is a viewer; mutating the ledger still happens on the laptop and rides through git.
- **macOS host port 5000 is owned by AirPlay Receiver.** Not relevant since fava isn't exposed by default — but if you ever uncomment `ports: ["5000:5000"]` for debugging, disable AirPlay Receiver in System Settings → General → AirDrop & Handoff.
