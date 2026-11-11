import { describe, expect, it } from 'vitest';
import { canonicalJson, digestLine, storedPayload } from './canonical.js';
import { SmcEngine, volumeBeyond } from './engine.js';
import { aggregate, overlapsClosure, toSteps } from './harness.js';
import { homeTimeframe, weekendIntervals } from './levels.js';
import {
  CRYPTO_MAJORS_SMC_PARAMS,
  GOLD_SMC_PARAMS,
  ruleTimeframes,
  sessionHours,
  type SmcParams,
  validateSmcParams,
} from './params.js';
import { fromUnits, midpoint, toUnits, unitsToNumber } from './price.js';
import { Ring } from './ring.js';
import type { EngineCandle, SmcEvent } from './types.js';

describe('prices in units of 10⁻⁸', () => {
  it('parses decimals exactly', () => {
    expect(toUnits('60321.5')).toBe(6_032_150_000_000);
    expect(toUnits('0.00000001')).toBe(1);
    expect(toUnits('7')).toBe(700_000_000);
    expect(toUnits('.5')).toBe(50_000_000);
    expect(toUnits('-1.25')).toBe(-125_000_000);
    expect(toUnits('-0')).toBe(0);
  });

  it('rounds a ninth decimal half up', () => {
    expect(toUnits('1.000000004')).toBe(100_000_000);
    expect(toUnits('1.000000005')).toBe(100_000_001);
    expect(toUnits('2.50000000000')).toBe(250_000_000);
  });

  it('refuses what is not a price', () => {
    for (const bad of ['', '.', 'abc', '1e5', '1.2.3', '--1'])
      expect(() => toUnits(bad)).toThrow(/not a decimal/);
    expect(() => toUnits('99999999999')).toThrow(/out of range/);
  });

  it('formats the shortest exact decimal', () => {
    expect(fromUnits(6_032_150_000_000)).toBe('60321.5');
    expect(fromUnits(700_000_000)).toBe('7');
    expect(fromUnits(1)).toBe('0.00000001');
    expect(fromUnits(-125_000_000)).toBe('-1.25');
    expect(() => fromUnits(0.5)).toThrow(/whole number/);
    expect(unitsToNumber(9_550_000_000)).toBe(95.5);
  });

  it('gives exact midpoints, with a ninth decimal when needed', () => {
    expect(midpoint(toUnits('101.2'), toUnits('99.5'))).toBe('100.35');
    expect(midpoint(1, 2)).toBe('0.000000015');
    expect(midpoint(-1, -2)).toBe('-0.000000015');
    expect(midpoint(toUnits('100'), toUnits('100.00000001'))).toBe('100.000000005');
    expect(() => midpoint(Number.MAX_SAFE_INTEGER, 1)).toThrow(/range/);
  });
});

describe('canonical events', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: null, c: true }], e: 'x', u: undefined })).toBe(
      '{"a":[3,{"c":true,"d":null}],"b":1,"e":"x"}',
    );
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1)).toBe('0.1');
  });

  it('refuses what JSON cannot hold exactly', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/finite/);
    expect(() => canonicalJson(() => 1)).toThrow(/serialise/);
    expect(() => canonicalJson(undefined)).toThrow(/serialise/);
  });

  it('writes one digest line per event, independent of key order', () => {
    const e = {
      seq: 7,
      type: 'gap_marker',
      tf: '5m',
      time: 1_000,
      key: 'gm:5m:700',
      data: { from: 700, droppedBreaches: [], endedRange: null },
    } as unknown as SmcEvent;
    expect(digestLine(e)).toBe(
      '7|gap_marker|5m|1000|gm:5m:700|{"droppedBreaches":[],"endedRange":null,"from":700}\n',
    );
    expect(storedPayload(e)).toEqual({ key: 'gm:5m:700', data: e.data });
  });
});

const params = (patch: (p: SmcParams) => void): SmcParams => {
  const p = JSON.parse(JSON.stringify(CRYPTO_MAJORS_SMC_PARAMS)) as SmcParams;
  patch(p);
  return p;
};

