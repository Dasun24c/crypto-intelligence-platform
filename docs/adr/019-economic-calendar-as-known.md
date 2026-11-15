# ADR 019: The economic calendar keeps every version, and the engine reads it as it was known

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-12 |
| Deciders | Phase 7 implementation, within the architecture approved in Phase 0 |
| Related | [ADR 004](004-smc-engine-event-sourced-reducer.md) · [ADR 017](017-smc-runtime-boundaries-ids-digests-replays.md) · [Feasibility §6.1](../phase-0/02-feasibility.md#61-economic-calendar) · [Rulebook §7 item 8, I38](../phase-0/07-smc-rulebook.md) · [Implementation plan, criterion 7.3](../phase-0/08-implementation-plan.md#phase-7--charts-setup-scanner-and-calendar) |

## Context

Checklist item 8 fails a setup confirmed within a profile's blackout window around a high-impact event (rulebook §7). Phase 6 had no calendar, so the item always failed as `calendar_unavailable`. Phase 7 brings the calendar: FRED's release dates (CPI, Employment Situation, GDP, Personal Income and Outlays), BEA's schedule with times (GDP and Personal Income and Outlays), and FOMC statements an admin enters (feasibility §6.1).

The engine is deterministic, and replays must reproduce the live run's digest (ADR 004, 017). Rulebook §1 says the engine's context holds only what is known at a candle's close. The calendar, though, changes after the fact: a sync adds a date or moves one, BEA reschedules, an admin enters a statement late or removes one, and the very first sync happens at some point in a run's life. A replay that read today's calendar would decide item 8 differently from the live run whenever any of that happened near a setup.

## Decision

**1. Every version is kept.** `market.economic_events` holds each release as known now; rows are never deleted (a removed entry or a date a source dropped is `cancelled`; a FRED date that BEA lists with its time is `superseded`). Triggers append a row to `market.economic_event_revisions` whenever an event is created or changes in anything item 8 or the calendar shows. Revisions are append-only, written by a `SECURITY DEFINER` trigger, so no service can write or change them directly.

**2. A version counts from the second whole minute after it was recorded** (`calendarKnownFrom`), until the next version's start. The analyzer reloads the calendar at least every 20 s while it processes boundaries (and before each batch of a catch-up), so every live decision from that minute on has seen the change, and so does any replay. The calendar becomes available at the same rounding of the first complete FRED sync's finish (`market.calendar_syncs`); before it, item 8 fails as `calendar_unavailable`, as without FRED it would miss CPI and the Employment Situation.

**3. The engine filters, the analyzer loads.** The engine's `EconomicEventRef` gains optional `knownFrom` and `knownUntil`, and its context `calendarAvailableFrom`; item 8 reads only the versions known at the decision (`calendarAt`). The analyzer gives every version of every event scheduled in the run's span; replays load the same. Ruleset 0.3.1 (rulebook I38); live runs were superseded on deploy.

**4. Syncs are idempotent and recorded.** The jobs service syncs BEA, then FRED, every 6 hours and at start-up (also on `POST /calendar/sync`). A run that finds nothing new writes no event and no revision. Each source's attempt is a row in `market.calendar_syncs` (`ok`, `failed`, or `skipped` without a FRED key). A change is announced on `config:calendar`; the API forwards it to clients as `calendar.updated`.

## Consequences

**Positive**

- Live runs, restarts, takeovers and replays decide item 8 the same way, whatever happened to the calendar since.
- The calendar's history answers "what did the platform know when it confirmed this setup?".
- A missing FRED key, a failed source or a late admin entry is visible (calendar status, System Health) and never silently makes item 8 pass.

**Negative**

- A calendar change counts one to two minutes after it is recorded, not instantly.
- History before the first FRED sync has no calendar: setups decided then keep `calendar_unavailable`, also in replays.
- Every analyzer reload reads the event versions of the run's span (dozens of rows); cheap, but not free.
