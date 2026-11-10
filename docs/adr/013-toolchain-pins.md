# ADR 013: Toolchain pins confirmed in Phase 1

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Phase 1 implementation, within the rules approved in Phase 0 (decisions D3 and D4) |
| Related | [Feasibility §7](../phase-0/02-feasibility.md#7-stack-versions-and-licences) · [Implementation plan, criterion 1.7](../phase-0/08-implementation-plan.md#phase-1--foundations) · [ADR 001](001-pnpm-turborepo-monorepo.md) · [ADR 010](010-valkey-redis-compatible-store.md) |

## Context

Phase 0 pinned the toolchain provisionally and left three questions for Phase 1 (risk R25): does Node.js 26 run the native modules, does TypeScript 7 handle NestJS decorators, and does BullMQ work on Valkey. Phase 1 also met three facts the feasibility study could not have known: TypeScript 7 ships no compiler API, NestJS 12 is ESM-only, and OpenTelemetry JS 3.0 (released 2026-10-20) merged its tracing SDKs.

## Decision

| Area | Pin | Evidence |
|---|---|---|
| Node.js | **26.13.0** (fallback 24.22.2 not needed) | A NestJS 12 app, `@node-rs/argon2` 2.2.2 and `argon2` 0.45.2 (both native) ran on `node:26.13.0-bookworm-slim`; hashes cross-verify. All tests in this repository run on 26.13.0, on Windows (pnpm downloads it per project) and in Docker. |
| TypeScript, type-checking | **7.0.2** as `tsc` | Compiled a NestJS app with `experimentalDecorators` and `emitDecoratorMetadata`: `design:paramtypes` is emitted and type-based dependency injection works. All 11 projects type-check with it. |
| TypeScript, compiler API | **6.0 via `@typescript/typescript6` 6.0.2** | TypeScript 7.0 has no API, and typescript-eslint 8.72 stops with "does not support TS 7.0". Following Microsoft's announcement ("running side by side with TypeScript 6.0"), the package `typescript` is aliased to the TS 6 compatibility package for tools that import it (typescript-eslint, dependency-cruiser, `@swc-node/register`), while `@typescript/native` aliases `typescript@7.0.2` and provides `tsc`. |
| JavaScript emit | **SWC 1.16** for server code, **Vite 8.3** for clients | SWC emits the decorator metadata NestJS needs (verified alongside TS 6 and TS 7). Vitest uses `unplugin-swc` for NestJS code for the same reason. |
| Module format | **ESM everywhere** (`"type": "module"`) | NestJS 12 is published as ESM only. |
| Package manager | **pnpm 12.18.0** | `devEngines.runtime` makes pnpm download Node 26.13.0 for this project, so a developer's global Node version does not matter. |
| Redis-compatible store | **Valkey 9.1.3** | ADR 010. |
| OpenTelemetry | **3.1.0** line (`@opentelemetry/sdk-trace` + `context-async-hooks`), API 1.10.0 | `sdk-trace-base`/`sdk-trace-node` 2.x are deprecated in favour of `sdk-trace` 3.x. |
| Container images | pinned by digest | `node:26.13.0-bookworm-slim`, `timescale/timescaledb:2.31.0-pg18`, `valkey/valkey:9.1.3`, `caddy:2.11.9-alpine`, `zricethezav/gitleaks:v8.30.1`. |

**Workspace resolution (replaces the project-references detail of ADR 001).** Each workspace package exports its TypeScript sources under a custom condition, `@cip/source`, and its build output under `default`. TypeScript (`customConditions`), Vite and Vitest resolve the sources directly, so type-checking, tests and dev servers never wait for a package build; Node.js at run time uses the built `dist/`. TypeScript project references would need declaration builds for every package and add little at this size.

**Supply-chain settings in pnpm 12, kept on.** Dependencies may run install scripts only when listed in `allowBuilds` (all current entries are `false`: none is needed). The default minimum release age refuses versions published less than a day ago; when a pin hit it, we pinned the previous release instead of adding an exception. That moved NestJS 12.4.2 → 12.4.0, jose 6.2.17 → 6.2.16, Vite 8.3.7 → 8.3.6, `@vitejs/plugin-react` 6.3.0 → 6.2.1, typescript-eslint 8.72.2 → 8.72.1 and OpenTelemetry 3.1.1 → 3.1.0. The lockfile is the final record of every version.

## Consequences

**Positive**

- Type-checking uses the fast native compiler while linting keeps full type information.
- Builds no longer depend on TypeScript's emitter, so a later move to TypeScript 7.1 (which is expected to bring a new API) only changes the alias.
- New contributors need only Docker, or pnpm: Node 26 arrives with the install.

**Negative and costs**

- Two TypeScript versions are installed. They must not diverge in what they accept; typescript-eslint and `tsc` disagreeing would show up as lint-only or type-only errors.
- The `@cip/source` condition must be configured in every tool that resolves workspace packages (tsconfig, Vite, Vitest's three environments, dependency-cruiser). The shared `vitest.shared.ts` keeps that in one place for server packages.
- Pinning one release behind the newest means picking up fixes a day later.

**What we must do because of it**

- When typescript-eslint supports TypeScript 7.1 or later, drop the `@typescript/typescript6` alias (watch list).
- Keep `allowBuilds` explicit: a new dependency that wants an install script fails the install until someone reviews it.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| TypeScript 6.0 only (the approved fallback) | Works, but gives up TypeScript 7's speed for no benefit, since the side-by-side setup is officially supported. |
| `tsc` for emit as well | Would tie builds to one compiler's emitter and need project references for declaration output. SWC is faster and independent of the TypeScript major version. |
| TypeScript project references (ADR 001's original detail) | Declaration builds for every package, and slower feedback in tests and dev servers. |
| Adding release-age exceptions for the newest versions | Weakens a supply-chain control to gain one day of freshness. |
