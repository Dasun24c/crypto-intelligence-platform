# ADR 022: Automatic practice trading: a pure decider in the broker, on confirmed setups, journalled with every input

- Status: accepted (Phase 16)
- Date: 2026-11-15
- Context:
  - [REQUIREMENTS §11](../../REQUIREMENTS.md), revision 5, and [proposal 002](../proposals/002-automatic-practice-trading.md) (approved 2026-11-15, A1–A9 as recommended);
  - [ADR 021](021-practice-trading-engine-and-broker.md) (the fill engine and the broker), [architecture §21](../phase-0/03-architecture.md#21-practice-trading-phase-14), [data model §10](../phase-0/05-data-model.md#10-trading-practice-trading-phase-14);
  - implementation plan Phase 16 (criteria 16.1–16.9).

## Context

A user can switch on automatic practice trading for their own practice account (TRD-09). When a bullish setup the analysis detects is confirmed and matches their rules, a practice limit buy is placed at the setup's entry, with a protective stop at the invalidation and a target at target 1, sized by the position-size calculator. The buy is cancelled if the setup expires or is invalidated first. Limits cap open trades, orders per day and the day's loss, and a stop button cancels everything. Every decision is logged, every automatic order is labelled, audited and alerted (TRD-10), and replays give the same decisions and fills (TRD-11). Practice balances only: no exchange, no real money, and the AI never decides an order.

What exists:
- **Setups**: the analyzer appends every setup transition to `an:events` (type `setup`, data a `SetupTransitionMessage`: the setup's summary, with its levels, score, flags and state, and the transition). The Setup Scanner, the API's `setups` channels and the alert service read it.
- **The broker** (ADR 021) reads `practice:commands` and the `md:trades:{id}` streams in one loop ordered by stream id, applies each input to the pure engine, and commits each input's outputs with its journal entry in one fenced transaction. The journal records the pairs' rules and the fees whenever they change.
- **The api** stores orders as `new` (or `refused`) and appends a `place` command; only the api's practice module and the broker may import the order commands (a dependency rule).

## Decision

### Where it runs: inside the broker

The broker reads `an:events` as a third input, in the same ordered loop as the commands and the trades. A setup transition is then ordered against the trades and commands exactly as the broker saw them, and its effects are journalled and committed like any other input.

- No new service, lease or connection. The broker remains the only writer of fills and balances, and becomes the only place that creates orders automatically.
- The setups, alerts, AI and jobs code still cannot create orders (the dependency rule is unchanged).
- Rejected: a separate auto-trader service placing orders through the api. Its decisions would race the broker's view of the market and balances, and replaying them would need a second journal.

### The decider: pure, in `packages/paper-engine`

`decide(input, state) → actions` takes a setup transition and returns, for every user whose automatic trading is on, one of:
- `place`: a limit buy with its stop and target;
- `cancel`: an unfilled automatic buy whose setup ended;
- `skip`, with the reason;
- nothing, for transitions that concern no rule (a setup forming, a bearish setup).

It reads only its arguments: the transition, each strategy (rules, limits, version, pause), the engine's balances, and the automatic trades the broker tracks. It depends only on `contracts` and `domain`.

**A setup qualifies** when all of these hold, checked in this order; the first that fails is the skip reason:

| Check | Skip reason |
|---|---|
| The transition is to `confirmed`, and the setup is bullish | (no decision logged) |
| The strategy is on, and not paused | `paused` (a paused strategy logs; an off one doesn't) |
| The pair is one of the strategy's pairs, on its account's venue | `pair` |
| The pattern is one of the strategy's patterns | `pattern` |
| The setup's mandatory checklist items passed, and its run flags carry neither `warmup` nor `late_detection` | `not_live` |
| Its quality flags don't include `data_gap` | `data_gap` |
| The score is at least the rule's minimum | `score` |
| Entry, invalidation and target 1 are set, invalidation < entry < target 1, and (target 1 − entry) / (entry − invalidation) is at least the rule's minimum reward | `reward` |
| No automatic trade is open on this pair, and fewer than the limit are open in all | `open_limit` |
| Fewer automatic orders than the daily limit were placed since 00:00 UTC | `daily_orders` |
| The calculator's quantity (risk per trade × the free quote balance ÷ (entry − invalidation), rounded down to the quantity step) is above zero and worth at least the pair's minimum | `size` |
| The free quote balance covers the buy with the higher fee | `balance` |

**The order**: a limit buy of that quantity at the entry, rounded down to the price step; a stop at the invalidation, rounded down; a target at target 1, rounded down. The broker then places it through the engine exactly as a manual order: the engine's own checks (the pair's data, the venue's rules, the balance) still apply, and an engine refusal is logged as `refused` with its reason.

**Cancelling**: when the setup is resolved before the buy filled (expired without entry, or invalidated), the buy is cancelled. A partly filled buy keeps its stop and target for what it bought, as for a manual cancel.

**Ids**: an automatic order's id is a name-based UUID of `practice-auto:{strategyId}:{setupId}`, and its stop's and target's of the same with `:stop` and `:target`, so a replay makes the same ids and the same fill ids. The `clientOrderId` is `auto:{setupId}`, so one setup can never make two orders for a user.

### Limits

- **Open trades**: an automatic trade is open from its buy until its buy is finished and its stop and target are finished. One per pair; at most the limit in all.
- **Orders per day**: automatic buys placed since 00:00 UTC, refused ones included.
- **The day's loss**: the result of the automatic trades closed since 00:00 UTC: what their sells brought, less what their buys cost, less all their fees. When it reaches the limit (a share of the account's starting quote balance for the current period), the strategy pauses until the next 00:00 UTC. Open trades are not marked to market: their loss is bounded by their stop, and marking them would make decisions depend on prices outside the journal.
- **Stop**: a command switches the strategy off and cancels every automatic order that is still live.

### Journal and replay

- Two new journal kinds: `setup` (the transition, with the book and the trade position it was decided against, and the strategies' state when it changed since the last entry) and `strategy` (a user's rules switched on, off, changed or stopped, from a command).
- `replayJournal` applies them to a fresh engine and decider. Criterion 16.6 replays recorded sessions, and the live journal, with identical decisions and fills.

### Data

- `trading.strategies`: one row per user (account, switched on, rules and limits as validated JSON, version, `paused_until`, who changed it and when). The api writes the rules and the switch; the broker writes only `paused_until`.
- `trading.auto_decisions`: every logged decision (strategy and version, setup and the analysis ruleset version, `placed`, `skipped`, `refused` or `cancelled`, the reason, the order).
- `trading.orders.source` gains `auto`. Row-level security lets the broker insert only orders with `source = 'auto'`, as submitted (`new`, nothing filled or held), for users who have a strategy, and stops the api inserting them. It does not look at the switch: the broker applies switching on and off in order with its other inputs, and a replay must not depend on when the row changed.

### The api, the channel and alerts

- Routes under `/practice/automatic` (`practice.own`, the caller's own strategy only): read, change the rules (with a version check), switch on and off, stop, and the decision log. Each change is audited and appended to `practice:commands` as a `strategy` command, so the broker applies it in order.
- The `practice` channel gains `practice.automatic` (a decision, a pause, a stop).
- Alerts: two new kinds, `practice_auto_order` (an automatic order placed) and `practice_auto_paused`, through the analyzer's alert service as for the other practice kinds.

### Latency (NFR-17)

From the setup transition's `an:events` entry to the automatic order's `practice:events` entry, both on the Redis clock: p95 ≤ 2 s. The broker records it as `cip_practice_auto_latency_ms`, and `scripts/practice-latency.mjs` measures it.

## Consequences

- **The broker does more**: it reads `an:events`, and evaluates every strategy on each confirmed setup. Confirmed setups are rare (about 50 bullish ones in two weeks across nine pairs), so the load is small.
- **Behaviour depends on the analysis ruleset.** A new ruleset changes which setups confirm. The ruleset version is recorded with every decision, and a replay uses the setups as they were published.
- **Practice results stay practice results**: labelled as simulated, with the number of trades and the period beside every figure, never presented as expected performance.
- **Real money is unaffected**: nothing here can reach an exchange, and `pnpm check:no-trading` is unchanged.

## As built (Phase 16)

Refinements made while building it, within the decision above:

- **The size is capped at the balance.** The calculator's quantity is capped at what the free quote balance buys with the higher fee, rounded down to the quantity step: spot, nothing borrowed. A tight stop no longer means a skip; the risk is then below the rule's, never above. `balance` now means that even the capped order is below the pair's minimum.
- **The checks use the order's prices.** The reward check and the size use the levels rounded down to the price step, so what is checked is what is placed.
- **A setup is decided once.** Each strategy remembers the setups it decided in the last 7 days (part of the journalled state), so a repeated confirmation, such as an outbox re-publish, is not decided again.
- **Live decisions only.** A confirmation the broker reads more than 120 s after the analyzer stored it (the broker catching up after a restart) is skipped as `not_live`.
- **The day's figures are per account.** `trading.auto_days` holds, per account and UTC day, the automatic buys placed and the result of the automatic trades closed; the limits read the account the rules trade. A trade's result counts on the day it closes: what it sold, less that share of its cost and its buy fee, less its sell fees (average cost). What it still holds after a stop is not counted, as open trades are not marked to market. A close that leaves the day at or past the limit pauses the strategy until the next 00:00 UTC.
- **Switching off, and the stop.** Switching off stops new orders; buys already working stay, and are still cancelled when their setup ends. The stop button also cancels every working automatic order, stops and targets included; what was bought stays in the balance.
- **Times in the journal.** The `cancel`, `reset` and `strategy` inputs carry `at`, and trades use their own time, so each close falls on the same day in a replay.
- **The ruleset.** A decision records the setup's analysis `run_id`; the run names the ruleset version.
- **The policies.** The broker's insert policy requires a strategy row, not the switch (above). The api's insert policy now refuses `auto` orders, and the api refuses order keys starting `auto:`.
- **Alerts.** A decision on the `practice` channel carries the buy's size and prices, which the `practice_auto_order` alert reads; a pause carries when it happened.
- **Recovery.** An input whose write fails is applied again after a reload from the stored state, so its decision is made once (an integration test blocks the write, then lets it through).

