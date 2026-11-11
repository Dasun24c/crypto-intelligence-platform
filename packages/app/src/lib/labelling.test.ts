import { describe, expect, it } from 'vitest';
import type { ChartOverlay } from '@cip/contracts';
import { BTC_BINANCE, candle, PAXG_BINANCE, run } from '../test/fixtures.js';
import {
  buildFixture,
  candidatesFrom,
  candidatesOf,
  candlesOf,
  manualCandidate,
  parseFixture,
} from './labelling.js';

const T = Date.UTC(2026, 10, 10, 12, 0);
const M15 = 900_000;
const id = (n: number) => `019a6f00-0000-7000-8000-${String(n).padStart(12, '0')}`;

const overlay: ChartOverlay = {
  instrumentId: BTC_BINANCE.id,
  tf: '15m',
  run: run(),
  swings: [
    {
      id: id(1),
      tf: '15m',
      kind: 'high',
      level: 'internal',
      price: '105',
      candleTime: T,
      confirmedAt: T + 3 * M15,
      flags: [],
    },
    // Decided before the window: not offered.
    {
      id: id(2),
      tf: '15m',
      kind: 'low',
      level: 'internal',
      price: '99',
      candleTime: T - 10 * M15,
      confirmedAt: T - 7 * M15,
      flags: [],
    },
  ],
  structure: [
    {
      id: id(3),
      tf: '15m',
      level: 'external',
      type: 'bos',
      direction: 'bullish',
      brokenSwingId: id(1),
      breakPrice: '105',
      breakCandleTime: T + 5 * M15,
      isInitial: false,
      displacement: null,
      flags: [],
    },
  ],
  ranges: [
    {
      id: id(4),
      tf: '15m',
      high: '106',
      low: '100',
      equilibrium: '103',
      windowStart: T - 48 * M15,
      detectedAt: T + M15,
      endedAt: T + 6 * M15,
      endReason: 'breakout_up',
      flags: [],
    },
  ],
  levels: [
    {
      id: id(5),
      tf: '1h',
      type: 'pdh',
      side: 'buy_side',
      price: '107',
      touches: 1,
      sessionName: null,
      location: 'none',
      knownAt: T + 4 * M15,
      status: 'active',
      statusChangedAt: null,
      sweepCount: 0,
      flags: [],
    },
  ],
  sweeps: [
    {
      id: id(6),
      tf: '15m',
      levelId: id(5),
      levelType: 'pdh',
      groupId: id(7),
      kind: 'wick',
      side: 'buy_side',
      levelPrice: '107',
      extremePrice: '107.4',
      penetrationAtr: 0.3,
      breachAt: T + 7 * M15,
      confirmedAt: T + 8 * M15,
      notionalBeyondUsd: null,
      flags: [],
    },
  ],
  zones: [],
  setups: [],
  closures: [],
};

describe('fixture labelling', () => {
  it("offers the platform's detections decided inside the window, in time order", () => {
    const c = candidatesFrom(overlay, T, T + 20 * M15);
    expect(c.map((x) => x.expectation.type)).toEqual([
      'range_detected',
      'swing_confirmed',
      'level_created',
      'structure',
      'range_ended',
      'sweep',
    ]);
    const bos = c.find((x) => x.expectation.type === 'structure')!;
    expect(bos.expectation).toEqual({
      type: 'structure',
      tf: '15m',
      at: new Date(T + 6 * M15).toISOString(),
      data: { level: 'external', type: 'bos', direction: 'bullish', breakPrice: '105' },
    });
    expect(c.find((x) => x.expectation.type === 'level_created')!.expectation.tf).toBe('1h');
  });

  it('adds a missed detection at a candle: a swing by its candle, others at its close', () => {
    expect(manualCandidate('swing low (external)', '15m', T, 1).expectation).toEqual({
      type: 'swing_confirmed',
      tf: '15m',
      data: { kind: 'low', level: 'external', candleTime: new Date(T).toISOString() },
    });
    const mss = manualCandidate('MSS bearish', '15m', T, 2);
    expect(mss).toMatchObject({ id: 'manual-2', at: T + M15, manual: true });
    expect(mss.expectation).toMatchObject({
      at: new Date(T + M15).toISOString(),
      data: { type: 'mss', direction: 'bearish' },
    });
  });

  it('writes the rulebook §12 file from the labels, and reads it back for review', () => {
    const candidates = candidatesFrom(overlay, T, T + 20 * M15);
    const verdicts = {
      [candidates[0]!.id]: 'expected' as const,
      [candidates[5]!.id]: 'not_expected' as const,
    };
    const candles = [candle(T, '100'), candle(T + M15, '101', { h: '101.5' })];
    const file = buildFixture({
      meta: {
        id: 'sweep-paxg-001',
        concept: 'sweeps',
        class: 'negative',
        description: 'd',
        labelledBy: 'Ann',
        reviewedBy: null,
      },
      instrument: { ...PAXG_BINANCE, profile: { name: 'gold', version: 2 } },
      tf: '15m',
      candles,
      closures: [{ from: T, to: T + H, reason: 'weekend' }],
      candidates,
      verdicts,
    });
    expect(file).toMatchObject({
      profile: 'gold',
      tick: '0.01',
      source: `recorded:binance:PAXGUSDT:${new Date(T).toISOString()}/${new Date(T + 2 * M15).toISOString()}`,
      candles: {
        '15m': [
          [T, '100', '100', '100', '100', '12.5'],
          [T + M15, '101', '101.5', '101', '101', '12.5'],
        ],
      },
      context: {
        closures: [{ from: new Date(T).toISOString(), to: new Date(T + H).toISOString(), reason: 'weekend' }],
      },
      expected: [candidates[0]!.expectation],
      notExpected: [candidates[5]!.expectation],
      labelledBy: 'Ann',
      reviewedBy: null,
    });
    expect(buildFixture({ ...argsFor(file), instrument: BTC_BINANCE }).profile).toBe('crypto-majors');

    const parsed = parseFixture(JSON.stringify(file));
    if ('error' in parsed) throw new Error(parsed.error);
    const back = candidatesOf(parsed.fixture);
    expect(Object.values(back.verdicts).sort()).toEqual(['expected', 'not_expected']);
    expect(candlesOf(parsed.fixture as never, '15m').map((c) => c.h)).toEqual(['100', '101.5']);
    expect(parseFixture('{')).toEqual({ error: 'The file is not JSON.' });
    expect(parseFixture('{"id": 1}')).toMatchObject({ error: expect.stringContaining('Not a fixture') });
    expect(() => buildFixture({ ...argsFor(file), candles: [] })).toThrow(/no candles/);
  });
});

const H = 3_600_000;
function argsFor(file: { id: string }) {
  return {
    meta: {
      id: file.id,
      concept: 'sweeps' as const,
      class: 'bullish' as const,
      description: 'd',
      labelledBy: 'Ann',
      reviewedBy: null,
    },
    instrument: BTC_BINANCE,
    tf: '15m' as const,
    candles: [candle(T, '100')],
    closures: [],
    candidates: [],
    verdicts: {},
  };
}