describe('parameters', () => {
  it('accepts both launch profiles', () => {
    expect(() => validateSmcParams(CRYPTO_MAJORS_SMC_PARAMS)).not.toThrow();
    expect(() => validateSmcParams(GOLD_SMC_PARAMS)).not.toThrow();
    expect(GOLD_SMC_PARAMS.equalLevels.tolAtr).toBe(0.15);
    expect(GOLD_SMC_PARAMS.thinBook.notionalUsd).toBe(20_000);
    expect(Object.isFrozen(CRYPTO_MAJORS_SMC_PARAMS.sweeps)).toBe(true);
  });

  it('names the first invalid setting', () => {
    const cases: [(p: SmcParams) => void, RegExp][] = [
      [(p) => (p.atrPeriod = 1), /atrPeriod/],
      [(p) => (p.structureTimeframes = ['2m' as never]), /structureTimeframes/],
      [(p) => (p.timeframePairs = []), /at least one/],
      [(p) => (p.timeframePairs = [{ context: '5m', setup: '15m' }]), /longer than setup/],
      [(p) => (p.timeframePairs = [{ context: '4h', setup: 'x' as never }]), /hold timeframes/],
      [(p) => (p.swings.externalOrder = 1), /externalOrder must be at least/],
      [(p) => (p.structure.breakBufferAtr = -1), /breakBufferAtr/],
      [(p) => (p.displacement.candleBodyRatio = 1.5), /candleBodyRatio/],
      [(p) => (p.displacement.candleBodyAtr = 0), /candleBodyAtr/],
      [(p) => (p.displacement.legMaxCandles = 1), /legMaxCandles/],
      [(p) => (p.ranges.lookback = 1000), /lookback must be at most/],
      [(p) => (p.equalLevels.maxGap = 600), /maxGap must be at most/],
      [(p) => (p.equalLevels.tolAtr = Number.NaN), /tolAtr/],
      [(p) => (p.swings.externalOrder = p.swings.internalOrder = 300), /swing windows/],
      [(p) => (p.sessions = [{ name: 'tokyo' as never, start: '00:00', end: '07:00' }]), /unknown session/],
      [(p) => (p.sessions = [...p.sessions, p.sessions[0]!]), /listed twice/],
      [(p) => (p.sessions = [{ name: 'asia', start: '07:30', end: '09:00' }]), /whole UTC hour/],
      [(p) => (p.sessions = [{ name: 'asia', start: '09:00', end: '07:00' }]), /end after it starts/],
      [
        (p) =>
          (p.sessions = [
            { name: 'asia', start: '00:00', end: '07:00' },
            { name: 'london', start: '03:00', end: '07:00' },
          ]),
        /same hour/,
      ],
      [(p) => (p.expiry.swingCandles = 0), /expiry.swingCandles/],
    ];
    for (const [patch, message] of cases) expect(() => validateSmcParams(params(patch))).toThrow(message);
  });

  it('derives the timeframes each rule runs on', () => {
    const r = ruleTimeframes(CRYPTO_MAJORS_SMC_PARAMS);
    expect([...r.ranges].sort()).toEqual(['15m', '5m']);
    expect([...r.sweeps].sort()).toEqual(['15m', '1h', '4h', '5m']);
    expect(r.structure.has('1m')).toBe(false);
    expect(sessionHours({ name: 'new_york', start: '13:00', end: '21:00' })).toEqual({ start: 13, end: 21 });
    expect(homeTimeframe('1d', r.sweeps)).toBe('4h');
    expect(homeTimeframe('5m', r.sweeps)).toBe('5m');
    expect(homeTimeframe('1m', r.sweeps)).toBeNull();
  });
});

describe('ring', () => {
  it('keeps the last items by their sequence index', () => {
    const r = new Ring<number>(3);
    for (let i = 0; i < 5; i++) r.push(i * 10);
    expect([r.first, r.next, r.get(1), r.get(2), r.get(4), r.get(5)]).toEqual([
      2,
      5,
      undefined,
      20,
      40,
      undefined,
    ]);
    expect(r.holds(2, 4)).toBe(true);
    expect(r.holds(1, 4)).toBe(false);
    expect(r.holds(4, 3)).toBe(false);
    const back = Ring.restore(r.snapshot());
    expect([back.first, back.next, back.get(3)]).toEqual([2, 5, 30]);
  });

  it('refuses a bad capacity or an overfull state', () => {
    expect(() => new Ring(0)).toThrow(/capacity/);
    expect(() => Ring.restore({ capacity: 1, start: 0, items: [1, 2] })).toThrow(/more than its capacity/);
  });
});

const candle = (
  tf: EngineCandle['tf'],
  openTime: number,
  o = '100',
  h = '101',
  l = '99',
  c = '100',
): EngineCandle => ({
  tf,
  openTime,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: '1',
  quality: 'complete',
  underlyingClosed: false,
});
const T0 = Date.UTC(2026, 0, 5);
const BTC = { params: CRYPTO_MAJORS_SMC_PARAMS, tick: '0.01' };

