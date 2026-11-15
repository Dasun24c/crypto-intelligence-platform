# ADR 010: Valkey as the Redis-compatible store

| | |
|---|---|
| Status | Accepted. Verified in Phase 1 (2026-11-10): Valkey 9.1.3 is used |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval, decision D4) |
| Related | [Feasibility §7.3](../phase-0/02-feasibility.md#73-licences-and-checks-for-phase-1) · [Feasibility §7.2](../phase-0/02-feasibility.md#72-pinned-versions) · [Risks R23](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [Architecture §3](../phase-0/03-architecture.md#3-containers) · [README decision D4](../phase-0/README.md#decisions-needed) · [ADR 003](003-redis-streams-and-bullmq.md) |

## Context

The platform needs a Redis-compatible store for streams, pub/sub, BullMQ queues, caches, leases and the Socket.IO adapter (ADR 003, ADR 007). Two licensing facts matter (feasibility §7.3):

- Redis 8.x is licensed RSALv2, SSPLv1 or AGPLv3.
- Valkey is licensed BSD-3.

BullMQ (6.7.2) documents support for Redis 6.2 and later but does not list Valkey (R23). BullMQ carries the queues that hold the only non-rebuildable data in Redis, so we need evidence before relying on Valkey.

## Decision

Rule approved as decision D4:

- **Use Valkey 9.1.3** if BullMQ's own integration test suite passes on it during Phase 1.
- **Otherwise use unmodified Redis 8.10.3**, for internal use only. The AGPLv3 obligations are noted in feasibility §7.3.

Either way, the store runs as a single node with AOF `everysec` and `maxmemory-policy noeviction`, which BullMQ requires (architecture §15). Switching stores means changing the image tag in `infra/docker/compose.dev.yaml` and in the three Testcontainers global setups (`apps/api`, `apps/jobs`, `packages/observability`); no code changes.

## Consequences

**Positive**

- If Valkey passes, we use a permissively licensed store and avoid AGPL, RSAL and SSPL questions entirely.
- The fallback is defined in advance. The Phase 1 outcome changes one image, not the design.

**Negative and costs**

- Until the spike finishes, the choice is not confirmed. Work that depends on the store must not rely on Valkey-only behaviour.
- If we fall back to Redis 8, the platform must stay internal. Wider distribution would need a licence review (this lines up with risk R20 on market-data licensing, which also limits distribution).
- BullMQ's test suite passing is evidence, not a guarantee. Production behaviour still needs our own integration and chaos tests.

**What we must do because of it**

- Run BullMQ's integration test suite against Valkey 9.1.3 in Phase 1, and record the result in the Verification section below.
- Keep integration tests (Testcontainers) and CI parametrised on the image, so both stores can be tested.
- Watch BullMQ release notes for official Valkey support (watch list in the risk register).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Redis 8** (8.10.3) | Kept as the fallback. Its licences (RSALv2, SSPLv1, AGPLv3) are more restrictive, and BullMQ lists Redis as supported, so it is the safe option if the Valkey check fails. |

## Verification

Run on 2026-11-10 in `node:26.13.0-bookworm-slim` containers, against BullMQ cloned at tag `v6.7.2` and built (`yarn build`) before testing. Redis 8.10.3 ran the same suites as a control.

| Suite | Valkey 9.1.3 | Redis 8.10.3 (control) |
|---|---|---|
| BullMQ default suite (`yarn test`, 48 files) | 1,128 passed, 3 skipped, 0 failed (375 s) | 1,128 passed, 3 skipped, 0 failed (377 s) |
| BullMQ ioredis-specific suite (`yarn test:ioredis`, 6 files) | 203 passed, 11 skipped, 1 failed | `relay.ioredis.test.ts`: 26 of 26 passed |

The one failure is `Relay on ioredis > requires Redis 6.2`. The test overwrites the connection's version with `6.0.20` and expects the optional Relay feature to refuse to start. BullMQ's version check (`isRedisVersionLowerThan(version, minimum, databaseType)`) deliberately does not apply Redis version numbers to Valkey connections, so the faked number has no effect. This is an artefact of the test, not a functional difference, and the platform does not use the Relay feature.

Our own integration tests also run on Valkey 9.1.3: the jobs service's maintenance queue (job scheduler, processing, failure reporting), the api's Lua token-bucket rate limiter, refresh-token and MFA state, and service heartbeats. They pass, and the local Compose stack runs on Valkey with AOF `everysec` and `noeviction`.

**Outcome:** the D4 condition is met. Valkey 9.1.3 is the store; Redis 8.10.3 remains the documented fallback.
