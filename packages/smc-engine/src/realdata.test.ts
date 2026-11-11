import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invariantViolations } from '../test/invariants.js';
import { realCandles } from '../test/real-data.js';
import { SmcEngine } from './engine.js';
import { runEngine, toSteps } from './harness.js';
import { CRYPTO_MAJORS_SMC_PARAMS, GOLD_SMC_PARAMS } from './params.js';
import type { SmcEvent, StepInput } from './types.js';

/**
 * The engine on 34 days of real Binance candles (5m, aggregated to 15m–1d): every rule fires, the
 * §13 invariants hold, a checkpoint taken anywhere continues exactly, and a step stays far inside
 * the 2 ms budget (criterion 4.6; the CI runner is the reference).
 */
const BTC = { params: CRYPTO_MAJORS_SMC_PARAMS, tick: '0.01' };
const steps = toSteps(realCandles('BTCUSDT-5m.json.gz'));
const full = runEngine(new SmcEngine(BTC), steps).events;

const kinds = (events: readonly SmcEvent[]) => {
  const seen = new Set<string>();
  for (const e of events) {
    seen.add(e.type);
    if (e.type === 'structure') seen.add(`structure:${e.data.type}`);
    if (e.type === 'level_created') seen.add(`level:${e.data.type}`);
    if (e.type === 'sweep') seen.add(`sweep:${e.data.kind}`);
    if (e.type === 'level_status') seen.add(`status:${e.data.reason}`);
  }
  return seen;
};

describe('the engine on 34 days of BTCUSDT', () => {
  it('detects every Phase 4 concept that needs no 1m data or closures', () => {
    const seen = kinds(full);
    for (const k of [
      'swing_confirmed',
      'structure:bos',
      'structure:choch',
      'structure:mss',
      'range_detected',
      'range_ended',
      'level:eqh',
      'level:eql',
      'level:pdh',
      'level:pwl',
      'level:pmh',
      'level:session_high',
      'level:range_low',
      'level:swing_high',
      'level:sweep_extreme',
      'sweep:wick',
      'sweep:false_breakout',
      'status:swept',
      'status:broken',
      'status:expired',
      'status:touch',
      'status:range_ended',
    ])
      expect(seen, k).toContain(k);
  });

  it('keeps the rulebook §13 invariants', () => {
    expect(invariantViolations(full, BTC.tick)).toEqual([]);
  });

  it('continues from a checkpoint exactly as an uninterrupted run', () => {
    for (const cut of [1, 47, 288, 2017, 5555, 9001]) {
      const first = new SmcEngine(BTC);
      const before = runEngine(first, steps.slice(0, cut)).events;
      const json = JSON.stringify(first.snapshot());
      expect(gzipSync(json).length).toBeLessThan(200_000);
      const after = runEngine(SmcEngine.restore(JSON.parse(json), BTC), steps.slice(cut)).events;
      expect([...before, ...after]).toEqual(full);
    }
  });

  it('emits for a prefix exactly what the whole run emits for it (no repainting)', () => {
    for (const cut of [10, 500, 3000, 7777]) {
      const prefix = runEngine(new SmcEngine(BTC), steps.slice(0, cut)).events;
      const last = steps[cut - 1]!.time;
      expect(prefix).toEqual(full.filter((e) => e.time <= last));
    }
  });

  it('refuses a checkpoint taken with other settings', () => {
    const snapshot = new SmcEngine(BTC).snapshot();
    expect(() => SmcEngine.restore(snapshot, { ...BTC, tick: '0.1' })).toThrow(/other rules/);
    expect(() => SmcEngine.restore(snapshot, { params: GOLD_SMC_PARAMS, tick: '0.01' })).toThrow(
      /other rules/,
    );
    expect(() => SmcEngine.restore({ ...snapshot, v: 2 as 1 }, BTC)).toThrow(/format/);
  });

  it('steps in well under 2 ms at the 95th percentile', () => {
    const engine = new SmcEngine(BTC);
    const times: number[] = [];
    for (const s of steps) {
      const t0 = performance.now();
      engine.step(s);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(2);
  });

  it('gives the same events for PAXG with the gold profile twice over', () => {
    const gold = { params: GOLD_SMC_PARAMS, tick: '0.01' };
    const paxg: StepInput[] = toSteps(realCandles('PAXGUSDT-5m.json.gz', 4000));
    const a = runEngine(new SmcEngine(gold), paxg).events;
    expect(runEngine(new SmcEngine(gold), paxg).events).toEqual(a);
    expect(invariantViolations(a, gold.tick)).toEqual([]);
    expect(a.length).toBeGreaterThan(100);
  });
});