describe('engine input', () => {
  it('refuses boundaries that are not whole minutes or do not increase', () => {
    const e = new SmcEngine(BTC);
    expect(() => e.step({ time: T0 + 1, candles: [] })).toThrow(/whole minute/);
    e.step({ time: T0 + 60_000, candles: [candle('1m', T0)] });
    expect(() => e.step({ time: T0 + 60_000, candles: [] })).toThrow(/must increase/);
  });

  it('refuses candles that do not belong to the boundary', () => {
    const e = new SmcEngine(BTC);
    expect(() => e.step({ time: T0 + 300_000, candles: [candle('5m', T0 + 60_000)] })).toThrow(
      /does not close/,
    );
    expect(() => e.step({ time: T0 + 300_000, candles: [candle('5m', T0), candle('5m', T0)] })).toThrow(
      /two 5m/,
    );
    expect(() =>
      e.step({ time: T0 + 300_000, candles: [{ ...candle('5m', T0), tf: '2m' as never }] }),
    ).toThrow(/unknown/);
    expect(() => e.step({ time: T0 + 300_000, candles: [candle('5m', T0)], missing: ['5m'] })).toThrow(
      /both given and missing/,
    );
    expect(() => e.step({ time: T0 + 60_000, candles: [], missing: ['5m'] })).toThrow(/no 5m candle/);
    expect(() =>
      e.step({ time: T0 + 300_000, candles: [candle('5m', T0, '100', '99', '98', '100')] }),
    ).toThrow(/inconsistent/);
  });

  it('requires every started timeframe at each of its boundaries, consecutively', () => {
    const e = new SmcEngine(BTC);
    e.step({ time: T0 + 300_000, candles: [candle('5m', T0)] });
    expect(() => e.step({ time: T0 + 600_000, candles: [] })).toThrow(/absent/);
    const f = new SmcEngine(BTC);
    f.step({ time: T0 + 60_000, candles: [candle('1m', T0)] });
    expect(() => f.step({ time: T0 + 180_000, candles: [candle('1m', T0 + 120_000)] })).toThrow(
      /consecutive|absent/,
    );
  });

  it('takes missing candles and partial ones as gaps', () => {
    const e = new SmcEngine(BTC);
    e.step({ time: T0 + 300_000, candles: [candle('5m', T0)] });
    const gap = e.step({ time: T0 + 600_000, candles: [], missing: ['5m'] });
    expect(gap.map((x) => x.type)).toEqual(['gap_marker']);
    expect(
      e.step({ time: T0 + 900_000, candles: [{ ...candle('5m', T0 + 600_000), quality: 'partial' }] }),
    ).toEqual([]);
    expect(e.lastTime).toBe(T0 + 900_000);
    expect(e.lastSeq).toBe(1);
    expect(e.trend('5m', 'internal')).toBe('undefined');
    expect(e.trend('1m', 'external')).toBeNull();
    expect(e.activeLevels()).toEqual([]);
  });

  it('refuses a tick that is not positive', () => {
    expect(() => new SmcEngine({ ...BTC, tick: '0' })).toThrow(/tick/);
  });
});

describe('volume beyond a level (rulebook §3.5)', () => {
  const p = [1, 2, 3, 4];
  it('counts whole buckets beyond the level and the one containing it pro rata', () => {
    // Buckets of 25 units from 1000: [1000,1025) … [1075,1100]; the level 1050 splits nothing.
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1050, true)).toBe(7);
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1050, false)).toBe(3);
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1060, true)).toBeCloseTo(3 * 0.6 + 4, 10);
  });

  it('takes everything or nothing when the level is outside the candle', () => {
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 900, true)).toBe(10);
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1100, true)).toBe(0);
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1200, false)).toBe(10);
    expect(volumeBeyond({ l: 1000, h: 1100, p }, 1000, false)).toBe(0);
  });

  it('puts a one-price minute wholly on one side', () => {
    expect(volumeBeyond({ l: 1000, h: 1000, p }, 999, true)).toBe(10);
    expect(volumeBeyond({ l: 1000, h: 1000, p }, 1000, true)).toBe(0);
    expect(volumeBeyond({ l: 1000, h: 1000, p }, 1001, false)).toBe(10);
  });
});

describe('harness', () => {
  it('turns holes into missing candles and checks order and alignment', () => {
    const steps = toSteps({ '5m': [candle('5m', T0), candle('5m', T0 + 600_000)] });
    expect(steps.map((s) => [s.time - T0, s.missing])).toEqual([
      [300_000, []],
      [600_000, ['5m']],
      [900_000, []],
    ]);
    expect(() => toSteps({ '5m': [candle('5m', T0 + 1)] })).toThrow(/aligned/);
    expect(() => toSteps({ '5m': [candle('5m', T0 + 300_000), candle('5m', T0)] })).toThrow(/order/);
    expect(() => toSteps({ '5m': [candle('1h', T0)] })).toThrow(/listed under/);
  });

  it('aggregates as the platform does, and flags closures', () => {
    const fives = [candle('5m', T0), candle('5m', T0 + 300_000, '100', '103', '98', '102')];
    const [quarter] = aggregate(fives, '15m');
    expect(quarter).toMatchObject({
      open: '100',
      high: '103',
      low: '98',
      close: '102',
      quality: 'partial',
      volume: '2',
    });
    expect(() => aggregate(fives, '5m')).toThrow(/cannot build/);
    const closures = [{ startsAt: T0 + 120_000, endsAt: T0 + 180_000, reason: 'daily_break' as const }];
    expect(overlapsClosure(T0, '5m', closures)).toBe(true);
    expect(overlapsClosure(T0 + 300_000, '5m', closures)).toBe(false);
    expect(weekendIntervals(closures)).toEqual([]);
  });
});
