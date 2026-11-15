# ADR 006: Kysely with SQL-first migrations

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §15 Data storage](../phase-0/03-architecture.md#15-data-storage) · [Data model §8](../phase-0/05-data-model.md#8-hypertables-columnstore-and-retention) · [Data model §9](../phase-0/05-data-model.md#9-database-roles) · [Feasibility §7.3](../phase-0/02-feasibility.md#73-licences-and-checks-for-phase-1) · [Risks R24](../phase-0/04-risks-and-dependencies.md#1-risk-register) |

## Context

The database is the source of truth (principle 3). It is PostgreSQL with TimescaleDB, and the schema depends on features an ORM does not usually model: hypertables, columnstore (compression) policies, retention policies, continuous aggregates, several schemas (`market`, `analysis`, `ai`, `alerts`, `app`, `ops`), a hash-chain trigger on the audit log, and separate database roles per service.

TimescaleDB recently renamed its compression API to "columnstore", so policy function names must be confirmed when the first migration is written (R24).

## Decision

Use **Kysely** (pinned at 0.29.8 in feasibility §7.2) as the query builder, in the `db` package with repositories. Migrations are **plain SQL files**, run by the Kysely migrator, and types are **generated from the database**, so the database defines the types and not the other way round.

Migrations follow **expand/contract**: a deployment never needs a down-migration. In CI and deployment, migrations run first as a one-shot step before services restart. A dedicated `owner` role runs migrations and owns all objects. Services use their own least-privilege roles.

## Consequences

**Positive**

- TimescaleDB DDL (hypertables, columnstore, retention, triggers) is written directly as SQL, with no gap between what we want and what a schema DSL can express.
- Types come from the real schema, so a mismatch between code and database shows up as a compile error.
- Expand/contract keeps rolling restarts safe and removes down-migrations as a rarely tested code path.

**Negative and costs**

- More hand-written SQL than with an ORM. Reviewers need to read SQL.
- Kysely is a query builder, so there are no automatic relations or entity classes. Repositories do that work.
- Breaking changes need two deployments (expand, then contract).

**What we must do because of it**

- Confirm the TimescaleDB columnstore function names in the first migration (feasibility §11, Phase 1).
- Run integration tests against the real TimescaleDB image (Testcontainers) so migrations are exercised in every pull request.
- Add a CI step that regenerates types and fails on drift.
- Restore drills (architecture §15) double as a check on the migration history.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Drizzle or Prisma** | Weaker at TimescaleDB-specific DDL (architecture §20). A schema DSL would need raw SQL for the important parts anyway. |
| Query builder with code-first migrations | The sources do not consider it. Writing migrations as SQL keeps one source of truth for the schema, which is the point of this decision. |
