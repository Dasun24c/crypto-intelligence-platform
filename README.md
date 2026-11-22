# Crypto Intelligence Platform

Real-time monitoring and analysis of crypto markets, and of gold through the PAXG token: market data from Binance and Coinbase, technical indicators, Smart Money Concepts detection, AI analysis with Grok, alerts, and a web and desktop app.

**Status:** Phase 12 (Historical analytics and replay UI) was accepted on 2026-11-22; see the [Phase 12 acceptance report](docs/phase-12/acceptance-report.md) and [ADR 026](docs/adr/026-historical-analytics-and-replay-ui.md). The **Historical Analytics** page (`/history`) shows how past setups ended, by pattern, variant, direction, timeframes, instrument, session and rules version, labelled as historical observations and never as expected performance, straight from the stored setups; it starts replays of stored periods (analysts and admins can change some settings for one replay), compares a replay with the live run or another replay (digests, the settings that differ, the detections that differ), and downloads CSV files, each download audited. Phase 11 (Whale Tracker) was accepted on 2026-11-21, with the on-chain watcher's live push (criterion 11.2) and the providers' terms (11.4) carried forward until it runs on a computer where that traffic is allowed; see the [Phase 11 acceptance report](docs/phase-11/acceptance-report.md) and [ADR 025](docs/adr/025-whale-tracker.md). The **Whale Tracker** page (`/whales`) shows large trades and order-book walls on the exchanges and, in a separate tab, large transfers on the blockchains and PAXG's mints and burns. The on-chain watcher connects to blockchain providers (mempool.space, and Alchemy with your key in `.secrets-jobs/alchemy-api-key`) only when the stack runs with `ONCHAIN_ENABLED=true`; it is off by default, and stays off on the development laptop (your choice, 2026-11-21). Phase 10 (3D visualization) was accepted on 2026-11-16, with the Apple M1 and macOS WKWebView checks carried forward; see the [Phase 10 acceptance report](docs/phase-10/acceptance-report.md). The **System Brain** page (`/brain`) is a live 3D view of what the platform is doing, driven only by what the services report each second (venue messages, analysis, AI calls, alerts) and by real detections, with a text status beside it, a 2D view, and a pause; see [ADR 024](docs/adr/024-activity-feed-and-3d-brain.md). Phase 9 (AI intelligence) was accepted on 2026-11-16, with a real Grok call with your key (criterion 9.1) carried forward; see the [Phase 9 acceptance report](docs/phase-9/acceptance-report.md). Grok explains significant market events from a context the server builds; every answer is checked against the data before it is shown, every analysis is kept, and a budget caps the spending. Phases 1–12, 14 and 16 are accepted; see the [Phase 16 acceptance report](docs/phase-16/acceptance-report.md). With Phase 16 (Automatic practice trading, [proposal 002](docs/proposals/002-automatic-practice-trading.md), [ADR 022](docs/adr/022-automatic-practice-trading.md)) a user can switch on automatic practice trading for their own practice account: on each confirmed bullish setup that matches their rules, the broker places a practice limit buy with a stop and a target (10 USDT a buy by default, or sized by the position-size calculator at their risk per trade), within their limits (open trades, orders per day, the day's loss). Every decision is logged with its reason; automatic orders are labelled, audited and alerted (switching it on offers notifications of each automatic buy, fill, stop or target sale and pause); a stop button cancels them. Practice balances only: no real money, nothing reaches an exchange, and the AI never decides an order. In Phase 14 (Practice trading), every user got a practice account per venue: they buy and sell with market and limit orders, attach a protective stop and a target, cancel, and see balances, holdings, profit and loss and their history. Orders are simulated inside the platform by a new broker service, which fills them from the venues' live trades and order books, with fees, slippage and the venues' order rules; nothing reaches an exchange and no real money is involved. A person places every order: "Practise this setup" only fills in the ticket. Practice fills can raise alerts. See the [Phase 8 report](docs/phase-8/acceptance-report.md) for alerts and notifications, and the [implementation plan](docs/phase-0/08-implementation-plan.md).

## Quick start

You need Docker with Compose v2.20 or later (Docker Desktop on Windows and macOS). From a fresh clone:

```bash
docker compose up --build --wait
```

This builds the images, generates local secrets into `.secrets/` on first start, creates the database, runs the migrations, seeds the development users and waits until every service reports healthy. Then open <http://localhost:8080>.

| Development user | Role | Password |
|---|---|---|
| `viewer@cip.test` | viewer | `local-dev-password` |
| `analyst@cip.test` | analyst | `local-dev-password` |
| `admin@cip.test` | admin | `local-dev-password` (sets up an authenticator app at first sign-in) |

These three are yours. The end-to-end tests and the test scripts sign in as their own accounts, never as yours: `e2e-viewer@cip.test`, `e2e-analyst@cip.test` and `e2e-admin@cip.test`, with the same password. The tests reset those accounts' practice balances, switch their automatic trading on and off, make and delete their alert rules, and use up their sign-in attempts. The confirmed setups a test appends to `an:events` would reach every account's automatic trading, so `e2e/tests/phase16.spec.ts` skips itself, and `practice-latency.mjs --auto` refuses to run, while automatic trading is on for any other account. The test admin's authenticator secret stays in `e2e/.auth/e2e-admin-totp.txt` (gitignored). A stack started before the test accounts existed gets them from `docker compose up --build --wait` (or, without restarting anything, `docker compose build secrets` and then `docker compose run --rm --no-deps migrate`).

