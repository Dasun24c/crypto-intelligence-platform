# Crypto Intelligence Platform

Real-time monitoring and analysis of crypto markets, and of gold through the PAXG token: market data from Binance and Coinbase, technical indicators, Smart Money Concepts detection, AI analysis with Grok, alerts, and a web and desktop app.

**Status:** Phase 1 (Foundations) is built and awaiting acceptance. It delivers the platform's base: sign-in with MFA, roles, a hash-chained audit log, user administration, System Health, the four backend services as running skeletons, the web and desktop shells, the Docker stack and the CI pipeline. Market data starts in Phase 2. See the [Phase 1 acceptance report](docs/phase-1/acceptance-report.md) and the [implementation plan](docs/phase-0/08-implementation-plan.md).

## Quick start

You need Docker with Compose v2.20 or later (Docker Desktop on Windows and macOS). From a fresh clone:

```bash
docker compose up --build --wait
```

This builds the images, generates local secrets into `.secrets/` on first start, creates the database, runs the migrations, seeds three development users and waits until every service reports healthy. Then open <http://localhost:8080>.

| Development user | Role | Password |
|---|---|---|
| `viewer@cip.test` | viewer | `local-dev-password` |
| `analyst@cip.test` | analyst | `local-dev-password` |
| `admin@cip.test` | admin | `local-dev-password` (sets up an authenticator app at first sign-in) |

These users exist only in the local stack (`seed-dev` refuses to run outside `NODE_ENV=development`). Override the password with `DEV_SEED_PASSWORD` before the first start.

| Command | Effect |
|---|---|
| `docker compose up --build --wait` | Start (or update) the stack |
| `docker compose down` | Stop it; data is kept |
| `docker compose down --volumes` | Stop it and delete the database and Valkey data (delete `.secrets/` too for new secrets) |
| `docker compose logs -f api` | Follow one service's logs |

Host ports are bound to `127.0.0.1` only: web `8080`, api `3000`, PostgreSQL `15432`, Valkey `16379`. Change them with `CIP_WEB_PORT`, `CIP_API_PORT`, `CIP_DB_PORT` and `CIP_VALKEY_PORT`.

## Development

Install pnpm 12 (`corepack enable` with Node 24 or earlier, or the [standalone installer](https://pnpm.io/installation)). Then:

```bash
pnpm install
```

pnpm downloads Node.js 26.13.0 for this project (`devEngines` in `package.json`), so your global Node version does not matter. Dependencies are not allowed to run install scripts unless listed in `pnpm-workspace.yaml`, and versions published less than a day ago are refused.

| Command | What it runs |
|---|---|
| `pnpm verify` | Everything the CI `checks` job runs: format, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, build, artefact scan |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Integration tests against real TimescaleDB and Valkey containers (Testcontainers; needs Docker) |
| `pnpm e2e` | Playwright smoke tests against the running stack (`pnpm exec playwright install chromium` once) |
| `pnpm lint`, `pnpm typecheck`, `pnpm depcruise` | Individual checks |
| `pnpm --filter @cip/web dev` | Web app with hot reload on <http://localhost:5173>, proxying `/api` to `CIP_DEV_API_URL` (default `http://localhost:3000`, the stack's api) |
| `pnpm --filter @cip/api dev` | The api from source with reload, on port 3001; copy `apps/api/.env.example` to `apps/api/.env` first (the other services have the same kind of example file) |
| `pnpm --filter @cip/desktop dev` | The desktop app (needs Rust; see [apps/desktop/README.md](apps/desktop/README.md)) |

### Layout

```
apps/        api, ingestor, analyzer, jobs (NestJS); web (Vite); desktop (Tauri 2)
packages/    contracts (zod), db (migrations, Kysely), observability, app (React), ui (design system), config
infra/docker Dockerfile, Compose stack, Caddyfile, dev secret generation
e2e/         Playwright smoke tests
scripts/     CI guards: no exchange private endpoints, artefact scan
docs/        Phase 0 design, ADRs, phase acceptance reports
```

Workspace packages are consumed from source through the `@cip/source` export condition ([ADR 013](docs/adr/013-toolchain-pins.md)); dependency rules between them are enforced by dependency-cruiser ([architecture §4](docs/phase-0/03-architecture.md#4-monorepo)).

## Documentation

- [Phase 0: analysis and design](docs/phase-0/README.md): requirements, feasibility, architecture, risks, data model, API contracts, SMC rulebook, implementation plan
- [Architecture decision records](docs/adr/README.md)
- [Phase 1 acceptance report](docs/phase-1/acceptance-report.md)
- [Desktop app](apps/desktop/README.md)

The platform is for analysis and education. It holds no exchange API keys, implements no trading, and never presents analysis as a guaranteed prediction.
