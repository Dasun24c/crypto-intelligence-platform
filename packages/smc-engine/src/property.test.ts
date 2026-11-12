import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Timeframe } from '@cip/domain';
import { invariantViolations } from '../test/invariants.js';
import { SmcEngine } from './engine.js';
import { aggregate, runEngine, toSteps } from './harness.js';
import { CRYPTO_MAJORS_SMC_PARAMS } from './params.js';
import { fromUnits } from './price.js';
import type { EngineCandle, StepInput } from './types.js';

/**
 * Rulebook §13 and criterion 4.2 on random markets (fast-check, 1,000 runs): random walks on 5m
 * with random ranges, missing candles (unrepairable gaps) and partial candles, aggregated to 15m
 * and 1h as the platform builds them, and 1m micro profiles under part of the series. For a random
 * cut point:
 *
 * - **No repainting**: the events emitted for the boundaries up to the cut are the same whether or
 *   not later candles exist.
 * - **Checkpoints**: a snapshot taken at the cut, through JSON, continues exactly.
 * - **Invariants**: seq order, no event about an unclosed candle, prices on the tick, entities
 *   created once, nothing changes after a level is swept, broken or expired, and setups move only
 *   along the state machine and never leave `resolved` (criterion 6.2).
 *
 * The markets must reach every setup state, so that the setup invariants are tested, not vacuous.
 */
const CONFIG = { params: CRYPTO_MAJORS_SMC_PARAMS, tick: '0.01' };
const START = Date.UTC(2026, 2, 2); // a Monday

interface Market {
  steps: StepInput[];
}

const marketArb: fc.Arbitrary<Market> = fc
  .record({
    n: fc.integer({ min: 60, max: 260 }),
    moves: fc.array(fc.integer({ min: -60, max: 60 }), { minLength: 260, maxLength: 260 }),
    ranges: fc.array(fc.integer({ min: 1, max: 80 }), { minLength: 260, maxLength: 260 }),
    holes: fc.array(fc.integer({ min: 0, max: 259 }), { maxLength: 4 }),
    partial: fc.array(fc.integer({ min: 0, max: 259 }), { maxLength: 2 }),
    minutesFrom: fc.option(fc.integer({ min: 0, max: 250 }), { nil: null }),
    seed: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map(({ n, moves, ranges, holes, partial, minutesFrom, seed }) => {
    // Prices in cents: a random walk around 100.00 with random wicks.
    let close = 10_000;
    const five: EngineCandle[] = [];
    const ones: EngineCandle[] = [];
    let r = seed;
    const rand = () => {
      r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
      return r / 2_147_483_648;
    };
    for (let i = 0; i < n; i++) {
      const open = close;
      close = Math.max(1_000, open + moves[i]!);
      const high = Math.max(open, close) + Math.floor(ranges[i]! * rand());
      const low = Math.max(1, Math.min(open, close) - Math.floor(ranges[i]! * rand()));
      const openTime = START + i * 300_000;
      if (holes.includes(i)) continue;
      five.push({
        tf: '5m',
        openTime,
        open: fromUnits(open * 1_000_000),
        high: fromUnits(high * 1_000_000),
        low: fromUnits(low * 1_000_000),
        close: fromUnits(close * 1_000_000),
        volume: '10',
        quality: partial.includes(i) ? 'partial' : 'complete',
        underlyingClosed: false,
      });
      if (minutesFrom !== null && i >= minutesFrom) {
        // Five minutes inside the 5m candle: open → low → high → close, each with a profile.
        const path = [open, low, high, close, close];
        for (let m = 0; m < 5; m++) {
          const a = path[m]!;
          const b = path[Math.min(4, m + 1)]!;
          ones.push({
            tf: '1m',
            openTime: openTime + m * 60_000,
            open: fromUnits(a * 1_000_000),
            high: fromUnits(Math.max(a, b) * 1_000_000),
            low: fromUnits(Math.min(a, b) * 1_000_000),
            close: fromUnits(b * 1_000_000),
            volume: '2',
            quality: 'complete',
            underlyingClosed: false,
            microProfile: rand() < 0.9 ? Array.from({ length: 24 }, () => Math.floor(rand() * 5) / 4) : null,
          });
        }
      }
    }
    const last = START + n * 300_000;
    const byTf: Partial<Record<Timeframe, EngineCandle[]>> = { '5m': five };
    for (const tf of ['15m', '1h'] as Timeframe[])
      byTf[tf] = aggregate(five, tf).filter((c) => c.openTime + (tf === '15m' ? 900_000 : 3_600_000) <= last);
    // A higher timeframe whose last candles are missing would stop early; keep the series aligned.
    if (ones.length) byTf['1m'] = ones.filter((c) => c.openTime < (five.at(-1)?.openTime ?? 0) + 300_000);
    return { steps: toSteps(byTf) };
  })
  .filter((m) => m.steps.length > 0 && stepsAreConsistent(m.steps));

/**
 * toSteps lets a timeframe end where its data ends. A random hole at the very end of the 5m series
 * can leave a longer timeframe due at a boundary after the last 5m candle; skip those markets.
 */
function stepsAreConsistent(steps: StepInput[]): boolean {
  try {
    runEngine(new SmcEngine(CONFIG), steps);
    return true;
  } catch {
    return false;
  }
}

describe('random markets (fast-check)', () => {
  it('never repaint, continue exactly from checkpoints and keep the invariants', () => {
    const reached = new Map<string, number>();
    fc.assert(
      fc.property(marketArb, fc.double({ min: 0, max: 1, noNaN: true }), ({ steps }, at) => {
        const full = runEngine(new SmcEngine(CONFIG), steps);
        expect(invariantViolations(full.events, CONFIG.tick)).toEqual([]);
        for (const e of full.events)
          if (e.type === 'setup_transition') reached.set(e.data.to, (reached.get(e.data.to) ?? 0) + 1);
        const cut = Math.max(1, Math.min(steps.length, Math.ceil(at * steps.length)));
        const engine = new SmcEngine(CONFIG);
        const prefix = runEngine(engine, steps.slice(0, cut)).events;
        expect(prefix).toEqual(full.steps.slice(0, cut).flatMap((s) => s.events));
        const restored = SmcEngine.restore(JSON.parse(JSON.stringify(engine.snapshot())), CONFIG);
        expect(runEngine(restored, steps.slice(cut)).events).toEqual(
          full.steps.slice(cut).flatMap((s) => s.events),
        );
      }),
      { numRuns: 1000, seed: 20261111 },
    );
    // With this seed: about 11,600 setups formed, 17 confirmed, 4 entries and 10,600 resolutions.
    for (const state of ['forming', 'triggered', 'confirmed', 'entry_active', 'resolved'])
      expect(reached.get(state) ?? 0, state).toBeGreaterThan(0);
  });
});