The economic calendar syncs from BEA without a key. For CPI and the Employment Situation it needs a free [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html): put it, alone on one line, in `.secrets/fred-api-key` (created empty on first start; never commit it). The next sync picks it up; until then checklist item 8 fails safe as "calendar unavailable". This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.

The AI analyses need an [xAI API key](https://console.x.ai) for Grok: put it, alone on one line, in `.secrets-jobs/grok-api-key` (created empty on first start; never commit it). Only the jobs service mounts that folder, and it reads the file at every call, so no restart is needed. Without a key nothing is sent to Grok: the AI Intelligence Center shows Grok as down and holds requests. The spending caps ($5 a day, $100 a month by default) are in the admins' AI settings (`/admin/settings/ai`).

These users exist only in the local stack (`seed-dev` refuses to run outside `NODE_ENV=development`). Override the password with `DEV_SEED_PASSWORD` before the first start.

| Command | Effect |
|---|---|
| `docker compose up --build --wait` | Start (or update) the stack |
| `docker compose down` | Stop it; data is kept |
| `docker compose down --volumes` | Stop it and delete the database and Valkey data (delete `.secrets/` too for new secrets; `.secrets-jobs/` holds your Grok key) |
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

| Practice trading command | Effect |
|---|---|
| `node scripts/practice-latency.mjs [minutes]` | Submitted → published latency of practice fills (NFR-16: p95 ≤ 1 s), market orders and waiting orders, on the Redis clock |
| `node scripts/practice-latency.mjs --drive [orders] [minutes]` | Places practice orders as the tests' viewer first (simulated; practice balances only), then measures |
| `node scripts/practice-latency.mjs --auto [setups] [minutes]` | Switches on the tests' viewer's automatic practice trading for BTC/USDT, appends synthetic confirmed setups to `an:events`, switches it off, then measures NFR-17: setup confirmed → automatic order published, p95 ≤ 2 s. It reads the audit log as the tests' admin (run the admin end-to-end spec once first) and refuses while automatic trading is on for another account |
| `docker compose exec broker node apps/broker/dist/cli.js replay [--since <seq>]` | Replays the practice journal and compares every fill and every automatic decision with what was stored (criteria 14.3 and 16.6); read-only |

### HTTPS for the desktop app (optional)

The desktop app's release builds accept only `https://` servers, and the local stack serves plain HTTP. To connect an installed desktop app to the local stack:

1. Run `node scripts/dev-tls.mjs`. It needs `openssl` (Git for Windows includes it), and writes to `.secrets/tls`:
   - a certificate authority that can sign only for `localhost` and `127.0.0.1`. Its private key is deleted once it has signed the next item, so it can never sign anything else;
   - the certificate for `https://localhost:8443`.
2. Trust that authority for your own user. This is a change to your computer's trusted certificates, so it is yours to make.
   - On Windows: `Import-Certificate -FilePath .secrets\tls\cip-local-ca.crt -CertStoreLocation Cert:\CurrentUser\Root`, and confirm the dialog after comparing its thumbprint with `openssl x509 -in .secrets/tls/cip-local-ca.crt -noout -fingerprint -sha1`.
   - On macOS: add it to the login keychain with Keychain Access, and set it to "Always Trust".
3. `docker compose up -d --build web`. The stack is then also on `https://localhost:8443` (use the name, not `127.0.0.1`); `http://localhost:8080` is unchanged.

To undo it on Windows: `Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like '*CIP local development CA*' | Remove-Item`. Then delete `.secrets/tls`.

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
apps/        api, ingestor, analyzer, jobs (NestJS); broker (practice fills); web (Vite); desktop (Tauri 2)
packages/    contracts (zod), db (migrations, Kysely), observability, app (React; the 3D brain on React Three Fiber),
             ui (design system), config, ai (the Grok client, grounding checks, budget),
             domain (candles, decimals, closures), exchange-adapters (venues, replay), market-data (books, candles, detection),
             indicators (RSI, MACD, EMA, ATR, VWAP, volume anomaly, trend; checked against TA-Lib),
             smc-engine (the SMC rulebook as a deterministic reducer; golden fixtures, property tests),
             alerts (rule evaluation), paper-engine (practice orders and fills as a deterministic reducer)
tools/       recorder for venue messages; reference-data (TA-Lib datasets, dev-only Python)
infra/docker Dockerfile, Compose stack, Caddyfile, dev secret generation
e2e/         Playwright smoke tests
scripts/     CI guards (no exchange private endpoints, artefact scan), live smoke test, analysis and practice latency
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
- [Phase 7 acceptance report](docs/phase-7/acceptance-report.md)
- [Phase 8 acceptance report](docs/phase-8/acceptance-report.md)
- [Phase 14 acceptance report](docs/phase-14/acceptance-report.md)
- [Phase 12 acceptance report](docs/phase-12/acceptance-report.md)
- [Proposal 001: buying and selling](docs/proposals/001-trading.md) (approved 2026-11-13): practice trading, then exchange test networks; no real money in the initial release
- [Proposal 002: automatic practice trading](docs/proposals/002-automatic-practice-trading.md) (approved 2026-11-15): a user's own rules trade their practice balance; Phase 16, after Phase 14
- [Desktop app](apps/desktop/README.md)

The platform is for analysis and education. It holds no exchange API keys and places no order on any exchange: practice trading is simulated inside the platform, with practice balances and no real money. It never presents analysis, or simulated results, as a guaranteed prediction.
