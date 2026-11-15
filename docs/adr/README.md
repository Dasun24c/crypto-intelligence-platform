# Architecture Decision Records

An Architecture Decision Record (ADR) records one significant decision: the context, what was decided, the consequences and the alternatives that were considered. The first twelve ADRs come from the Phase 0 design, which the project owner approved on 2026-11-10 ([architecture §20](../phase-0/03-architecture.md#20-architecture-decisions-summary)). Status values are **Proposed**, **Accepted** and **Superseded by NNN**. A new ADR gets the next number. An ADR is never edited to reverse a decision: a new ADR supersedes it, and the old one only has its status changed to "Superseded by NNN".

| # | Title | Status | Date |
|---|---|---|---|
| [001](001-pnpm-turborepo-monorepo.md) | pnpm workspaces and Turborepo monorepo | Accepted (project-references detail replaced by 013) | 2026-11-10 |
| [002](002-four-nestjs-apps-shared-packages.md) | Four NestJS apps sharing framework-free packages | Accepted | 2026-11-10 |
| [003](003-redis-streams-and-bullmq.md) | Redis Streams for data flow, BullMQ for units of work | Accepted | 2026-11-10 |
| [004](004-smc-engine-event-sourced-reducer.md) | SMC engine as an event-sourced pure reducer with checkpoints | Accepted | 2026-11-10 |
| [005](005-analysis-pauses-at-data-gaps.md) | Analysis pauses at data gaps | Accepted | 2026-11-10 |
| [006](006-kysely-sql-first-migrations.md) | Kysely with SQL-first migrations | Accepted | 2026-11-10 |
| [007](007-socketio-websocket-only.md) | Socket.IO, WebSocket-only, with Redis adapter and emitter | Accepted (adapter and emitter superseded by 014) | 2026-11-10 |
| [008](008-desktop-thin-tauri-client.md) | Desktop as a thin Tauri client | Accepted | 2026-11-10 |
| [009](009-built-in-auth.md) | Built-in authentication (argon2id, TOTP, rotating refresh tokens) | Accepted | 2026-11-10 |
| [010](010-valkey-redis-compatible-store.md) | Valkey as the Redis-compatible store | Accepted, verified in Phase 1 | 2026-11-10 |
| [011](011-ai-grounded-citations.md) | AI cites ids from a provided context and the server validates grounding | Accepted | 2026-11-10 |
| [012](012-ta-lib-reference-data.md) | Indicator reference data generated with TA-Lib in a dev-only Python tool | Accepted (TA-Lib's arithmetic settled in 016) | 2026-11-10 |
| [013](013-toolchain-pins.md) | Toolchain pins confirmed in Phase 1 | Accepted | 2026-11-10 |
| [014](014-live-fan-out-without-socketio-adapter.md) | Live fan-out over Redis pub/sub and `md:events`, without the Socket.IO Redis adapter | Accepted | 2026-11-10 |
| [015](015-replay-venue.md) | The replay venue plays recordings through the production adapters | Accepted | 2026-11-10 |
| [016](016-indicators-match-ta-lib-fma-arithmetic.md) | Indicators match TA-Lib 0.8's arithmetic, fused multiply-add included | Accepted | 2026-11-10 |
| [017](017-smc-runtime-boundaries-ids-digests-replays.md) | The SMC runtime steps boundaries, derives ids from natural keys, and runs replays in the analyzer | Accepted | 2026-11-11 |
