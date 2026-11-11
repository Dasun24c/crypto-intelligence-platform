import { describe, expect, it } from 'vitest';
import {
  analysisStatusKey,
  IndicatorParamsSchema,
  IndicatorPointSchema,
  IndicatorsClosedEventSchema,
  IndicatorsQuerySchema,
  ProfileParamsSchema,
  RunsQuerySchema,
  SystemHealthSchema,
} from './index.js';

const ID = '019a6f00-0000-7000-8000-000000000001';
const DEFAULTS = {
  rsi: { period: 14 },
  macd: { fast: 12, slow: 26, signal: 9 },
  ema: { fast: 20, mid: 50, slow: 200 },
  atr: { period: 14 },
  volume: { lookback: 50, zThreshold: 3.5 },
  trend: { slopeBars: 5, minStrength: 0.1 },
};

describe('analysis contracts', () => {
  it('validates indicator settings as the indicators package does', () => {
    expect(IndicatorParamsSchema.parse(DEFAULTS)).toEqual(DEFAULTS);
    const bad = [
      { ...DEFAULTS, rsi: { period: 1 } },
      { ...DEFAULTS, macd: { fast: 26, slow: 12, signal: 9 } },
      { ...DEFAULTS, ema: { fast: 50, mid: 20, slow: 200 } },
      { ...DEFAULTS, volume: { lookback: 50, zThreshold: 0 } },
      { ...DEFAULTS, trend: { slopeBars: 0, minStrength: 0.1 } },
      { ...DEFAULTS, extra: true },
    ];
    for (const params of bad) expect(IndicatorParamsSchema.safeParse(params).success).toBe(false);
    // A profile may carry other settings beside the indicators (later phases).
    expect(ProfileParamsSchema.parse({ indicators: DEFAULTS, smc: { swingLength: 3 } }).indicators).toEqual(
      DEFAULTS,
    );
  });

  it('describes indicator points, their live message and queries', () => {
    const point = {
      t: 1_794_300_000_000,
      rsi: 55.1,
      macd: -1.5,
      macdSignal: -1,
      macdHist: -0.5,
      emaFast: 100,
      emaMid: 99,
      emaSlow: null,
      vwap: null,
      atr: 2,
      volumeZ: 4.2,
      volumeAnomaly: true,
      trend: null,
      trendStrength: null,
      warmup: false,
    };
    expect(IndicatorPointSchema.parse(point)).toEqual(point);
    expect(IndicatorPointSchema.safeParse({ ...point, trend: 'up' }).success).toBe(false);
    expect(IndicatorsClosedEventSchema.parse({ instrumentId: ID, tf: '1h', runId: ID, point }).point).toEqual(
      point,
    );
    expect(IndicatorsQuerySchema.parse({ tf: '5m', from: '1794300000000' })).toEqual({
      tf: '5m',
      from: 1_794_300_000_000,
      limit: 1_000,
    });
    expect(IndicatorsQuerySchema.safeParse({ tf: '5m', limit: '5001' }).success).toBe(false);
    expect(RunsQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(analysisStatusKey(ID)).toBe(`analysis:status:${ID}`);
  });

  it('reports analysis state in system health', () => {
    const health = SystemHealthSchema.parse({
      status: 'ok',
      checkedAt: 1,
      dependencies: [],
      services: [],
      feeds: [],
      analysis: [
        {
          instrumentId: ID,
          runId: ID,
          status: 'running',
          lagSec: 0.4,
          paused: true,
          pauseReason: 'data_gap',
          detail: '5m: waiting for 12:05',
          updatedAt: 2,
        },
      ],
    });
    expect(health.analysis[0]?.pauseReason).toBe('data_gap');
  });
});
