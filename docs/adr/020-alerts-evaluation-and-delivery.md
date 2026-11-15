# ADR 020: Alerts: evaluation, de-duplication and delivery

- Status: accepted (Phase 8)
- Date: 2026-11-12
- Context: [requirements §8](../../REQUIREMENTS.md), [architecture §9](../phase-0/03-architecture.md#9-alerts-and-notifications), [data model §7](../phase-0/05-data-model.md#7-alerts-and-ops), [API contracts](../phase-0/06-api-contracts.md) (alert endpoints, `AlertCondition`, the `alerts` channel), implementation plan Phase 8 (criteria 8.1–8.6)

## Context

Users define personal alert rules of twelve condition kinds over very different sources:

- tickers (price);
- the analyzer's own output (indicator points, SMC detections, setup transitions);
- the ingestor's `md:events` (gaps, feed status including halts and delistings, large trades, walls);
- the PAXG cross-venue spread;
- the economic calendar;
- the gold-market closure calendar.

Alerts must be de-duplicated, rate-limited, respect quiet hours, carry a "late" label when they come from catch-up processing, and reach the in-app inbox, open web tabs and the desktop app. A dry run must list what a rule would have fired over the last 24 hours.

## Decision

### One evaluator, shared by live alerts and the dry run

`packages/alerts` is a pure package (contracts and domain only):

- the analyzer turns every source into one normalised `AlertSource`;
- `AlertEvaluator` decides which rules match it, with each match's de-duplication key, cooldown subject, title, body and `late` flag;
- `decide()` applies the rule's cooldown and the memory of occurrences already fired.

The API's dry run (`POST /alerts/rules/{id}/test`) builds the same sources from stored history and runs the same two functions with an in-memory cooldown measured in source time. A live rule and its dry run therefore agree, except where the stored history is coarser than the live source (prices: 1m candle closes instead of the 1 Hz ticker; the result says so).

### Where rules are evaluated (the analyzer)

As the architecture planned, in the analyzer. Each instance keeps a cache of the enabled rules, re-read when their fingerprint changes (checked every 5 s).

- **Per instrument, by the instance holding the instrument's lease**:
  - indicator points, SMC detections and setup transitions, right after the actor has stored and published them (warm-up and replay output is never published, so it never alerts);
  - prices, from the `ticker:{id}` key once a second.
- **Everything else, by the one instance holding `lease:analyzer:alerts`**:
  - `md:events` (feed health, gaps, large trades, walls), read from a cursor kept in Redis, so events missed during a restart are caught up and labelled late;
  - the PAXG spread, from the rows the ingestor stores every 10 s;
  - the economic calendar and the gold-market sessions, on a 5 s clock.

### De-duplication, cooldown, rate limit, quiet hours, late

- **De-duplication**: a match's `dedupe_key` names one logical occurrence, for example `setup:{id}:confirmed` or `smc:sweep:{id}`. `alerts.events` has `UNIQUE (rule_id, dedupe_key)`, so reprocessing a source never fires it twice, and the evaluator remembers recent keys to skip them early.
- **Cooldown**: per rule and subject (an instrument, an economic event, the gold market or the PAXG spread). A Redis key set with `NX PX cooldown` lets exactly one match through per cooldown, across instances and restarts (criterion 8.3).
- **Edges**: level conditions (`price_change_pct`, `spread_threshold`) fire when the condition becomes true, and again only after it has stopped holding. Crossing conditions need a previous value, so they never fire on the first price seen.
- **Rate limit**: at most 20 native notifications a minute per user. Beyond that, alerts still reach the inbox, delivered as quiet.
- **Quiet hours**: the rule's window, in its own time zone, possibly crossing midnight. Alerts inside it reach the inbox but show no desktop or browser notification.
- **Late**: the source was processed more than 120 s after it was decided (rulebook §8 `late_detection`). For analyzer output this compares the deciding candle's close with the processing time; for `md:events`, the event's time with the time the evaluator read it. Prices, the spread and the clock are never late.

### Delivery

1. The analyzer inserts the `alerts.events` row (`svc_analyzer`) and, if it is new, adds a job to the BullMQ `notifications` queue (job id from the event id).
2. The jobs service:
   - writes one `alerts.notifications` row per channel the rule chose (the `in_app` row is the inbox item);
   - decides `quiet` (quiet hours, or the user's rate limit);
   - appends `alert.fired` to the Redis stream `alerts:events`, addressed to the owner.
3. Every API instance reads `alerts:events` and pushes the message to the owner's sockets subscribed to the implicit per-user channel `alerts`.
   - The channel is durable, with `seq` the stream entry's id, so a reconnecting client replays what it missed, or receives a snapshot: the unread count and the latest items.
   - Marking items read appends `notification.read` to the same stream, so the user's other devices follow.

This changes the architecture's arrow `alerts:events: analyzer → jobs, api` to `jobs, api → api`. The analyzer hands over through the queue instead, which gives delivery its retries. The push therefore carries the inbox item that already exists.

`desktop` and `web` rows are `sent` once the push is on the user's channel. They are not confirmation that a device showed it: a closed app sees the alert in its inbox after reconnecting.

### Clients

- The app subscribes to `alerts`, keeps the unread count in the header's bell, and lists the inbox in the Alert Center.
- An `alert.fired` that arrives live, is not quiet, and names this client's channel (`desktop` in the Tauri app, `web` in a browser tab with permission) becomes a native notification through the platform's `notify()`.
- Messages replayed after a reconnect are not shown one by one: the desktop app shows one summary ("5 alerts while you were away") (criterion 8.4).

## Consequences

- One more lease (`lease:analyzer:alerts`) and one more stream (`alerts:events`, capped like the others). Losing the lease holder pauses global alerts for at most one lease TTL; the `md:events` cursor makes the next holder catch up.
- Rule changes take effect within about 5 s, without a pub/sub subscription in the analyzer.
- Price alerts depend on the ingestor's ticker keys; when a feed is stale (no key), price rules are silent, and `feed_health` rules are the ones that say so.
- A dry run of a price rule is an approximation (1m closes). Every other kind reads the same stored events the live rule reads.
