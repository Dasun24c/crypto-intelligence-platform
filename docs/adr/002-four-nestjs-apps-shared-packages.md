# ADR 002: Four NestJS apps sharing framework-free packages

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §1 Principles](../phase-0/03-architecture.md#1-principles) · [Architecture §3 Containers](../phase-0/03-architecture.md#3-containers) · [Architecture §4 Monorepo](../phase-0/03-architecture.md#4-monorepo) · [Risks R11, R29](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 001](001-pnpm-turborepo-monorepo.md) |

## Context

Four kinds of work run side by side with very different profiles:

- **Ingestion** holds long-lived venue connections and must stay responsive. Reconnecting late creates data gaps.
- **Analysis** is CPU-heavy: indicators and the SMC engine run on every candle close.
- **Jobs** call a paid external API (Grok), send notifications and run backfills. Only this part may hold the Grok key.
- **The API and gateway** serve users and should scale horizontally.

Principle 2 of the architecture also says the deterministic core (indicators, SMC engine) is pure TypeScript with I/O at the edges.

## Decision

Build four NestJS applications, `api`, `ingestor`, `analyzer` and `jobs`, that share framework-free packages (`domain`, `contracts`, `exchange-adapters`, `market-data`, `indicators`, `smc-engine` and others). The business logic lives in the packages. Each app only wraps it with persistence, messaging and networking.

All four ship in **one `server` image** with different entrypoints. Inside each app the layers are domain, application (use cases and ports), infrastructure and interface, so tests can swap in fakes.

| App | Scaling |
|---|---|
| api | Stateless, horizontal |
| ingestor | One active instance per venue (Redis lease), optional warm standby |
| analyzer | Partitioned by instrument through Redis leases |
| jobs | Horizontal, with per-queue concurrency and rate limits |

## Consequences

**Positive**

- A slow analysis step cannot delay venue message handling.
- Least privilege is possible: the Grok key and outbound access to xAI exist only in `jobs`, and each service has its own database credentials.
- The pure packages are testable without NestJS, Redis or a database, and the same engine serves live runs and replays.
- The scaling path (more analyzer or api replicas) needs no redesign (architecture §17).

**Negative and costs**

- Services communicate through Redis and the database, so we need the event backbone (ADR 003) and leases with fencing.
- More processes to run, health-check and observe than a single process. A single VM is still a single point of failure (R29).

**What we must do because of it**

- Enforce the package dependency rules in CI (see ADR 001).
- Test services with a real PostgreSQL and a real Redis-compatible store (Testcontainers), and with chaos tests for restarts.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **One monolith process** | Simpler to run, but it couples latency-sensitive ingestion to CPU-heavy analysis (architecture §20). It would also put the Grok key in the process that faces users. |
| Kubernetes-style services from the start | Rejected by principle 7, "Boring infrastructure first". Compose on one VM is enough, and Kubernetes comes only if scale demands it. |
