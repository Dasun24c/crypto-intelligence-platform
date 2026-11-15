# ADR 023: The AI pipeline runs in the jobs service: event triggers, a server-built context, Grok over HTTPS with structured outputs, grounding validation, a reserved budget, and every analysis stored

- Status: accepted (Phase 9)
- Date: 2026-11-15
- Context:
  - [REQUIREMENTS §4](../../REQUIREMENTS.md) and §10 (AI-01–AI-05, SEC-01, SEC-03, NFR-08, GLD-05);
  - [architecture §8](../phase-0/03-architecture.md#8-ai-pipeline), [ADR 011](011-ai-grounded-citations.md) (ids, grounding rules V1–V6, one repair attempt), [data model §6](../phase-0/05-data-model.md#6-ai-analyses), [API contracts §6](../phase-0/06-api-contracts.md#6-ai-contract) and the `/ai/...` routes, [feasibility §5](../phase-0/02-feasibility.md#5-ai-grok);
  - risks R12 (AI output taken as advice), R14 (invented levels), R15 (spending), R16 (model retirement), R17 (provider data handling);
  - implementation plan Phase 9 (criteria 9.1–9.6).

## Context

Phase 0 settled the shape of the AI pipeline: the jobs service alone holds the Grok key; the model sees only a context the server builds, in which every item has an id; its structured response must cite those ids; the server validates grounding (V1–V6), allows one repair attempt, and stores every analysis, accepted or rejected; event-driven triggers, aggregation, a cache and daily and monthly spending caps control cost. No free text reaches the model: on-demand requests choose an instrument and a reason from a fixed list.

This ADR settles what Phase 0 left open: where triggers are scored, how work reaches the worker, the provider client, how the caps are kept exactly, the cache key, the settings, and how the key reaches only the jobs service.

## Decision

### Where it runs

Everything that touches the model runs in the **jobs service**: scoring the triggers, building the context, calling Grok, validating, storing, and announcing the outcome.

- **The api** queues on-demand requests (`ai` BullMQ queue), serves analyses, usage and the settings, and relays the `ai` channel from the `ai:events` stream. It never calls xAI and never sees the key.
- **The analyzer is unchanged.** The jobs service reads `an:events`, which already carries every live detection, setup transition and closed indicator point (warm-up events are never published).

### The key

- The key is a file in **`.secrets-jobs/grok-api-key`**, a folder mounted only into the jobs container (`GROK_API_KEY_FILE`). The other server containers mount `.secrets/`, which does not contain it.
- The jobs service reads the file at every call, so a key added later needs no restart. Without a key, AI calls fail as `failed` (`no_key`), and the system health shows Grok as down ("no key").
- `.secrets-jobs` is excluded from git and from the Docker build context. The web bundle's artefact scan already looks for xAI keys; a new image scan (`scripts/scan-images.mjs`) looks inside the server and web images for the key pattern and, when the file exists, for its value (criterion 9.5).

### Triggers

One **trigger follower** in the jobs service, behind a fenced lease (`lease:ai-triggers`), reads `an:events` from a cursor it keeps in Redis (from the stream's end the first time). It scores events per instrument:

| Event | Score |
|---|---|
| A setup reaches `confirmed` | 100 |
| A market structure shift (`mss`) on one of the instrument's context timeframes (its profile's timeframe pairs) | 70 |
| A setup is resolved | 60 |
| A sweep of a previous day or week level (`pdh`, `pdl`, `pwh`, `pwl`) | 50 |
| A closed 1h candle with a volume z-score of 3 or more, either way | 50 |

- The first scored event for an instrument opens a **60 s window**. When it closes, a window scoring 100 or more makes **one `event` analysis**, with the window's events as `trigger_refs`.
- After a call, the instrument has a **15 min cooldown**, kept in Redis so that it survives a takeover. During it, events open no window, except a setup confirmation.
- A **digest** analysis (score 30) runs every 4 h (00:00, 04:00 … 20:00 UTC) for each enabled monitored instrument.
- Jobs get deterministic ids (`event.{instrumentId}.{windowStart}`, `digest.{instrumentId}.{slot}`; dots, since BullMQ refuses colons in custom ids), so a follower that takes over and reads an event again cannot queue a call twice.

### The worker

One `ai` job runs at a time across all jobs instances (BullMQ global concurrency 1), so the budget check cannot race itself. For each job:

1. Read the settings (`app.settings` key `ai`, else the defaults below).
2. **Build the context** from the database and Redis, and its hash.
3. **Budget** (below): if the call does not fit, store a `skipped_budget` analysis.
4. **Cache**: an `accepted` analysis for the same instrument with the same hash in the last 30 min is reused: a `cache_hit` analysis that points to it, with no call.
5. **Call Grok**, then **validate** (V1–V6). If V1–V5 fail, one repair call that sends the validator's errors back; then validate again.
6. **Store** the analysis: `accepted`, `rejected` (with the validation result) or `failed` (no usable answer: timeout, HTTP errors after retries, no key).
7. **Announce** it on `ai:events`: `ai.completed`, `ai.rejected`, `ai.failed` or `ai.budget`. `ai.queued` is announced when a job is queued, and `ai.started` when the worker takes it.

### The context

The contract's `AiContext` (version 1, API contracts §6.1), built from the database and Redis:

- the instrument; the market (last price, 24 h change and volume from the ticker, the spread from the book);
- for PAXG, the gold market (open or closed, the next change, the Binance–Coinbase spread);
- the latest indicators per timeframe; the structure per timeframe with its last event;
- active liquidity levels, active zones, live setups with their checklists;
- the last 6 h of detections and setup transitions, the next 48 h of economic events;
- data-quality notes (open gaps, feeds not connected).

Every item has a short, stable id (`ind:1h:rsi`, `str:4h`, `lvl:3f2a9c1e`, `gold`), and prices are the database's decimal strings. The context is capped at about 8,000 tokens (characters ÷ 4): the lowest-priority items go first (the oldest events, then the farthest levels and zones, then the lower-impact calendar entries).

The **hash** is SHA-256 of the canonical context (keys sorted) without `asOf` and without times, so an unchanged market gives an unchanged hash.

### The provider

- `LlmProvider` is the interface; `GrokProvider` calls xAI's OpenAI-compatible Chat Completions API with plain `fetch` (no SDK dependency).
- It sends `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`, `max_completion_tokens`, and the reasoning effort when one is configured.
- 30 s timeout; up to 3 retries with exponential backoff on 429, 5xx and network errors, honouring `Retry-After`.
- It reads the usage (input, cached input, output and reasoning tokens) and the model the API reports.
- **Startup check**: it lists the models (`GET /v1/models`). If the configured model is missing, it uses the configured fallback and the health shows Grok as degraded.
- The **JSON Schema** comes from the zod contract (`z.toJSONSchema`); a test keeps it inside Grok's guaranteed subset: no `not` or `if/then/else`, strings at most 2,048 characters, arrays at most 256 items, at most 64 properties per object.

### Validation

ADR 011's rules, in order:

- **V1**: the schema.
- **V2**: every cited id exists in the context.
- **V3**: numbers in the text are grounded. A percentage must be within 0.1 points of a percentage in the context. Any other number with 3 or more significant digits must be within 0.05 % of a number in the context. Counts of 10 or less, timeframes (`15m`, `4h`) and dates and times are not numbers here.
- **V4**: policy lint. No guarantee or certainty language ("guaranteed", "will definitely", "risk-free", "can't lose", …) and no instructions to trade ("buy now", "you should sell", "enter long", …).
- **V5**: gold rules. Never "XAUUSD" or "XAU/USD"; when the gold market is closed, an observation or a risk cites `gold`.
- **V6**: a warning only: the stance contradicts every confirmed setup's direction.

The prompt states the same rules. It is versioned (`prompt_version`), and the analysis stores it.

### The budget (NFR-08, criterion 9.3)

- The caps are **$5 a day and $100 a month** by default (decision D5), in UTC days and months. The spend is the sum of `cost_usd` over the period's analyses.
- **Reserved, so a cap is never passed**: before a call, its worst case is reserved: the context's estimated input tokens at the input price, plus `max_completion_tokens` at the output price. A call is made only if the spend plus that worst case stays within both caps. A repair call is checked again the same way.
- **At 80 % of a cap**, only triggers scoring 100 or more go through: event windows and on-demand requests (counted as 100); digests wait.
- **When the next call does not fit**, it stops: a `skipped_budget` analysis, `ai.budget` on the channel, "AI budget reached" in the app, and `409 BUDGET_EXHAUSTED` for on-demand requests. Calls resume when the day (or month) turns.
- **The cost** is computed from the usage and the settings' prices per model. Cached input is billed at its rate; reasoning tokens are billed as output.

### Settings

`app.settings` key **`ai`**, set by admins at `GET` and `PUT /admin/settings/ai` (`settings.manage`, audited):

- `enabled`;
- `model` and `fallbackModel` (defaults `grok-4.3` and `grok-4.20-0309-non-reasoning`), and `reasoningEffort` (`low`);
- `maxCompletionTokens` (2,000);
- `dailyCapUsd` and `monthlyCapUsd`;
- the prices per model, per 1M tokens: input, cached input and output; the defaults are feasibility §5.2's.

### Storage

**Migration 0014**, `ai.analyses` as in data model §6:

- the trigger and its references, who asked and why;
- the context and its hash, the prompt version, the models requested and reported;
- the status, and for a cache hit, its source;
- the stance and confidence, the response, the validation result and whether a repair was tried;
- the tokens, the cost and the latency.

A view, `ai.daily_usage`, sums calls by status, tokens and cost per UTC day. `svc_jobs` inserts and reads; `svc_api` reads; the other services have no access.

### The api, the channel, the app

- **Routes** as API contracts §2:
  - `GET /ai/analyses` and `GET /ai/analyses/{id}` (`dashboards.view`);
  - `POST /ai/analyses` (`ai.request`): an instrument and a reason (`market_summary`, `setup_review` with a setup, `refresh`), 10 per hour per user, `409 BUDGET_EXHAUSTED` when the budget is spent, audited as `ai.requested`; it answers `202 { analysisId }`;
  - `GET /ai/usage`: the daily usage and the budget's state.
- **The `ai` channel** is durable and the same for every role with `dashboards.view`.
- **The AI Intelligence Center** (`/ai`):
  - the analyses, newest first;
  - an analysis in full: every reference resolved to the context item it cites, all AI text rendered as plain text, the validation result ("analysis unavailable" when rejected or failed), and the model, tokens, cost and time;
  - the request form for analysts and admins;
  - the usage and the budget, with "AI budget reached" when spent.
- **Labels**: every AI text carries the label "AI-generated observations from the platform's data. Not financial advice and not a prediction."

## Consequences

- **The jobs service gains a lease and a stream follower**, as the analyzer and the broker have. A takeover reads an open window's events again and never queues a call twice (as built, below).
- **A strict validator rejects some answers**, at the cost of the repair call; rejected analyses stay in the history, so the failure rate can be measured and the thresholds tuned (ADR 011).
- **The budget is conservative**: reserving the worst case can stop calls a little before the cap is reached in money.
- **A real Grok call needs the owner's key** in `.secrets-jobs/grok-api-key` (criterion 9.1). Without it, everything else works and is tested against a fake xAI server; nothing is queued and requests are refused (as built, below).

## As built (Phase 9)

Refinements made while building it, within the decision above:

- **No key, no work.** Without a key the trigger follower queues nothing, the jobs service reports `keyConfigured: false` in `ai:status`, and the api refuses on-demand requests with `503` ("No Grok API key is configured."), so the history does not fill with failures. A job that still meets no key (one removed after it was queued) is stored as `failed` (`no_key`). Requests are also refused with `409 CONFLICT` while analyses are switched off.
- **Timeouts.** The timeout is 60 s, since reasoning takes time. A timeout is not retried: the request may have been answered, and billed, after all. Retries stay for 429, 5xx and connection errors.
- **A failed call may still cost.** An answer that came back without content keeps the usage the API reported; a timed-out call, whose usage nobody reported, is counted at its reserved worst case. Both go into `cost_usd`, so the caps hold even then.
- **The worst case includes reasoning.** Reasoning tokens are billed as output and are not limited by `max_completion_tokens`, so the reserve is the input at the input price plus `maxCompletionTokens + reasoningAllowanceTokens` (default 4,000) at the output price.
- **The repair call** must fit the caps like any call, but is not held back by the 80 % throttle: the analysis was already admitted.
- **The hash ignores noise.** Besides leaving out times, the canonical context rounds the market's figures (the last price, the 24 h change and volume, the spread), so a market that barely moved gives the same hash and the cache is useful live.
- **Periods are bounded.** The spend counts the UTC day and month `now` falls in, `[start, end)`; the cache looks back 30 minutes from `now` and no further forward.
- **Short ids come from the end of a UUID.** A time-ordered UUID (v7) starts with its time, so entities made in the same minute shared their first digits; the last eight hex digits are random. A transition's id is its setup's (`evt:5e6f7a8b:123`).
- **A window is never lost to a takeover.** The follower's saved cursor stays just before the first event of any window still open, so a new holder reads that window again. Windows open at the event's stream time, so the window it rebuilds has the same start, hence the same job id; the analysis id is a name-based UUID of the job id, so even a job BullMQ no longer remembers is stored once.
- **Digests** go to enabled monitored instruments on their primary venue (one per asset). The first comes at the slot after the follower first starts: starting up is not a reason to spend.
- **The stance belongs to accepted analyses only.** A rejected answer is stored whole for review, but its stance and confidence are not stored in their columns, nor shown, nor listed.
- **The model check** runs every 15 minutes (a minute after a failure, and at once when a key appears). `ai:status` lives 120 s, so a stopped jobs service shows as no report.
- **Grants.** Migration 0014 also lets `svc_jobs` read `app.settings` (the AI settings). The `secrets` start-up service creates `.secrets-jobs/grok-api-key` empty, as it does for the FRED key; only the jobs service mounts the folder, read-only (`scripts/scan-images.mjs --containers` checks the running stack).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| Score triggers in the analyzer and send them to jobs | The analyzer would gain AI concerns; `an:events` already carries everything the scores need |
| The `openai` npm SDK pointed at xAI | A large dependency for one endpoint; plain `fetch` gives the same calls, retries and timeouts under our control |
| Check the cap after each call | A call that starts just under the cap could pass it; reserving the worst case keeps it exact |
| The key in `.secrets/` with the other secrets | Every server container mounts `.secrets/`; the key must reach only the jobs service (criterion 9.5) |
