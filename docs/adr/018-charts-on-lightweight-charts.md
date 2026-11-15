# ADR 018: Charts are Lightweight Charts with our own overlay primitives, and report what they drew

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-12 |
| Deciders | Phase 7 implementation, within the architecture approved in Phase 0 |
| Related | [Architecture §11](../phase-0/03-architecture.md) · [Feasibility §7](../phase-0/02-feasibility.md#7-stack-versions-and-licences) · [Implementation plan, criteria 7.1, 7.4, 7.5](../phase-0/08-implementation-plan.md#phase-7--charts-setup-scanner-and-calendar) · `packages/app/src/charts/` |

## Context

Phase 7 needs candlestick charts with SMC overlays (REQUIREMENTS §6, the Liquidity Map), interactive Technical Analysis charts, and proof that a chart draws exactly what the overlay API returns (criterion 7.1). Phase 3 drew its charts as hand-written SVG; the architecture chose a candlestick library with custom primitives for zones, levels, sweeps and closure shading, and the feasibility study pinned TradingView Lightweight Charts 5.2.1 (Apache-2.0, with the NOTICE text and a link to tradingview.com). Three questions were open:

1. **How overlays are drawn.** The library's markers and price lines cannot draw a zone that starts and ends at given times, nor shade a time span, and drawing them would happen inside the library, out of reach of a test.
2. **How a test sees what a canvas drew.** A canvas has no DOM to query, and jsdom has no canvas.
3. **Where the attribution goes,** given that the desktop app opens links through its host, and the library's own logo is an `<a target="_blank">` inside the canvas area.

## Decision

**1. One primitive draws the whole overlay.** `OverlayPrimitive` (a series primitive) draws every overlay item itself: closures, ranges and zones behind the candles; levels, setups' hypothetical levels, swings, BOS/CHOCH/MSS and sweeps in front. A pure function (`overlayItems`) first turns `GET /smc/{id}/overlay` into items in data space (times, decimal prices); the primitive maps times to the chart's logical positions (`TimeIndex`; the chart has no gaps between bars) and prices to pixels. Its `autoscaleInfo` widens the price scale to every drawn price, so nothing it draws is off screen. Sweeps sit on their confirming candle, which is also how the API windows them.

**2. The chart reports what it drew.** After every paint, the primitive records each item it actually drew (it had coordinates and lay inside the pane) as `{kind, id, ...the values it was drawn from}`. The chart writes the list to its container as `data-drawn`, with the window it shows (`data-from`, `data-to`, `data-tf`, `data-instrument`) and `data-ready` once the overlay is the one for those candles. The end-to-end test reads this, asks the API for the overlay of the same window, builds its own expectation from the API's JSON (not with the app's code), and requires them to be equal (criterion 7.1). The same items fill a table under the chart, its text alternative.

**3. Tests without a canvas.** Unit tests mock only the hook that creates the chart (`useChart`); the page, the chart's container, its captions and tables, and the data passed to it are real. Drawing itself is tested in the browser, end to end.

**4. Attribution under every chart.** The library's logo is turned off (`attributionLogo: false`, allowed when the requirement is met otherwise); every chart has a line with the NOTICE text ("TradingView Lightweight Charts™, Copyright (с) 2025 TradingView, Inc.") and a link to tradingview.com that opens through `Platform.openExternal`.

**5. Charts load with their pages.** The chart pages (Liquidity Map, Technical Analysis, setup detail) are lazy routes, so the library is in their chunks, not in the initial bundle (architecture §11's budget).

## Consequences

**Positive**

- Overlay parity is checked on the real drawing code, in a real browser, against the API.
- One chart component serves the Liquidity Map and the setup detail; the Technical Analysis chart uses the same hook, theme and attribution.
- Charts follow the design system's tokens and the user's display time zone.

**Negative**

- The overlay's drawing (shapes, labels, colours) is ours to maintain, not the library's.
- `data-drawn` is rewritten after paints in which the drawn set changed; it can hold a few hundred records on a busy chart.
- Phase 3's SVG charts and their tests were replaced; their text summaries were kept as the new chart's caption.
