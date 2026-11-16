# Phase 10 · 3D visualization: acceptance report

| | |
|---|---|
| Status | **Built; waiting for your acceptance.** The four criteria are met on this machine; 10.3 was measured on its Intel integrated GPU (the Iris Xe class the criterion names). Apple M1 and the macOS desktop app's WKWebView are not available here: they are carried forward, as Phase 8's macOS items were. Committed on 2026-11-16 at your request, on the branch `phase-10/3d-visualization`, on top of the Phase 16 changes of the same day (their own commit, which `phase-16/fixed-amount` also points to); not pushed |
| Date | 2026-11-16 |
| Scope | [Implementation plan, Phase 10](../phase-0/08-implementation-plan.md#phase-10--3d-visualization), REQUIREMENTS §5 (VIZ-01), NFR-10, NFR-12, C8, [architecture §11–§12](../phase-0/03-architecture.md#12-3d-visualization), [API contracts §5.3](../phase-0/06-api-contracts.md#53-channels), [ADR 024](../adr/024-activity-feed-and-3d-brain.md) |
| Evidence | This machine (Windows 11, Intel Core Ultra 5 235U with Intel Graphics, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, redeployed with Phase 10 on 2026-11-16 |

## Summary

**System Brain** (`/brain`, in the navigation for every role) is a live 3D view of what the platform is doing. It moves only when the platform does something: every state and every rate comes from what the services count, and nothing on screen is random.

- **What feeds it** (ADR 024): every second, each ingestor, analyzer and jobs instance reports what it did during that second: venue messages per venue and each venue's connection; candle boundaries analysed, the instruments that analysed some, those waiting and those held back; AI calls in progress and waiting. The api combines the latest reports with the alerts fired in the last minute, the AI's last result and System Health's problems, and sends a snapshot twice a second on the `system:activity` channel. Setup changes, sweeps, market structure shifts, accepted AI analyses and fired alerts go out at once, as pulses (an alert's pulse carries nothing of its owner).
- **The brain**: about 1,600 nodes in four regions (ingestion at the back, analysis above the middle, alerts below it, AI at the front), about 3,000 links, and up to 20,000 particles flowing from ingestion through analysis to AI and alerts.
- **Its states**: **Disconnected** (no snapshot for 3 s, or the live connection down: dim and grey); **Error** (a critical problem: its region pulses red and the text names the component); **Analysing** (an instrument analysed candles this second, or an AI call is in progress: nodes fire faster); **Receiving data** (1 venue message a second or more: particles flow, faster with the rate); **Idle** (a slow breathing). Pulses: a flash in the analysis region for a detection (at a place fixed by the event's id), a wave out of the AI region for a completed analysis, a flash in the alerts region for an alert.
- **Beside it, always**: the text status (the state and why; messages a second per venue; candles, analyses, waiting and held back; AI calls and the last result; alerts in the last minute; problems; the latest events with their pairs; how it is drawing). A screen reader hears the state when it changes.
- **Controls**: Pause animation; Quality (Automatic, High, Medium, Low; remembered in the browser); View (3D or 2D). Reduced motion (the system setting) draws still frames. A hidden tab or a canvas scrolled away draws nothing. Without WebGL2, or when the canvas fails, the 2D view (a meter per region) stands in.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 10.1 | Injected activity sequences drive the expected states: idle, receiving, analysing, completion, pattern pulse, error, disconnected | **Met** | The state machine fed one injected sequence goes through all seven, in order; the page follows injected snapshots and pulses over the live channel; the api turns injected reports and a setup transition into a snapshot and a pulse; on the live stack the page shows the services' own counts, and an injected setup change appears as its pulse, in the text and in the scene. [10.1](#101-states-from-real-activity) |
| 10.2 | With zero activity the scene settles at idle parameters. Unit tests on the mapping functions show no state or rate depends on randomness | **Met** | From a busy, a disconnected and an error state, zero activity settles at the idle parameters (within 10⁻⁶ after 10 s, at 60 and at 23 frames a second alike); `Math.random` is never called by the state, the mappings, the smoothing, the pulses, the quality or the layout; the seeded layout is the same every time. [10.2](#102-idle-and-no-randomness) |
| 10.3 | ≥ 50 fps at default quality on Apple M1 and Intel Iris Xe class hardware. Adaptive quality engages below 45 fps | **Met on this machine's Intel GPU; M1 carried forward** | 60 fps at the default quality (Automatic, staying at High: 20,000 particles), at 1× and at 2× pixel density; at least 59 at every quality; the controller drops a tier below 45 fps and rises after 10 s above 57 (tested on frame times). [10.3](#103-frame-rate) |
| 10.4 | Rendering pauses when hidden, reduced motion is respected, and the text status is always visible | **Met** | End to end: Pause stops the frames and Resume restarts them; a hidden tab draws nothing and draws again when shown; reduced motion switches to still frames with the reason in the text; the text status is there in every state, with or without the canvas; axe finds nothing serious. [10.4](#104-hidden-reduced-motion-and-the-text) |

### 10.1 States from real activity

- **The services' own counts** (the live stack after the final redeploy at 09:06 UTC): the analyzer reported one second of catch-up (21 candle boundaries over 3 instruments); then, of 333 consecutive seconds (about 09:09–09:15), 320 had nothing analysed and the other 13 fell at the minutes' candle closes, with 1 to 5 instruments analysing 1 to 5 boundaries. The ingestor reported 35 to 130 Binance and 57 to 128 Coinbase messages a second; the jobs service, no AI call (there is no Grok key yet).
- **The sequence** (`lib/brain/brain.test.ts`): idle → receiving (240 messages a second) → analysing (2 instruments) → completion (an accepted AI analysis: a wave from the AI region over "receiving") → pattern pulse (a setup change: a flash in the analysis region, the wave still fading) → error (the ingestor critical) → disconnected (no snapshot for 3 s). The reasons in words, the regions of each component's problems and the pulses' descriptions are tested with it.
- **The page** (`pages/system-brain.test.tsx`): snapshots and pulses pushed over the fake live connection: "Receiving data" with the counts per venue, "Analysing" with "2 instruments analysing; 1 AI call in progress", the latest events with their pairs (a setup change on Binance BTC/USDT, a sweep on Coinbase BTC/USD, an alert with nothing more), a pulse off the contract ignored, "Error" naming the ingestor (and the analyzer's warning), "Disconnected" when the connection drops.
- **The api** (`apps/api/test/live.int.test.ts`): reports appended to `sys:activity` arrive summed in the next snapshot; a malformed one is ignored; a setup transition on `an:events` arrives as a pattern pulse.

### 10.2 Idle and no randomness

The mappings are functions of the snapshot only: particle speed = clamp(log10(1 + messages a second) / 3, 0.05, 1), as designed; the same for the density, from 0.1; node firing 0.2 a second plus 0.6 per instrument analysing (at most 5); the glows from the AI calls, the alerts and the analysis. The shown values move towards their targets by 1 − e^(−dt/0.5 s) per frame, so the result depends on elapsed time, not on the frame rate. The seeded generator (mulberry32, a fixed seed) places nodes, links and particle paths once; a pulse starts at a node chosen by a hash of its event's id.

### 10.3 Frame rate

Measured with `e2e/tests/phase10-perf.spec.ts` (run with `E2E_PERF=1`) on 2026-11-16 at 09:12–09:14 UTC, against the live stack: this machine's Intel Core Ultra 5 235U with its integrated Intel Graphics (the renderer reported "ANGLE (Intel, Intel(R) Graphics (0x00007D41) Direct3D11)"), Chromium drawing with the GPU, a 1440 × 900 window. For each quality, after 4 s to settle, the page's own frame rate (averaged over 2 s) was read every 0.5 s for 12 s. At 2× pixel density the canvas has four times the pixels (2880 × 1800), as on a Retina display.

| Quality | Particles | 1× (1440 × 900): mean / lowest fps | 2× (2880 × 1800): mean / lowest fps |
|---|---|---|---|
| High | 20,000 | 60 / 60 | 60 / 60 |
| Medium | 8,000 | 60 / 60 | 59.9 / 59 |
| Low | 3,000 | 60 / 60 | 60 / 59 |
| **Automatic (the default)** | starts at High | **60 / 60, stayed at High** | **60 / 60, stayed at High** |

60 fps is the browser's frame cap here, so the default quality holds the criterion's 50 fps with room to spare. The adaptive quality is tested on frame times (`lib/brain/brain.test.ts`): at 40 fps it drops from High to Medium after 2 s, then to Low; it stays at Low under 45 fps; after more than 10 s above 57 fps it rises one tier; a long frame (a hidden tab, a stopped loop) is a pause, not slowness; a quality chosen by hand never changes.

### 10.4 Hidden, reduced motion and the text

- **Pause** (WCAG 2.2.2): the loop stops (`data-frameloop="never"`), no frame is drawn for 1.5 s, the text says "Animation paused."; Resume draws again.
- **A hidden tab**: the loop stops and nothing is drawn; shown again, it draws. Headless Chromium keeps background tabs visible, so the end-to-end test tells the page its tab is hidden the way a browser does (`visibilitychange`); the decision itself (hidden, off screen or paused: never; reduced motion: on demand; otherwise every frame) is a unit-tested function. A canvas scrolled out of view stops the same way.
- **Reduced motion**: with the system setting, the loop draws on demand only: one still frame per snapshot, with the colours and brightness of the state and no flow, flashes or waves; the text says "Still image: your system asks for reduced motion." Switched back, it animates again.
- **The text status** is outside the canvas, so it is there in every state and view: with the 3D view, the 2D view, before the first snapshot ("Waiting for the first activity report."), and disconnected. It names each state's reason, and a polite live region announces the state when it changes. The canvas is hidden from assistive technology; the controls are ordinary buttons and selects. axe (WCAG 2.0/2.1 A and AA) finds nothing serious or critical on the page.
- **The 2D view**: with WebGL2 removed from the page, the 2D view shows four meters (one per region) and no canvas; it says why.

## Decisions made while building it

Recorded in [ADR 024](../adr/024-activity-feed-and-3d-brain.md) and its "As built". The ones you may want to know about:

1. **A page of its own**, System Brain, rather than a panel of the Command Center: up to 20,000 particles would cost the Command Center's other panels, and its chunk (245 kB gzipped) loads only when the page is opened.
2. **"Analysing" means real analysis**: an instrument analysed candles during that second, or an AI call is in progress. The analyzer also wakes each instrument every 5 s to retry what is held back; a wake-up that finds nothing due is not counted (a first version counted it, and the brain said "analysing" for a second every 5 s).
3. **What is an error**: the Error state is for a dependency down or a service with no running instance. A degraded service (an instrument paused on a data gap, a venue reconnecting) shows as a warning: amber in its regions and named in the text, without the Error state.
4. **Alerts' pulses carry nothing of their owner**: alerts are private, and the channel is for every role.
5. **The AI region rests while there is no Grok key**: it lights only for real calls.

## Live

On the local stack (2026-11-16, UTC):

- **08:28**: redeployed with the activity feed and the page: the three services' reports reached `sys:activity` at once (the ingestor's first: 46 Binance and 98 Coinbase messages a second); the page showed "Receiving data" with the same numbers and drew the brain.
- **08:30–08:35**: the Phase 10 spec, 4 of 4 (the hidden tab signalled to the page from the second run on), and the first frame-rate measurement: 60 fps at every quality at 1×.
- **08:45**: redeployed (the scene's final camera, the api's check of which entries can pulse); **08:47–09:03**: every end-to-end spec, all phases: 25 passed; 3 timed out while the database caught up after the redeploy (above), and the 4 Phase 14 tests behind one of them did not run.
- **09:06**: redeployed with the analyzer's final count (finding 1); the reports since show analysis only at candle closes.
- **09:07–09:10**: the specs that had timed out, and Phase 10's again: **15 of 15** passed (the admin's TOTP and audit chain, Phase 14's 5, Phase 7's 5, Phase 10's 4).
- **09:12–09:14**: the frame rate at 1× and 2× (above).
- **09:29–09:40**: `pnpm verify` passed (below). **09:44–10:18**: the integration suites (below).

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | The analyzer counted every step in progress as analysing, including the routine wake-up every 5 s that finds nothing due (the live stack's reports: "1 analysing, 0 candles" in about one second in five) | The brain would have said "Analysing" for a second every 5 s with nothing analysed | It counts the instruments that analysed candles in the second; the analyzer's integration test checks that a wake-up with nothing due counts nothing |
| 2 | The scene wrote its frame-time telemetry onto an element its parent owned (the React rules' lint check) | A component changing what it was given breaks React's assumptions | The scene that owns the element writes it |
| 3 | The api parsed the JSON of every market event and indicator point to see whether it could pulse (found re-reading the code) | Needless work for each of the many entries that can never pulse | The entry's stream and type are checked first |
| 4 | Headless Chromium keeps background tabs visible (the end-to-end test of a hidden tab could not hide one) | The hidden-tab case could not be shown end to end | The test tells the page its tab is hidden as a browser does (`visibilitychange`); the decision is also a unit-tested function |

The tests needed these corrections; none is a product defect:

- The state-sequence test's error step used a snapshot already 5 s old, so it read as disconnected; it now arrives in time.
- The page test expected the ingestion meter at 100 % in the error state (it shows the region's activity, 79 %, with "problem"), and chose a quality while the 2D view is shown (the choice is off then, by design).
- Twice, `pnpm verify` stopped when four of the app's test files could not start their workers in time on this loaded machine (no test failed; every other package passed); the third run passed (below).
- In the first run of every end-to-end spec, started right after the stack was redeployed, three tests timed out while the database caught up (the admin's audit-chain check, Phase 14's first test, Phase 7's chart load) and four Phase 14 tests behind the first did not run; run again once the stack had settled, they passed.

## Tests and coverage

2,270 automated tests, all passing: 1,631 unit, 605 integration and 34 end to end (Phase 9: 2,221). They include the tests of the two Phase 16 changes of 2026-11-16 (a fixed amount per automatic buy; notifications of each automatic trade).

- `pnpm verify` passes on the final code (2026-11-16, 09:29–09:40 UTC; Turbo reused this session's earlier results where nothing had changed): formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the bundle scan (35 files, 45 rules).
- The integration suites of all seven packages that have them pass with coverage: six in the full run (09:44–10:11 UTC); the analyzer's alone at 10:11–10:18, after two of its SMC warm-up tests ran past their 60 s limit in the full run, right after the api's suite (above).
- Every end-to-end spec passed on the stack: the full run (08:47–09:03 UTC) and, after the final redeploy, the rerun of the specs it could not finish, with Phase 10's again (09:07–09:10). Phase 8, 9, 16, the analysis and smoke specs ran before the analyzer's final count (finding 1), which they do not touch.

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration) | What is new in Phase 10 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| app | 193 (174) | The brain's state, mappings, smoothing, pulses, quality controller and seeded layout (10, with the seven-state sequence of 10.1 and the idle settling of 10.2); the System Brain page (3: the text status, injected activity, the 2D view, the stored choices); the notifications of automatic trades (Phase 16 change: 3 unit, 2 on the page) | none yet | 81.1% / 70.1% (`lib/brain`: 100% / 95.7%) |
| api | 27 + 451 (19 + 449) | The aggregator, its errors from System Health, the pulses and their limit (8 unit); the `system:activity` channel: the snapshot from injected reports, a malformed report ignored, a setup transition's pulse (integration) | 70% | 90.9% / 76.9% |
| contracts | 85 (81) | The activity report, snapshot and pulse, and the channel | 90% | 100% / 100% |
| observability | 15 + 4 (11 + 4) | The rate counter, the peak gauge and the publisher (4 unit); `runService` reporting each second to `sys:activity` through Redis, and stopping (integration) | 70% | 88.3% / 73.0% |
| analyzer | 5 + 25 (5 + 25) | Its counts after a warm-up, and nothing counted for a wake-up with nothing due | 70% | 90.8% / 76.0% |
| ingestor | 6 + 14 (6 + 14) | None (its count is on the venue hook) | 70% | 91.6% / 81.1% |
| jobs | 19 + 50 (19 + 50) | None (its count wraps the AI worker) | 70% | 94.8% / 82.9% |
| broker | 3 + 17 (3 + 17) | None in Phase 10 (the fixed amount's test changed) | 70% | 96.2% / 78.4% |
| db | 2 + 44 (2 + 44) | None | 70% | 99.2% / 85.4% |
| End to end | 34 (26) | `phase10.spec.ts` (4: 10.1 and 10.4 on the stack); `phase10-perf.spec.ts` (2: 10.3, run on purpose); the Phase 16 changes (2) | | |

The other packages (ai, alerts, domain, exchange-adapters, indicators, market-data, smc-engine, ui) are unchanged; paper-engine has the fixed amount's tests (56; 99.4% / 90.9%).

## Not covered, and limits

- **Apple M1, and macOS's WKWebView** (criterion 10.3's second machine, risk R18): not available here; measure them on a Mac with `E2E_PERF=1` and the desktop app. Carried forward, as Phase 8's macOS items were.
- **60 fps is the browser's frame cap** on this machine, reached at every quality: the measurement shows the 50 fps criterion met with room, not how much room. The automatic quality has not had to drop a tier here; its behaviour below 45 fps is tested on recorded frame times.
- **The measurement draws headless**, through ANGLE on Direct3D 11 with the machine's GPU (the same path a visible Chromium or Edge window takes), so as not to open windows on your desktop; `E2E_HEADED=1` measures in a visible window.
- **The desktop app was not rebuilt**: the page is in `packages/app`, so the next desktop build has it (WebView2 on Windows has WebGL2).
- **In CI** (the replay stack, Linux, no GPU) the Phase 10 spec runs (it is not live-only), drawing in software with SwiftShader, where the automatic quality settles lower; the frame-rate measurement does not run there.
- **No Grok key yet**, so the AI region has not lit for a real call on this stack; its path (the jobs service's count of calls in progress, `ai.completed` → a pulse) is tested.
- **On the replay stack** the Phase 10 spec is meant to run too (its pair falls back to the replay venue's, and SwiftShader is asked for by name off Windows), but here it ran only against the live stack; CI will be its first run there.
- **Committed, not pushed**: on `phase-10/3d-visualization`, on top of the Phase 16 changes of 2026-11-16 (a fixed amount per automatic buy, and notifications of each automatic trade), committed on their own.
