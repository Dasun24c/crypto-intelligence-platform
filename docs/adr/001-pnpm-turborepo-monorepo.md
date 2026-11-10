# ADR 001: pnpm workspaces and Turborepo monorepo

| | |
|---|---|
| Status | Accepted. The TypeScript project-references detail is replaced by [ADR 013](013-toolchain-pins.md) |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §4 Monorepo](../phase-0/03-architecture.md#4-monorepo) · [Architecture §18 CI/CD](../phase-0/03-architecture.md#18-cicd) · [Feasibility §7.2](../phase-0/02-feasibility.md#72-pinned-versions) · [ADR 002](002-four-nestjs-apps-shared-packages.md) |

## Context

The platform has four backend services, a web app, a desktop host and about a dozen shared packages (contracts, domain, indicators, the SMC engine, the database layer and others). The web and desktop apps share one React application, and the services share the same zod contracts and domain types. These parts change together, so they need one place where a contract change and all its users are built, tested and reviewed in a single pull request.

The architecture also relies on dependency rules between packages (see ADR 002). Those rules are only useful if they can be checked automatically.

## Decision

Use one repository managed with **pnpm workspaces**, **Turborepo** for task orchestration and caching, and **TypeScript project references** for incremental builds. The layout is `apps/`, `packages/`, `tools/`, `infra/` and `docs/`, as set out in architecture §4. Versions are pinned in feasibility §7.2 (pnpm 12.18.0, Turborepo 2.11.10). The lockfile created in Phase 1 is the final record.

## Consequences

**Positive**

- A change to `contracts` is type-checked against every consumer in one run.
- Turborepo caching keeps the pull-request pipeline (lint, typecheck, tests, image builds) fast enough to run on every push.
- One lockfile gives one place for OSV scanning, Renovate and the SBOM (architecture §14).

**Negative and costs**

- Everyone needs the pinned pnpm and Node versions. Node 26.13.0 is pinned, and developer machines may need a version manager (feasibility §7.1).
- A large repository makes every checkout bigger, and CI speed depends on cache quality.
- Turborepo has fewer built-in features than Nx (generators, project graph tooling), so we write small scripts where we need them.

**What we must do because of it**

- Enforce the dependency rules with dependency-cruiser in CI: `contracts` depends only on zod, `domain` on nothing internal, the pure packages never import NestJS, Redis or database code, and packages never import apps.
- Base the CI cache key on the lockfile and the Node version.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Nx** | More features, but more weight (architecture §20). We do not need its generators or project tooling at this size. |
| Separate repositories per service | Not chosen: contracts and domain types would need publishing and version-matching for every change. The Phase 0 documents do not evaluate this option in detail. |
