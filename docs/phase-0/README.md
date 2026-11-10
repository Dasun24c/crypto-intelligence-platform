# Phase 0 · Analysis and design

| | |
|---|---|
| Status | Approved 2026-11-10 with the recommended defaults. D2 and D7 are still open. |
| Date | 2026-11-09 (approved 2026-11-10) |
| Input | [REQUIREMENTS.md](../../REQUIREMENTS.md), revision 3 |

No application code was written in this phase, as the requirements ask.

## Documents

| # | Document | Answers |
|---|---|---|
| 01 | [Requirements analysis](01-requirements-analysis.md) | What exactly are we building? Requirement IDs, assumptions, measurable quality targets, out of scope, conflicts found and resolved |
| 02 | [Feasibility assessment](02-feasibility.md) | Can it be built? Facts verified on 2026-11-09, live exchange measurements, AI and data-source costs, pinned versions |
| 03 | [Architecture](03-architecture.md) | How it fits together: services, data flow, AI pipeline, 3D view, desktop, security, deployment, CI/CD, testing |
| 04 | [Risks and dependencies](04-risks-and-dependencies.md) | 30 risks with mitigations; every third-party dependency with cost, licence, limits and fallback |
| 05 | [Data model](05-data-model.md) | The PostgreSQL/TimescaleDB schema, retention and database roles |
| 06 | [API contracts](06-api-contracts.md) | REST endpoints, WebSocket protocol, AI context and response schemas, error codes |
| 07 | [SMC rulebook](07-smc-rulebook.md) | Exact, testable rules for structure, liquidity, POIs, the four patterns and the checklist |
| 08 | [Implementation plan](08-implementation-plan.md) | 13 phases, each with acceptance criteria traced to requirement IDs |

## Key findings

1. **Feasible with the specified stack.** Both exchanges' public data works without any API keys, so the initial release holds no exchange secrets at all.
2. **Coinbase moved its full order-book channel behind authentication.** The design uses the unauthenticated batched channel instead.
3. **Binance is clearly the right primary venue for PAXG.** Measured today: 8× Coinbase's volume and about 4× its depth near the price. Coinbase PAXG had no trades in 37% of minutes.
4. **PAXG behaves differently while the gold market is closed**: about 35% of normal volume and 21% of normal price range. That supports blocking setup confirmations during closures.
5. **AI costs are small**: about $19–86 a month with grok-4.3 at the expected volume. Grok guarantees schema-valid structured output, which the grounding validation builds on.
6. **The economic calendar can be free** (FRED, BEA, and FOMC dates entered by an admin). BLS blocks automated downloads, and that block won't be bypassed.
7. **Node.js 26.13.0** (Active LTS, supported to April 2029) is the recommended pin, with 24.22.2 as the fallback.
8. **The biggest risk is not technical.** It's agreeing exact SMC definitions with the people who'll use them. The rulebook and its judgement calls (J1–J10) exist to settle that before code is written.

## Decisions needed

**Outcome (2026-11-10):** every recommendation below was approved as written. **D2 and D7 are still open** because they need information only you have. Phase 1 proceeds locally without them: the repository is initialised locally, and the GitHub remote, the first CI run and the staging region wait for your answers.

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Deployment model | Self-hosted by one organisation, up to about 50 named users, roles admin / analyst / viewer | Phase 1 |
| D2 | **Hosting provider and region** | A VM (4 vCPU, 16 GB RAM, 200 GB SSD) in a region where Binance's public API is reachable. **Which provider do you use or prefer?** | Before Phase 2 (staging soak) |
| D3 | Node.js version | Pin 26.13.0; fall back to 24.22.2 if a native module fails | Phase 1 |
| D4 | Redis-compatible store | Valkey 9.1.3 (BSD), if BullMQ's integration tests pass on it in Phase 1; otherwise Redis 8 | Phase 1 |
| D5 | AI model and budget | grok-4.3 at low reasoning effort; caps of $5/day and $100/month | Phase 9 |
| D6 | Economic calendar | Free official sources; no forecast/actual values at first | Phase 7 |
| D7 | **Code hosting and CI/CD** | GitHub, with Actions and Container Registry. This folder isn't a git repository yet. **Which GitHub organisation or account should own the repository?** | Phase 1 |
| D8 | Spot-gold (XAUUSD) feed | Stay deferred | — |
| D9 | On-chain providers | Decide in Phase 11; start with the low-cost option and a curated list of exchange addresses | Phase 11 |
| D10 | SMC judgement calls J1–J10 ([rulebook §11](07-smc-rulebook.md#11-judgement-calls-for-approval)) | Accept the proposed defaults; refine with labelled data in Phases 4–6 | Phase 4 |
| D11 | Quality targets NFR-01 to NFR-15 ([requirements §4](01-requirements-analysis.md#4-non-functional-requirements-proposed-targets)) | Accept | Phase 1 |
| D12 | Code-signing purchases | Apple Developer Program ($99/year) and a Windows signing option, bought before Phase 13 | Phase 13 |

## Next step

**Update 2026-11-10:** Phase 1 is built; see the [Phase 1 acceptance report](../phase-1/acceptance-report.md).

After approval, **Phase 1 — Foundations** starts:

- Create the repository (D7).
- Scaffold the monorepo, CI pipeline and Docker stack.
- Build authentication, RBAC and the audit log.
- Build the web and desktop shells.
- Run the toolchain checks (Node 26, TypeScript 7 with NestJS, Valkey with BullMQ, chart primitives).

Phase 1 ends with an acceptance report against criteria 1.1–1.8 in the [implementation plan](08-implementation-plan.md#phase-1--foundations).
