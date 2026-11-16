# Phase 9 · AI intelligence: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-16** (you asked to start Phase 10), with criterion 9.1 accepted in part and carried forward: a real Grok call needs your key in `.secrets-jobs/grok-api-key` on the computer that runs the stack. Five of the six criteria are met. Committed on 2026-11-15 at your request, on the branch `phase-9/ai-intelligence`, pushed, and open as pull request #4 into `phase-16/automatic-practice-trading`; its checks pass since `efc3bbb` |
| Date | 2026-11-15 |
| Scope | [Implementation plan, Phase 9](../phase-0/08-implementation-plan.md#phase-9--ai-intelligence), REQUIREMENTS §4 and §10 (AI-01–AI-05, SEC-01, SEC-03, NFR-08), [architecture §8](../phase-0/03-architecture.md#8-ai-pipeline), [ADR 011](../adr/011-ai-grounded-citations.md), [ADR 023](../adr/023-ai-pipeline.md) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, redeployed with Phase 9 at 15:13 UTC on 2026-11-15, without a Grok key |

## Summary

Grok now explains what the platform's own analysis found. **Every answer is checked against the data before it is shown, and every analysis is kept, accepted or not.** AI text is labelled "AI-generated observations from the platform's data. Not financial advice and not a prediction."

- **When it runs** (ADR 023): on significant events, gathered per instrument in 60 s windows (a confirmed setup 100, a market structure shift on a context timeframe 70, a resolved setup 60, a sweep of a previous day or week level 50, a 1h volume anomaly 50; a window of 100 or more makes one call, then a 15 min cooldown); a 4-hourly review per monitored instrument; and on request (analysts and admins: an instrument and a reason from a fixed list, never free text).
- **What Grok sees**: a context the server builds from the database and Redis (the market, the gold market for PAXG, indicators, structure, levels, zones, live setups with their checklists, the last 6 h of events, the next 48 h of economic events, data-quality notes), every item with a short id, about 8,000 tokens at most.
- **What it must answer**: structured output (a JSON Schema from the contract, inside Grok's guaranteed subset) whose every statement cites the context's ids, with the risks, what would invalidate it and the competing scenario.
- **The checks** (ADR 011): the schema; every cited id exists; every number is in the data; no certainty and no instruction to trade; PAXG is never "XAUUSD", and a closed gold market must be mentioned. One repair attempt sends the problems back; an answer that fails again is rejected: kept with what was wrong, never shown as an analysis.
- **The budget**: $5 a day and $100 a month by default (admins change them in `/admin/settings/ai`). Before each call its worst case is reserved, so a cap is never passed; at 80 % only significant events go through; when the next call cannot fit, calls stop, the app says "AI budget reached", and they resume the next UTC day or month. An identical context within 30 minutes reuses the earlier answer at no cost.
- **The key** is a file only the jobs service mounts (`.secrets-jobs/grok-api-key`), read at every call. The api never calls xAI. Without a key nothing is queued and requests are refused, saying why.
- **The AI Intelligence Center** (`/ai`): the budget and Grok's state; the request form; analyses on their way, live; the history, filtered by instrument and outcome; an analysis in full (each statement with the context item it cites, the risks, the invalidation, the competing scenario; for a rejected one, what the checks found; how it was made: trigger, model, prompt version, tokens, cost, time, and the context sent); the daily usage. System Health shows Grok and the budget; a setup's page offers "Ask Grok to review this setup".

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 9.1 | In staging, a real Grok call on real context produces an accepted, stored analysis | **Met in part, accepted by you on 2026-11-16; the real call is carried forward until your key is in place.** Everything up to the call runs on the live stack; the call, the checks and the storage are tested against a fake xAI API | [9.1](#91-a-real-call) |
| 9.2 | 50+ crafted bad responses are all rejected (invented levels, unknown ids, guarantee language, "XAUUSD", a missing gold note while closed); valid responses are accepted | **Met**: 54 crafted answers, each rejected by the rule it breaks; valid ones accepted; a repair and a second rejection end to end in the jobs service | [9.2](#92-the-checks) |
| 9.3 | With a test cap, calls stop exactly at the cap, the UI shows "AI budget reached", and calls resume the next day | **Met**: the jobs service against a fake API, the api, the app, and live on the stack | [9.3](#93-the-budget) |
| 9.4 | A burst of 20 related events produces one call; an identical context within 30 min is served from cache | **Met**: the trigger follower on Valkey, the worker on the database | [9.4](#94-one-call-per-burst-and-the-cache) |
| 9.5 | The Grok key exists only in the jobs service's environment; bundle and image scans find no key | **Met**: the running stack's mounts, both images, the web bundle, a dependency rule | [9.5](#95-the-key-only-in-jobs) |
| 9.6 | Every analysis, accepted or rejected, appears in history with its context, response, validation result, tokens and cost | **Met**: the jobs service, the api, the app, and the page on the stack | [9.6](#96-the-history) |

### 9.1 A real call

The stack runs the whole pipeline without a key: the jobs service's trigger follower took its lease at 15:13 UTC and follows `an:events` for the 9 analysed instruments; it queues nothing while there is no key, and `ai:status` (shown in System Health and on the page) says "no Grok API key is configured". Against a fake xAI API (the jobs service's integration tests), the worker sends the structured-output request (the schema, `strict`, the reasoning effort, the answer's limit, the key as a bearer token) and stores the accepted analysis with exactly the context sent, the answer, the validation result, the tokens, the cost and the time.

**To finish 9.1**: put your xAI key, alone on one line, in `.secrets-jobs/grok-api-key` (no restart needed). Within 30 s System Health shows Grok as up; then, as the development analyst, ask for a market summary of BTC/USDT on the AI Intelligence Center. Its outcome appears on the page within about a minute; I will check the stored analysis (and its real token counts, against the budget's assumptions) when you say it is there. A call costs about $0.01–0.03 at the default prices.

### 9.2 The checks

- **Unit** (`packages/ai/src/validate.test.ts`): **54 crafted bad answers**, each rejected, each by the rule it breaks: 16 against the schema (V1), 8 unknown, miscased or misplaced ids (V2, including "gold" cited on BTC), 12 invented numbers (V3: levels, prices, percentages; tolerances at their edges), 15 certainty or trading-instruction phrases (V4) and 3 "XAUUSD" spellings (V5). A separate test rejects a PAXG answer that does not mention the closed gold market (V5), and accepts it once it cites `gold`. A valid answer is accepted, numbers as the context gives them are accepted within the tolerances, and dates, times, timeframes and small counts are not taken for numbers. V6 (a stance against every confirmed setup) only warns.
- **Integration** (the jobs service, a fake xAI API): an answer with an invented price is repaired (the second call carries the first answer and the problems found) and accepted, keeping the first answer's errors; an answer that fails again (an unknown id and "guaranteed") is rejected and stored with its errors, both calls' tokens and cost.
- **The api and the app**: a rejected analysis has no headline, stance or confidence in the history; its page shows "Rejected by the checks", what the checks found (and in the first answer), and the answer as received only inside a disclosure, as plain text.

### 9.3 The budget

- **Integration** (the jobs service, a fake xAI API, a $0.03 daily cap): two calls of $0.0095 each fit (each first reserving its worst case, about $0.016); the third could have passed the cap, so it was not made: stored as "not called (budget)", `daily_cap`, at no cost, with `ai.budget` (`exhausted`) on the channel. The day's spend stayed at $0.019. The next UTC day the same request was made. A monthly cap stops calls the same way, and so does switching analyses off. A timed-out call, whose usage nobody reports, is counted at its worst case, so the caps hold then too.
- **The api**: with today's spend leaving no room, a request answers `409 BUDGET_EXHAUSTED` ("AI budget reached: no analyses until the cap resets.") and the usage reports `exhausted`.
- **The app** (unit): "AI budget reached" on the budget card, and the request form holds requests with the same words.
- **Live** (the stack, end to end): an admin set the daily cap to $0 in the AI settings; the page said "AI budget reached" (badge and alert, axe clean) and an analyst's form held the request; the settings were then restored.

### 9.4 One call per burst, and the cache

- **The follower** (integration, on Valkey): 20 sweep events for ETH/USDT in a burst made **one** queued analysis, scoring 1,000 with the 20 events as its references, after its 60 s window; ETH then cooled down for 15 minutes, during which another sweep opened nothing but a confirmed setup still did. Events from before the follower started are history, not news. Only one instance follows (the lease). Digests: one per monitored instrument on its primary venue when a 4-hour slot begins, none at start-up.
- **The cache** (integration, on the database): the same context 10 minutes later was served from the cache (`cache_hit`, pointing at the original, at no cost, with no call); 31 minutes later a new call was made. The hash leaves out times and rounds the market's figures, so a market that barely moved still matches.
- **Unit**: the aggregation (windows, the threshold, the cooldown, a repeated event counted once) and the scores.

### 9.5 The key only in jobs

- **The running stack**: `node scripts/scan-images.mjs --containers` found that only the jobs container (and the one-off `secrets` service, which creates the empty file) mounts `.secrets-jobs`, read-only, and no other container has a variable naming a key.
- **The images**: `node scripts/scan-images.mjs cip-server:dev cip-web:dev` read every file of every layer (server: 26 layers, 16,369 files, 294 MiB; web: 6 layers, 279 files, 64 MiB) and found no xAI key. When the key file exists, the scan also looks for the key itself, never printing it. To prove the scan works, a throwaway image with a planted fake key was scanned: it failed, naming the file.
- **The web bundle**: `pnpm verify`'s artefact scan (xAI key pattern, every server setting name, `GROK_API_KEY` and `AI_BASE_URL` added) passed.
- **The code**: a dependency rule lets only the jobs service import the Grok provider; the api imports the pure part of `@cip/ai` (budget arithmetic, scoring). `.secrets-jobs` is excluded from git and from the Docker build context.

### 9.6 The history

- **Integration** (the jobs service): every outcome is stored: accepted, rejected (with both answers' errors), failed (no key, timeout, an answer without content, a context that could not be built), not called (each cap, switched off), and from cache, each with its trigger and references, the context sent (byte for byte what the request carried), the prompt version, the models requested and reported, the response, the validation result, the tokens and the cost.
- **The api** (integration): `GET /ai/analyses` lists them newest first, filtered by instrument, outcome and time, paged; `GET /ai/analyses/{id}` answers the context, the response, the validation and the usage; `GET /ai/usage` sums them per UTC day.
- **The app** (unit) and **the stack** (end to end): the history and an analysis in full, as above; a viewer reads it, axe finds no serious violations.

## Decisions made while building it

Recorded in [ADR 023, "As built"](../adr/023-ai-pipeline.md#as-built-phase-9). The ones you may want to know about:

1. **No key, no work.** Without a key nothing is queued and requests are refused with the reason, instead of filling the history with failures.
2. **A timed-out call counts at its worst case**, and is not retried: it may have been answered and billed. The cost shown for it is an upper bound.
3. **The reserve includes reasoning tokens** (4,000 by default, as an allowance), since xAI bills them as output and the answer's limit does not cap them. The first real calls will show whether that is too much or too little; it is a setting.
4. **Requests are refused while analyses are switched off** (`409`), and a rejected answer's stance is never stored in its column or shown.

## Live

On the local stack (2026-11-15, UTC):

- **15:13**: redeployed with Phase 9 (a first attempt failed: the server image did not yet build the new `@cip/ai` package; fixed in the Dockerfile). Migration 0014 was applied; the jobs service took `lease:ai-triggers` and follows `an:events` from its end, watching the 9 analysed instruments; `.secrets-jobs/grok-api-key` was created empty; `ai:status` reports Grok down, "no Grok API key is configured", the budget $0 of $5.
- **Then**: the Phase 9 end-to-end spec and the smoke spec: 6 passed, 1 failed: the live-channel test appended its message before the page had subscribed (a race in the test); it now appends until the page shows it, and the Phase 9 spec passed 4 of 4. The image and container scans passed, and the planted-key check failed as it should.
- **16:02–16:05**: `pnpm verify` passed (above). **16:13–16:31**: the integration suites (above).
- **16:35**: redeployed on the final code (the follower's read loop fixed, finding 9).
- **16:36–16:46**: every end-to-end spec, all phases: **26 of 26** passed.
- **16:46–16:47**: the image and container scans on the final images: passed (the same 26 and 6 layers).
- **17:25–17:29**: pull request #4's first CI run failed on two jobs (findings 10 and 11, below); the Desktop build passed. Both are fixed: the jobs integration suite passed 69 of 69 in CI's file order, and the end-to-end suite as CI's replay stack sees it passed 9 and skipped 17.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | Short context ids took the first 8 hex digits of a UUID; the platform's ids are time-ordered (v7), so entities made in the same minute shared them (the context builder's integration test) | Long, unreadable ids in the context, and harder citations for the model | The end of the UUID, which is random |
| 2 | A rejected answer's stance and confidence were stored and listed (the worker's integration test) | A rejected answer's stance could appear in the history as if it were the platform's view | Stored for accepted answers only |
| 3 | The cache and the spend had no upper time bound (the provider-status test met a later row) | Harmless live, but a row stamped later could be counted or reused | Bounded to the period, and to `now` |
| 4 | A timed-out call was retried, and a failed call's possible cost was not counted | A timeout could be billed twice and not counted, letting the spend pass a cap | No retry on a timeout; its worst case counted; an empty answer's reported usage counted |
| 5 | The jobs service's role could not read `app.settings` | The admins' AI settings would have been ignored in the stack | Granted in migration 0014 |
| 6 | The trigger follower's job ids used colons, which BullMQ allows only in three-part ids, for now | A future BullMQ would refuse every event and digest job | Dots instead |
| 7 | The server image did not build `@cip/ai` (the first redeploy) | The api and the jobs service did not start | Added to the Dockerfile's build and copy steps |
| 8 | The image scan's helper was used before it was defined | The scan crashed instead of scanning | Fixed, and proved with a planted key |
| 9 | The trigger follower's read loop guarded only the read itself: an error while saving its cursor would have rejected the loop's promise unhandled (found re-reading the code) | Node stops a process on an unhandled rejection: a Redis hiccup could have restarted the jobs service | Every pass of the loop is guarded; a failed pass waits a second and reads again |
| 10 | The jobs service's AI test seeded two economic events inside the calendar test's window (the test files share one database, and economic events cannot be removed), and expected exact data-quality lists; CI ran the files in another order (pull request #4) | The calendar sync test failed in CI | The AI test's dates moved outside that window, and it checks only its own entries; run in CI's order here (no timing cache): 69 of 69 |
| 11 | The end-to-end specs from Phase 7 on need the live venues' pairs, books and trades; CI runs them on the replay stack (criterion 2.11), where they fail at their first step. Their retries' sign-ins then used up the login limit, failing the smoke test too (pull request #4) | Every pull request from Phase 7 on would fail CI | On the replay stack the Phase 7, 8, 14 and 16 specs are skipped, saying why (`e2e/support/stack.ts`); they still run against the live stack. Phase 9's spec runs on either stack (any enabled BTC/USDT pair) and signs its analyst in once |

The tests needed these corrections; none is a product defect:

- The jobs service's seed gave two setups the same pattern, timeframes and start, which the setups' unique key refuses; the fake xAI server's stop waited forever when it had not started.
- The api's rate-limit test moved the clock an hour, past the access tokens' life; it signs in again afterwards. One api test needed a type fix to pass the type check.
- The live-channel end-to-end test appended its message before the page had subscribed; it now appends until the page shows it.
- A regular expression lost its backslash while being edited in.
- The database suite's schema check (the tables against their types) did not list the new `ai` schema; it does now, so the two new tables' columns are checked too.
- The contracts package had no tests of its own for `ai.ts` (its 90 % branch gate failed); they cover the request's setup rule, the settings' price rules, the list filters and the schemas.

## Tests and coverage

2,221 automated tests, all passing: 1,592 unit, 603 integration and 26 end to end (Phase 16: 2,107).

- `pnpm verify` passes on the final code (2026-11-15, 16:02–16:05 UTC; Turbo reused the results of the earlier runs where nothing had changed): formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan. Three earlier runs stopped on findings fixed above (an api test's type, the contracts' branch gate) and, twice, on app test files whose workers did not start within vitest's 60 s while every package's suite ran at once on this machine (all the app's tests that ran passed, as in Phases 14 and 16).
- The integration suites of all seven packages that have them pass with coverage: six in the full run (16:13–16:29 UTC), the database's alone at 16:31 after its new test (above).
- Every end-to-end spec passed on the final build (below). In CI, on the replay stack, the Phase 7, 8, 14 and 16 specs are skipped (finding 11): there, 9 pass and 17 are skipped.

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration) | What is new in Phase 9 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| ai (new) | 36 | The validator (54 crafted bad answers, the tolerances, the gold rules), the scores and the aggregation, the budget and its periods, the cost and the worst case, the context's trimming, hash and short ids, the prompt, the schema inside Grok's subset, the provider (structured output, retries, no retry on a timeout, the reasoning fallback, the usage) | 90% | 98.6% / 92.4% |
| jobs | 19 + 50 (19 + 31) | The context from a live run; the worker against a fake xAI API (accepted, repaired, rejected, no key, timeout, an empty answer, no context, the cache, the daily and monthly caps and the next day, switched off); the follower on Valkey (a 20-event burst, the cooldown, a confirmed setup through it, digests, the lease, no key); the provider status and the fallback model | 70% | 94.8% / 82.9% |
| api | 19 + 449 (19 + 415) | The `/ai/...` routes (the history's filters and pages, the detail, a request queued, announced and audited, its checks and refusals, 10 an hour, the usage), the admin settings, the `ai` channel live, replayed and as a snapshot, the system health's `ai`; six routes in the RBAC matrix | 70% | 90.5% / 75.4% |
| db | 2 + 44 (2 + 39) | Migration 0014: only the jobs service writes analyses, the api reads them, the other services cannot; the checks; the settings, the spend per UTC day and month, the summaries and details | 70% | 99.2% / 85.4% |
| contracts | 81 (75) | The AI schemas: the request's setup rule, the settings' prices, the list filters, the strict answer, the status report and the snapshot | 90% | 100% / 100% |
| app | 174 (164) | The AI Intelligence Center (the history, an analysis in full with its references, a rejected one, "AI budget reached", a setup review followed live, refusals, no key, switched off); the helpers | none yet | 79.9% / 69.0% |
| analyzer | 5 + 25 (5 + 25) | None | 70% | 90.7% / 76.0% |
| broker | 3 + 17 (3 + 17) | None | 70% | 96.2% / 78.4% |
| ingestor | 6 + 14 (6 + 14) | None | 70% | 92.3% / 80.2% |
| observability | 11 + 4 (11 + 4) | None | 70% | 85.5% / 72.1% |
| End to end | 26 (22) | `phase9.spec.ts`: 9.3, 9.5 and 9.6 on the live stack, and the `ai` channel | | |

The other packages (alerts, domain, exchange-adapters, indicators, market-data, paper-engine, smc-engine, ui) are unchanged, with the same tests as in Phase 16.

## Not covered, and limits

- **9.1 needs your key** (above; carried forward at the acceptance on 2026-11-16). The key file is still empty on this computer: save the key, alone on one line, in `.secrets-jobs/grok-api-key` (never in the chat); the jobs service reads it at every call, and I then make the first real call and re-check 9.1. Until the first real calls, the prompt and the checks are tuned on crafted answers: real answers may be rejected more often at first. Every rejection is kept with its reasons, so they can be read and the thresholds tuned.
- **The default models and prices** (`grok-4.3`, the fallback `grok-4.20-0309-non-reasoning`, and their prices) come from the feasibility study; check them against your xAI console. The startup check falls back automatically if the account does not offer the model, and System Health says so.
- **Stored analyses on the stack**: without a key, the stack's history is empty; the history and the analysis pages are tested with stored analyses in the app's unit tests and the api's integration tests.
- **End to end in CI**: the replay stack has no live venues, so CI skips the Phase 7, 8, 14 and 16 specs; they run against the live stack, as each phase's report describes. Making them work on recorded data is work for later (Phase 13's hardening, for example).
- **The desktop app** was not rebuilt for this phase; the page is in `packages/app`, so the desktop build gets it with the next build.
- **Committed** at your request on `phase-9/ai-intelligence`, on top of Phase 16's `c318ed5`.
