import { describe, expect, it } from 'vitest';
import { fixtureConfig, fixtureInput, fixtureProblems, loadFixtures } from '../test/fixtures.js';
import { invariantViolations } from '../test/invariants.js';
import { SmcEngine } from './engine.js';
import { runEngine } from './harness.js';
import type { SmcEvent } from './types.js';

/**
 * Criteria 4.1 and 4.2: every golden fixture (rulebook §12) gives exactly its labelled detections,
 * keeps the §13 invariants, and is prefix-stable: the events for candles 0..n are the same whether
 * or not later candles exist, at every cut point (or 1,000 random ones in a longer fixture). A
 * checkpoint taken at any cut also continues exactly.
 */
const fixtures = loadFixtures();

/** Cut points: all of them, or 1,000 drawn with a fixed seed. */
function cuts(n: number, seed: number): number[] {
  if (n <= 1000) return Array.from({ length: n }, (_, i) => i + 1);
  let s = seed >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < 1000; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out.push(1 + ((s >>> 0) % n));
  }
  return out;
}

/** Rulebook §2–§3 concepts, each needing 3 bullish, 3 bearish and 3 negative fixtures (§12). */
const CONCEPTS = [
  'swings',
  'structure-bos',
  'structure-choch',
  'structure-mss',
  'displacement',
  'ranges',
  'equal-levels',
  'period-levels',
  'session-levels',
  'weekend-levels',
  'sweeps',
  'false-breakouts',
  'breakouts',
  'thin-book',
];

describe('golden fixtures', () => {
  it('meet the rulebook §12 minimum coverage', () => {
    const count = (concept: string, cls: string) =>
      fixtures.filter(({ fixture }) => fixture.concept === concept && fixture.class === cls).length;
    for (const concept of CONCEPTS)
      for (const cls of ['bullish', 'bearish', 'negative'])
        expect(count(concept, cls), `${concept} ${cls}`).toBeGreaterThanOrEqual(3);
    for (const cls of ['closure', 'reopening', 'thin_book'])
      expect(count('gold', cls), `gold ${cls}`).toBeGreaterThanOrEqual(3);
    for (const { path, fixture } of fixtures) {
      expect(path.startsWith(`${fixture.concept}/`), path).toBe(true);
      expect(fixture.labelledBy, path).toBeTruthy();
    }
  });

  for (const { path, fixture } of fixtures) {
    describe(path, () => {
      const config = fixtureConfig(fixture);
      const { steps, context } = fixtureInput(fixture);
      let memo: ReturnType<typeof runEngine> | undefined;
      const run = () => (memo ??= runEngine(new SmcEngine(config), steps, context));

      it('gives the labelled detections', () => {
        expect(fixtureProblems(fixture, run().events)).toEqual([]);
      });

      it('keeps the invariants', () => {
        expect(invariantViolations(run().events, config.tick)).toEqual([]);
      });

      it('is prefix-stable and checkpoint-stable at every cut', () => {
        const byStep: SmcEvent[][] = run().steps.map((s) => s.events);
        for (const cut of cuts(steps.length, path.length * 7919)) {
          const engine = new SmcEngine(config);
          const prefix = runEngine(engine, steps.slice(0, cut), context).events;
          expect(prefix).toEqual(byStep.slice(0, cut).flat());
          if (cut % 7 === 0 || cut === steps.length) {
            const restored = SmcEngine.restore(JSON.parse(JSON.stringify(engine.snapshot())), config);
            expect(runEngine(restored, steps.slice(cut), context).events).toEqual(byStep.slice(cut).flat());
          }
        }
      });
    });
  }
});
