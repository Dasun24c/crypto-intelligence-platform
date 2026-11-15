# Crypto Intelligence Platform

Real-time monitoring and analysis of crypto markets, and of gold through the PAXG token: market data from Binance and Coinbase, technical indicators, Smart Money Concepts detection, AI analysis with Grok, alerts, and a web and desktop app.

**Status:** Phase 6 (Patterns, checklist and outcomes) is built and awaiting acceptance. The SMC engine now also finds the four setup patterns and follows each setup from "Watching" to its outcome: the sweep-anchored MSS, a hypothetical entry, invalidation and targets, the confluence checklist with its quality flags, and the result in R. Every transition is recorded with its candle and evidence. The API serves setups with their history and checklist, the live channels publish each transition, and `domain` has a position-size calculator. All of it is hypothetical analysis; nothing places an order. Phases 1–5 (Foundations, Market data, Technical analysis, SMC structure and liquidity, SMC points of interest) are accepted. See the [Phase 6 acceptance report](docs/phase-6/acceptance-report.md), the [Phase 5 report](docs/phase-5/acceptance-report.md) and the [implementation plan](docs/phase-0/08-implementation-plan.md).

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

The stack streams the venues' public market data from the start; on first start it fetches 7 days of candle history per pair (`BACKFILL_DAYS`). Without network access to the venues, or for a demo, run it on the **replay venue** instead: recorded traffic played through the same code, every instrument labelled as a replay, nothing contacting the venues ([ADR 015](docs/adr/015-replay-venue.md)). Use a separate project so the replay instruments never mix with your live data:

```bash
COMPOSE_FILE=compose.yaml:infra/docker/compose.replay.yaml docker compose -p cip-replay up --build --wait
```

(PowerShell: `$env:COMPOSE_FILE='compose.yaml;infra/docker/compose.replay.yaml'`. It uses the same host ports, so stop the live stack first.)

| Market data command | Effect |
|---|---|
| `node scripts/live-smoke.mjs` | Checks that every enabled instrument streams, serves a ticker and writes candles (the nightly CI check) |
| `docker compose exec jobs node apps/jobs/dist/cli.js consistency [YYYY-MM-DD]` | Compares a UTC day's stored candles with the venues' REST candles (default: yesterday; it also runs nightly) |
| `node tools/recorder/record.mjs --venue binance --symbols BTCUSDT --seconds 130 --out file.jsonl` | Records public venue messages for tests and the replay venue |

| Analysis command | Effect |
|---|---|
| `node scripts/analysis-latency.mjs [redis://localhost:16379] [minutes]` | Candle close → published latency of indicator points (p95 ≤ 1 s) and SMC detections (p95 ≤ 2 s) |
| `docker compose exec analyzer node apps/analyzer/dist/cli.js replay <instrumentId> <from> <to>` | Replays a stored period (ISO times or epoch ms) and compares its digest with the live run's ([ADR 017](docs/adr/017-smc-runtime-boundaries-ids-digests-replays.md)) |
| `docker compose exec analyzer node apps/analyzer/dist/cli.js digest <runId> <from> <to>` | Prints a run's digest over a period |

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
packages/    contracts (zod), db (migrations, Kysely), observability, app (React), ui (design system), config,
             domain (candles, decimals, closures), exchange-adapters (venues, replay), market-data (books, candles, detection),
             indicators (RSI, MACD, EMA, ATR, VWAP, volume anomaly, trend; checked against TA-Lib),
             smc-engine (the SMC rulebook as a deterministic reducer; golden fixtures, property tests)
tools/       recorder for venue messages; reference-data (TA-Lib datasets, dev-only Python)
infra/docker Dockerfile, Compose stack, Caddyfile, dev secret generation
e2e/         Playwright smoke tests
scripts/     CI guards (no exchange private endpoints, artefact scan), live smoke test, analysis latency
docs/        Phase 0 design, ADRs, phase acceptance reports
```

Workspace packages are consumed from source through the `@cip/source` export condition ([ADR 013](docs/adr/013-toolchain-pins.md)); dependency rules between them are enforced by dependency-cruiser ([architecture §4](docs/phase-0/03-architecture.md#4-monorepo)).

## Documentation

- [Phase 0: analysis and design](docs/phase-0/README.md): requirements, feasibility, architecture, risks, data model, API contracts, SMC rulebook, implementation plan
- [Architecture decision records](docs/adr/README.md)
- [Phase 1 acceptance report](docs/phase-1/acceptance-report.md)
- [Phase 2 acceptance report](docs/phase-2/acceptance-report.md)
- [Phase 3 acceptance report](docs/phase-3/acceptance-report.md)
- [Phase 4 acceptance report](docs/phase-4/acceptance-report.md)
- [Phase 5 acceptance report](docs/phase-5/acceptance-report.md)
- [Phase 6 acceptance report](docs/phase-6/acceptance-report.md)
- [Desktop app](apps/desktop/README.md)

The platform is for analysis and education. It holds no exchange API keys, implements no trading, and never presents analysis as a guaranteed prediction.
