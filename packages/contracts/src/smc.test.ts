import { describe, expect, it } from 'vitest';
import { CHANNEL_PATTERN, channels, isDurableChannel } from './market.js';
import { LevelsQuerySchema, ReplayRequestSchema, SmcQuerySchema, SwingsQuerySchema } from './smc.js';
import { SmcParamsSchema } from './smc-params.js';

const ID = '019a6f00-0000-7000-8000-000000000101';

/** The crypto-majors defaults (rulebook §10), as migration 0007 stores them. */
export const SMC_DEFAULTS = {
  atrPeriod: 14,
  structureTimeframes: ['5m', '15m', '1h', '4h', '1d'],
  timeframePairs: [
    { context: '4h', setup: '15m' },
    { context: '1h', setup: '5m' },
  ],
  swings: { internalOrder: 2, externalOrder: 5 },
  structure: { breakBufferAtr: 0 },
  displacement: {
    candleBodyAtr: 1.2,
    candleBodyRatio: 0.6,
    legMinCandles: 2,
    legMaxCandles: 4,
    legBodyAtr: 2,
    legCandleBodyRatio: 0.5,
  },
  fvg: { minSizeAtr: 0.2 },
  ranges: {
    lookback: 48,
    maxHeightAtr: 6,
    maxEfficiency: 0.3,
    touchTolAtr: 0.25,
    minTouches: 2,
    minTouchSeparation: 5,
    breakCloses: 2,
    breakBufferAtr: 0.25,
    maxAge: 300,
  },
  equalLevels: { tolAtr: 0.1, minGap: 5, maxGap: 200 },
  sweeps: { minPenetrationAtr: 0.02, maxPenetrationAtr: 2, closeBackBars: 3 },
  thinBook: { notionalUsd: 100000 },
  sessions: [
    { name: 'asia', start: '00:00', end: '07:00' },
    { name: 'london', start: '07:00', end: '13:00' },
    { name: 'new_york', start: '13:00', end: '21:00' },
  ],
  expiry: {
    sessionDays: 5,
    dayDays: 5,
    weekWeeks: 4,
    monthMonths: 3,
    weekendDays: 7,
    equalCandles: 500,
    swingCandles: 300,
    sweepExtremeCandles: 300,
  },
};

describe('SMC contracts', () => {
  it('accept the launch SMC settings and refuse malformed ones', () => {
    expect(SmcParamsSchema.parse(SMC_DEFAULTS)).toEqual(SMC_DEFAULTS);
    for (const bad of [
      { ...SMC_DEFAULTS, atrPeriod: 1 },
      { ...SMC_DEFAULTS, timeframePairs: [] },
      { ...SMC_DEFAULTS, displacement: { ...SMC_DEFAULTS.displacement, candleBodyRatio: 1.5 } },
      { ...SMC_DEFAULTS, sessions: [{ name: 'tokyo', start: '00:00', end: '07:00' }] },
      { ...SMC_DEFAULTS, sessions: [{ name: 'asia', start: '00:30', end: '07:00' }] },
      { ...SMC_DEFAULTS, extra: 1 },
    ])
      expect(SmcParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('parse the list queries', () => {
    expect(SmcQuerySchema.parse({ tf: '15m', from: '1000' })).toEqual({ tf: '15m', from: 1000, limit: 1000 });
    expect(SwingsQuerySchema.parse({ tf: '1h', level: 'external' }).level).toBe('external');
    expect(LevelsQuerySchema.parse({ tf: '1h', status: 'active,swept', types: 'eqh,pdh' })).toMatchObject({
      status: ['active', 'swept'],
      types: ['eqh', 'pdh'],
    });
    // A repeated parameter (`?status=active&status=swept`) arrives as an array.
    expect(LevelsQuerySchema.parse({ tf: '1h', status: ['active', 'swept'] }).status).toEqual([
      'active',
      'swept',
    ]);
    expect(LevelsQuerySchema.safeParse({ tf: '1h', status: '' }).success).toBe(false);
    expect(LevelsQuerySchema.safeParse({ tf: '1h', types: 'nope' }).success).toBe(false);
    expect(SmcQuerySchema.safeParse({ tf: '1h', other: 1 }).success).toBe(false);
  });

  it('bound replay requests', () => {
    expect(ReplayRequestSchema.safeParse({ instrumentId: ID, from: 0, to: 86_400_000 }).success).toBe(true);
    expect(ReplayRequestSchema.safeParse({ instrumentId: ID, from: 10, to: 10 }).success).toBe(false);
    expect(ReplayRequestSchema.safeParse({ instrumentId: ID, from: 0, to: 32 * 86_400_000 }).success).toBe(
      false,
    );
  });

  it('name the durable smc channel', () => {
    expect(channels.smc(ID)).toBe(`smc:${ID}`);
    expect(CHANNEL_PATTERN.test(`smc:${ID}`)).toBe(true);
    expect(CHANNEL_PATTERN.test(`smc:${ID}:5m`)).toBe(false);
    expect(isDurableChannel(`smc:${ID}`)).toBe(true);
  });
});
