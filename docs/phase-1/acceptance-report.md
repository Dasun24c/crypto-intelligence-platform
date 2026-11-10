# Phase 1 · Foundations: acceptance report

| | |
|---|---|
| Status | Ready for your review. 4 criteria met; 2 met locally and waiting for their first GitHub run (D7); 1 partly verified (desktop sign-in on Windows and macOS); 1 not yet verified (desktop bundles in CI, D7) |
| Date | 2026-11-10 |
| Scope | [Implementation plan, Phase 1](../phase-0/08-implementation-plan.md#phase-1--foundations) |
| Evidence | Runs on this machine (Windows 11, Docker Desktop, Node.js 26.13.0), 2026-11-10 |

## Summary

Phase 1 delivers the base of the platform:

- sign-in with mandatory TOTP for admins, rotating refresh tokens with reuse detection, progressive lockout
- role-based access on every route, default deny
- a hash-chained, append-only audit log
- user administration and a System Health page fed by real service heartbeats
- the four backend services (api, ingestor, analyzer, jobs), all running; ingestor and analyzer honestly report "idle" until their phases
- the web app and the Tauri desktop shell sharing one React app
- a Docker Compose stack started by one command
- the CI pipelines, and the toolchain decisions recorded in ADRs

No market data is shown yet, and none is simulated. The Command Center says plainly what arrives in which phase.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1.1 | From a fresh clone, one documented command starts the dev stack, and every service reports healthy within 3 minutes | **Met** | `docker compose up --build --wait` ([README](../../README.md#quick-start)). After a full reset (volumes and secrets deleted) with changed code: images rebuilt, secrets generated, migrations and seed run, all 7 long-running services healthy in **104 s**. With images already built: **26 s**. A first build on a machine with an empty Docker cache also downloads images and packages and was not measured here; CI records the time in its step summary. |
| 1.2 | CI runs lint, typecheck, dependency rules, tests, build and a Playwright smoke test on every pull request; a deliberate violation of each check fails the pipeline | **Met locally; first GitHub run pending D7** | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) has three jobs: checks, integration and e2e. Locally, `pnpm verify` (everything in the checks job) passes in 151 s, the integration suites pass in 265 s and Playwright passes 4 of 4. [Violation proof](#deliberate-violations-criterion-12): each of the 9 checks fails on a planted violation. |
| 1.3 | Login works in the web app and in desktop development builds on Windows and macOS; admins can't log in without MFA; reusing a rotated refresh token revokes its whole family (integration test) | **Partly verified** | Web sign-in: Playwright, viewer and admin. Admins: `auth.int.test.ts` › *admins cannot sign in without a second factor* and the Playwright admin test. Reuse: `auth.int.test.ts` › *rotate on use; reusing a rotated token revokes the whole family*. **Not yet verified:** signing in from the desktop app on Windows and macOS. The desktop shell compiles (Rust check, clippy and tests in a Linux container), and its frontend builds against the shared app, but it has not been run on either OS: that needs the Rust toolchain locally or the CI bundles (1.8). |
| 1.4 | An automated test calls every endpoint with every role, and the results match the RBAC matrix | **Met** | `rbac.int.test.ts`: 20 endpoints × 4 callers (anonymous, viewer, analyst, admin) = 80 cases, plus a check that the table lists exactly the routes the app serves, so a new endpoint fails the test until its policy is declared. The expected policies are transcribed from API contracts §2–§3 and architecture §14, not read from the code. |
| 1.5 | Logins (success and failure) and user changes are audited; the hash chain verifies; the application role can't update or delete audit rows | **Met** | `audit.int.test.ts` covers sign-in success and failure, user created, role changed, disabled and MFA reset (each with the acting admin), chain verification through the API, and `svc_api` getting SQLSTATE 42501 on UPDATE, DELETE and TRUNCATE. `db.int.test.ts` covers the same refusal for the owner (append-only trigger), a contiguous chain under 40 concurrent writers, and detection of a row edited behind the triggers' back. |
| 1.6 | A CI scan of the built web and desktop artefacts finds no secrets or server environment names | **Met locally; GitHub run pending D7** | [`scripts/scan-artifacts.mjs`](../../scripts/scan-artifacts.mjs): 36 rules (29 server setting names, kept in step with every service's config schema by unit tests, plus key, token and connection-string patterns). The web build (14 files, 755 KiB) and the desktop frontend (10 files) pass. A planted `MFA_ENCRYPTION_KEY` is caught. CI also runs gitleaks 8.30.1 on the web build, and the desktop workflow scans the exact frontend it bundles. |
| 1.7 | Toolchain pins confirmed and recorded in ADRs: Node version, TypeScript version (NestJS decorators verified), Valkey passing the BullMQ integration tests (or Redis chosen instead) | **Met** | [ADR 013](../adr/013-toolchain-pins.md): Node 26.13.0, TypeScript 7.0.2 with decorator metadata verified, plus the TS 6 API alongside for linting. [ADR 010](../adr/010-valkey-redis-compatible-store.md): BullMQ 6.7.2's suite passed 1,128 of 1,128 on Valkey 9.1.3, identical to Redis 8.10.3. |
| 1.8 | Unsigned Tauri bundles build in CI for Windows x64 and macOS universal | **Not yet verified: needs D7** | [`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml) is ready (Windows x64 and macOS universal, unsigned, artefact scan before bundling). Locally verified: `cargo check`, `cargo clippy -D warnings` and 5 Rust unit tests pass in a Linux container, for both dev and production feature sets. The bundles themselves only build on GitHub's Windows and macOS runners. |

## Deliberate violations (criterion 1.2)

`bash scripts/prove-checks-fail.sh` plants one violation per check, runs the command CI runs and removes it again. A non-zero exit code means the check caught it.

| Check | Planted violation | Command | Exit code |
|---|---|---|---|
| Formatting | `packages/contracts/src/zz-format.ts` | `pnpm format:check` | 1 |
| Lint | `packages/contracts/src/zz-lint.ts` | `pnpm lint` | 1 |
| Typecheck | `packages/contracts/src/zz-types.ts` | `pnpm typecheck` | 1 |
| Dependency rules | `packages/contracts/src/zz-deps.ts` (Node I/O in a pure package) | `pnpm depcruise` | 2 |
| Unit tests | `packages/contracts/src/zz-fail.test.ts` | `pnpm --filter @cip/contracts test` | 1 |
| Build | `packages/contracts/src/zz-build.ts` | `pnpm --filter @cip/contracts build` | 1 |
| No exchange private endpoints | `packages/contracts/src/zz-trade.ts` | `pnpm check:no-trading` | 1 |
| Playwright smoke | `e2e/tests/zz-fail.spec.ts` | `pnpm e2e --grep 'fails on purpose'` | 1 |
| Artefact scan | `assets/zz-leak.js` in a copy of `apps/web/dist` | `pnpm scan:artifacts <dir>` | 1 |

The coverage gates also failed while coverage was below target (db at 48%, for example) and pass now.

## Tests and coverage

220 automated tests, all passing.

| Package | Tests | Kind | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| contracts | 37 | unit | 90% | 100% / 100% |
| observability | 15 | unit + Valkey integration | 70% | 94.7% / 83.0% |
| db | 14 | unit + TimescaleDB integration | 70% | 97.6% / 76.2% |
| api | 121 | unit + integration (TimescaleDB, Valkey) | 70% | 94.2% / 75.3% |
| jobs | 7 | unit + integration (BullMQ on Valkey) | 70% | 100% / 80.0% |
| ingestor, analyzer | 6 + 6 | unit | 70% | 86.7% / 100% each |
| app, ui | 7 + 3 | unit (jsdom) | none in Phase 1 | — |
| End to end | 4 | Playwright on the Compose stack | — | — |

NFR-15 asks for ≥ 90% on domain packages and ≥ 70% on services; entry points (`main.ts`, `cli.ts`) are excluded because the Compose stack and Playwright exercise them. The React app is covered by the Playwright tests rather than a unit-coverage gate for now.

## What was built

| Area | Where | Notes |
|---|---|---|
| Monorepo and tooling | root, `packages/config` | pnpm 12 workspaces, Turborepo, shared tsconfig presets, ESLint (type-aware), Prettier, dependency-cruiser rules from architecture §4 |
| Contracts | `packages/contracts` | zod schemas for auth, profile, administration, audit, health; RFC 9457 problems; the RBAC matrix |
| Observability | `packages/observability` | config loading with `_FILE` secrets, pino with redaction, OpenTelemetry metrics (Prometheus) and tracing (OTLP when configured), heartbeats, ops endpoint, shared service runner |
| Database | `packages/db` | SQL migrations 0001–0004 on TimescaleDB 2.31 / PostgreSQL 18, the four least-privilege service roles, the audit hash chain, migration CLI |
| api | `apps/api` | NestJS 12: login, MFA (own RFC 6238 implementation, secrets AES-256-GCM encrypted), refresh rotation, lockout, rate limits (Valkey token bucket), RBAC guard, audit, profile, user administration, audit log and chain verification, System Health, probes; `cli` for `create-admin` and `seed-dev` |
| ingestor, analyzer | `apps/ingestor`, `apps/analyzer` | Running skeletons: own database role, heartbeat, readiness, metrics |
| jobs | `apps/jobs` | BullMQ maintenance queue on Valkey: hourly removal of expired refresh-token families |
| Web | `packages/app`, `packages/ui`, `apps/web` | Dark design system; sign-in with MFA and first-sign-in enrolment; Command Center; System Health; Users; Audit log; Profile (password, optional MFA). Initial JavaScript about 167 KB gzipped (budget 300 KB) |
| Desktop | `apps/desktop` | Tauri 2.12: same React app, server chosen on first run, refresh token in the OS keychain, tray, notifications, restricted capabilities and CSP ([README](../../apps/desktop/README.md)) |
| Docker | `infra/docker`, `compose.yaml` | One Dockerfile: server image (442 MB, non-root, digest-pinned base) and Caddy web image (93 MB) with security headers and CSP; secrets generated on first start, never committed |
| CI | `.github/workflows` | `ci.yml` (checks, integration, e2e with Trivy image scans) and `desktop.yml`; every action pinned to a commit SHA |
| Documentation | `docs/adr`, `README.md` | ADRs 001–013; API contracts and data model updated for Phase 1 changes |

## Decisions made during Phase 1

| Decision | Why | Recorded in |
|---|---|---|
| TypeScript 7 for `tsc`, with the TypeScript 6 API installed alongside | TS 7 ships no compiler API and typescript-eslint refuses it; this is Microsoft's documented setup | ADR 013 |
| SWC builds the server code; packages are used from source through the `@cip/source` export condition instead of TypeScript project references | Fast builds independent of TypeScript's emitter, no declaration builds | ADR 013, ADR 001 (amended) |
| Some pins moved back one release (NestJS 12.4.0, jose 6.2.16, Vite 8.3.6, `@vitejs/plugin-react` 6.2.1, typescript-eslint 8.72.1, OpenTelemetry 3.1.0) | pnpm 12 refuses versions published in the last day; keeping that protection on | ADR 013 |
| OpenTelemetry JS 3.x | 3.0 replaced the 2.x tracing SDKs | ADR 013 |
| First-sign-in MFA enrolment (`POST /auth/mfa/enroll`, `enrollmentRequired`) | Admins must have MFA before they get any token | API contracts §2 |
| Audit chain ordered by `chain_seq`, plus an append-only trigger and `app.verify_audit_chain()` | Identity ids can be out of order under concurrency; defence in depth | Data model §3 |
| Local stack uses host ports 15432 and 16379 | Avoids clashing with a PostgreSQL or Redis already on the machine (this one has a Redis on 6379) | README |
| `pnpm verify` instead of `pnpm ci` | pnpm 12 has a built-in `ci` command that would shadow the script | README |

## Carried forward

| Item | Plan |
|---|---|
| Redis ACL users per service (architecture §14) | Phase 13 hardening; the local stack's Valkey has no external port exposure beyond 127.0.0.1 |
| OpenAPI generation from the zod schemas and the breaking-change check (API contracts §1) | Phase 2, with the first market endpoints |
| Socket.IO gateway | Phase 2, with the first channels; System Health polls every 5 s until then |
| QR code for authenticator set-up | Now a grouped setup key and a copyable `otpauth://` link; a QR code can be added in Phase 7 with the other UI work |
| Desktop: tray status from the app, identifier `org.cip.desktop` (placeholder until signing in Phase 13) | See the desktop README |
| Definition of done: changes merged through reviewed pull requests with green CI | Needs the repository (D7) |
| Definition of done: migrations run against a copy of staging data | No staging environment yet (D2); every migration so far runs on an empty database |

## What I need from you

1. **D7: the GitHub owner** (organisation or account) for the repository. With it, the code can be pushed, CI runs for the first time (1.2 and 1.6 in CI), and the desktop workflow builds the Windows and macOS bundles (1.8).
2. **A desktop check on Windows or macOS** (1.3): either install Rust and run `pnpm --filter @cip/desktop dev`, or use the CI bundles once D7 is settled.
3. **Confirm the desktop minimum: macOS 13.3** and WebView engines from Safari 16.4 / Chromium 111, which Tailwind 4 needs (affects NFR-11).
4. **D2: hosting provider and region**, needed before Phase 2's 24-hour staging soak.
5. Your approval of this report. Phase 2 (market data) starts only after it.
