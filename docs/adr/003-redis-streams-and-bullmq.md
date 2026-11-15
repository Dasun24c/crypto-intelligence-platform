# ADR 003: Redis Streams for data flow, BullMQ for units of work

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §6 Event backbone](../phase-0/03-architecture.md#6-event-backbone) · [Architecture §15 Data storage](../phase-0/03-architecture.md#15-data-storage) · [API contracts §5.4](../phase-0/06-api-contracts.md#54-sequencing-and-resync) · [ADR 002](002-four-nestjs-apps-shared-packages.md) · [ADR 010](010-valkey-redis-compatible-store.md) |

## Context

Services need two different kinds of messaging:

1. **A flow of ordered facts**: candles are final, a gap opened, a setup changed state. Several consumers read each fact, and a client that reconnects needs to catch up from where it stopped. Order matters.
2. **Units of work** with retries, rate limits, scheduling and deterministic ids: AI analysis, notifications, backfill, replay, calendar sync and similar.

Principle 3 says the database is the source of truth. Redis carries notifications, queues, caches and leases, and everything in it can be rebuilt, except queued jobs.

## Decision

Use both, each for what it fits:

- **Redis Streams** for data flow: `md:candles:{instrumentId}`, `md:events`, `an:events`, `ai:events`, `alerts:events` and `sys:activity`. The candle stream carries only a wake-up. The analyzer reads the candles themselves from PostgreSQL.
- **BullMQ queues** for units of work: `ai-analysis`, `notifications`, `backfill`, `replay`, `calendar-sync`, `pair-status`, `closure-calendar`, `maintenance` and `onchain`.
- **Pub/sub through the Socket.IO Redis emitter** for high-frequency, conflated data (ticker, book, in-progress candles), with no replay (see ADR 007).

Streams are capped (`MAXLEN ~`) at about 7 days of entries. Every api instance reads every stream with its own cursor. Leases (15 s TTL, renewed every 5 s) carry a fencing epoch, and checkpoint writes are guarded by `lease_epoch`. Detection inserts use unique keys that include `run_id`, and BullMQ job ids are deterministic.

## Consequences

**Positive**

- Stream entry ids give clients a `seq` for resync after a reconnect.
- Each mechanism is used for its strength: ordering for streams, retries and rate limits for queues.
- Idempotent writes make retries and redelivery safe.

**Negative and costs**

- Two mechanisms to learn, monitor and size. Queue depth and wait time are exported as metrics (architecture §16).
- Redis must be configured for durability: AOF `everysec` and `maxmemory-policy noeviction`, which BullMQ requires. Queued jobs are the one thing in Redis that is not rebuildable.
- Once entries are older than the cap, a stream cannot replay them, so clients fall back to a snapshot.

**What we must do because of it**

- Run integration tests with Testcontainers against a real Redis-compatible store, including restart and chaos cases.
- Keep BullMQ job ids deterministic and detection inserts idempotent.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **BullMQ for everything** | Per-candle jobs lose ordering (architecture §20). |
| **Kafka** | Heavy for this scale (architecture §20). It adds a service that principle 7, "Boring infrastructure first", argues against. |
| Redis pub/sub alone for events | It has no replay. The architecture uses it only for conflated high-frequency data. Durable events need stream ids. |
