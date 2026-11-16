# ADR 024: The 3D brain is driven by an activity feed the services report to: per-second counters on `sys:activity`, snapshots and pulses on `system:activity`, deterministic mappings, and a React Three Fiber scene with adaptive quality and a 2D fallback

- Status: accepted (Phase 10)
- Date: 2026-11-16
- Context:
  - [REQUIREMENTS §5](../../REQUIREMENTS.md) (the brain responds to actual system events; no random animation in place of backend processing);
  - VIZ-01, NFR-10 (reduced motion, a text status next to the 3D view), NFR-12 (≥ 50 fps on an integrated GPU, quality drops below 45 fps), C8 (what "receiving data" means);
  - [architecture §12](../phase-0/03-architecture.md#12-3d-visualization) (states, conditions, mappings) and §11 (React Three Fiber, lazy-loaded, WebGL2 or a 2D card), [API contracts §5.3](../phase-0/06-api-contracts.md#53-channels) (`system:activity`, `ActivitySnapshot`, `ActivityPulse`);
  - risk R18 (3D performance on weak GPUs and in WKWebView);
  - implementation plan Phase 10 (criteria 10.1–10.4).

## Context

Phase 0 designed the view (four regions: ingestion, analysis, AI and alerts; states disconnected, error, analysing, receiving and idle; pulse overlays), the channel and its messages, and the stream `sys:activity` ("all → api: activity counters"). Nothing of the feed existed yet: no service reported activity, and the api had no `system:activity` channel. This ADR settles what each service counts, how the api combines it, how the client turns it into a scene, and how the scene stays fast, accessible and honest.

## Decision

### What each service reports

Every service instance run by `runService` (ingestor, analyzer, jobs) appends one **report** a second to the Redis stream **`sys:activity`** (`type` `activity`, `data` the JSON report; `MAXLEN ~ 1000`). A report says what the instance did **during that second**, from counters it already keeps or that sit on its work's own path:

| Service | Report | Where it is counted |
|---|---|---|
| ingestor | venue messages a second, per venue; each venue's connection (`open`, `connecting`, `closed`), or `standby` where another instance holds its lease | the venue hook that also feeds `cip_ingest_messages_total` |
| analyzer | candle boundaries analysed a second; the instruments that analysed some during the second; instruments with a wake-up waiting behind a step; instruments paused (warming up or on a data gap) | each actor's step and its output's `boundaries` |
| jobs | AI calls in flight (the most at once during the second) and waiting | the AI worker; BullMQ's job counts |

What happened during the second rather than a sample at its end: an analysis step takes milliseconds, and a sample would almost never see it. An analyzer actor is also woken every few seconds to retry what is held back; such a wake-up that finds nothing due is not analysis, and is not counted.

### What the api combines

The api already follows every durable stream (ADR 014); it now also follows `sys:activity` (never replayed: it is not a channel). It keeps the latest report of each instance and drops one older than 5 s, so a stopped instance counts nothing. Every **500 ms**, while anyone is subscribed, it sends an **`activity.snapshot`** on the non-durable channel **`system:activity`** (≤ 4 Hz, as designed); a subscribe answers with the current one. The snapshot is the `ActivitySnapshot` of API contracts §5.3:

- `ingest`: the instances' messages a second, summed per venue and in all; `state` `ok` when every venue held by an instance is open, `degraded` when one is not, `down` when no instance reports.
- `analysis`: the analyzers' sums.
- `ai`: in flight and waiting from the jobs service; the last result and its time from `ai:events` (`ai.completed`, `ai.rejected`, `ai.failed`), read from the database at start.
- `alerts`: alerts fired in the last minute (`alert.fired` on `alerts:events`).
- `errors`: from System Health, computed every 5 s as before: **critical** for the database or Redis down, or a service with no live instance; **warning** for a degraded service.

**Pulses** (`activity.pulse`) go out at once, from the stream entries the api reads anyway: a setup transition (`pattern`), a sweep (`sweep`), an MSS (`mss`), an accepted AI analysis (`ai_completed`), a fired alert (`alert`). Alerts are private, so an alert's pulse carries the stream entry's id and nothing else. At most 20 pulses a second per api instance; the rest are dropped and counted.

### The state and the mappings (client, pure functions)

- **State**, first that holds: **disconnected** (no snapshot for 3 s, or the live connection is not live); **error** (any critical error; its region pulses red and the text names the component); **analysing** (`analysis.activeJobs > 0` or `ai.inflight > 0`); **receiving** (`ingest.msgsPerSec ≥ 1`, the idle threshold); **idle**.
- **Mappings** are functions of the snapshot alone, as designed: particle speed = clamp(log10(1 + msgsPerSec) / 3, 0.05, 1); particle density = clamp(log10(1 + msgsPerSec) / 3, 0.1, 1); node firing rate proportional to active jobs (0.2 a second idle, plus 0.6 per active job, at most 5); the AI region's glow from calls in flight and waiting; the alerts region's from alerts in the last minute; an error's region from its component.
- **Smoothing**: displayed parameters approach their targets with a 0.5 s time constant, a function of the frame's elapsed time only. With zero activity they settle at the idle parameters (criterion 10.2).
- **Pulses** are envelopes of time since the pulse (a flash in the analysis region for a pattern, a sweep or an MSS; a wave out of the AI region for a completed analysis; a flash in the alerts region), at most 8 at once.
- **Randomness** is a seeded generator (mulberry32, a fixed seed) used once, to place nodes, connections and particle offsets. It never touches a state or a rate.

### The scene

- **React Three Fiber 9.8.2 and three 0.187.0** (the feasibility study's pins), in the page's own lazy chunk.
- About 1,600 nodes (points) in a brain-shaped volume of two hemispheres, split into the four regions; about 3,000 connections between near nodes; particles flowing along paths from the ingestion region into the analysis region, then towards AI and alerts. Particle positions are computed in the vertex shader from time and each particle's seeded offsets, so the CPU does no per-particle work per frame.
- **Quality**: High (20,000 particles, pixel ratio up to 2), Medium (8,000, up to 1.5), Low (3,000, 1). **Auto** (the default) starts at High; when the frame rate averaged over 2 s falls below 45 fps it drops one tier, and it rises again after 10 s above 57 fps, never above the tier chosen. The choice is kept in the browser.
- **Frame-time telemetry**: the page shows the frame rate and the tier; the canvas's container carries them as `data-fps`, `data-quality` and `data-frames`, for tests and the performance measurements.
- **Paused**: no frame is drawn while the tab is hidden, while the canvas is off screen, or after "Pause animation" (WCAG 2.2.2). **Reduced motion** (the system setting): no particle flow, waves or flashes; the scene draws one still frame when the state changes, with colours and brightness only, and the text says so.
- **Text status**, always next to the canvas: the state and why, the numbers behind it (messages a second per venue, candles analysed, analyses running, AI calls, alerts in the last minute, errors), and the latest pulses with their instrument. A polite live region announces state changes only.
- **2D fallback**: without WebGL2 (or when the canvas fails), or when the user picks "2D", a card shows the same state and numbers, with a meter per region; no canvas.
- **Where**: a page of its own, `/brain` ("System Brain" in the navigation), for every role (all have `dashboards.view`). Rendering 20,000 particles would cost the Command Center's other panels; the page keeps it to where it is asked for.

## Consequences

- The brain shows only what the services measured; with nothing happening it breathes slowly at idle, and with the api unreachable it says "Disconnected".
- Three new per-second writes (one per service instance) and one 500 ms message per subscriber: small next to the market streams.
- The api's view of activity is as fresh as the last report (≤ 1 s) and the snapshot cadence (500 ms).
- The 3D chunk loads only on `/brain`; the initial bundle is unchanged.
- WKWebView (macOS) performance stays to be measured on a Mac, as for Phase 8's macOS items.

## As built (Phase 10)

- **Contracts** (`packages/contracts/src/activity.ts`): the report, the snapshot (each error may carry a `detail`), the pulse, and the constants (`sys:activity`, a report a second, stale after 5 s, a snapshot every 500 ms, "Disconnected" after 3 s, 20 pulses a second).
- **Reporting** (`packages/observability/src/activity.ts`): `RateCounter` (events a second since the last report), `PeakGauge` (the most in progress at once), and `ActivityPublisher`, which `runService` starts for a service that supplies `activity()`. The ingestor counts each venue message where it already counts `cip_ingest_messages_total`; the analyzer's actors report the candle boundaries they analyse, and the analyzer counts the instruments that analysed some in the second (a first count of every step in progress showed "analysing" for a second every 5 s, from the routine wake-ups); the jobs service counts the AI worker's calls and asks BullMQ for the waiting ones.
- **The api** (`apps/api/src/live/activity.ts`): `ActivityAggregator` and `pulseOf`, fed by the gateway's existing stream reader (which now also reads `sys:activity`); System Health's check every 5 s also feeds the errors while anyone watches; a subscriber whose errors are older than 10 s gets a fresh check first.
- **The client**: `lib/brain/` (the state, the mappings, the smoothing, the pulses, the quality controller, the seeded layout: pure functions), `live/activity-hooks.ts` (the feed), `components/brain/` (the scene, the text status, the 2D view, the browser hooks) and `pages/system-brain.tsx`.
- **The test hooks**: the scene's container carries `data-frameloop`, `data-fps`, `data-quality`, `data-frames`, `data-state` and `data-pulses`; the status carries `data-brain-state`, `data-brain-ingest`, `data-brain-pulses` and `data-brain-rendering`.
- **Bundle**: the scene's chunk is 923 kB (245 kB gzipped). React Three Fiber registers the whole of three.js, so it does not shrink by importing less; it loads only on `/brain`, after the page and its text status, and the initial bundle is unchanged.
