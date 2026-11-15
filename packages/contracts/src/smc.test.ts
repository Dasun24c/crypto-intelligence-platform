import { describe, expect, it } from 'vitest';
import { CHANNEL_PATTERN, channels, isDurableChannel } from './market.js';
import {
  LevelsQuerySchema,
  PoiZoneSchema,
  ReplayRequestSchema,
  SETUP_DISCLAIMER,
  SETUP_LABELS,
  SetupDetailSchema,
  SetupsQuerySchema,
  SetupSummarySchema,
  SetupTransitionMessageSchema,
  SmcQuerySchema,
  SwingsQuerySchema,
  ZonesQuerySchema,
} from './smc.js';
import { SmcParamsSchema } from './smc-params.js';

const ID = '019a6f00-0000-7000-8000-000000000101';

/** The crypto-majors defaults (rulebook §10), as migration 0008 stores them (profile version 3). */
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
  orderBlocks: { lookback: 5, maxClusterCandles: 3, breakWithinBars: 10, zoneMode: 'wick' },
  fvg: { minSizeAtr: 0.2 },
  supplyDemand: { baseMaxCandles: 4, baseBodyAtr: 0.5, departureAtr: 2 },
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
    fvgCandles: 200,
    orderBlockCandles: 300,
    supplyDemandCandles: 300,
  },
  setups: {
    patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
    mss: { maxBars: 12, maxDistanceAtr: 6, requireDisplacement: true },
    levels: { slBufferAtr: 0.1, targetMinDistanceAtr: 1, entryRef: 'proximal' },
    timing: { entryExpiryBars: 24, maxHoldBars: 288 },
    pattern1: { minBarsBetweenSweeps: 5, maxBarsBetweenSweeps: 60, rangeEdgeTolAtr: 0.5 },
    pattern2: { proximityAtr: 1, maxPoiFill: 0.5 },
    pattern3: { approachAtr: 2, liqProximityAtr: 1, sweepWindowBars: 12, maxObFill: 0.5 },
    pattern4: { maxTargetFvgFill: 0.5 },
    checklist: {
      minRR: 2,
      newsBlackoutMin: { before: 30, after: 30 },
      newsCurrencies: ['USD'],
      weights: {
        htf_bias: 15,
        liquidity_marked: 10,
        poi_present: 15,
        sweep: 15,
        mss: 20,
        levels_defined: 5,
        risk_reward: 15,
        news_clear: 5,
      },
      mandatory: ['sweep', 'mss', 'levels_defined'],
    },
    quality: {
      lowLiqVolumeRatio: 0.3,
      maxSpreadBps: 5,
      lateThresholdSec: 120,
      blockConfirmWhenUnderlyingClosed: false,
      blockConfirmOnLowLiquidity: false,
    },
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
      { ...SMC_DEFAULTS, orderBlocks: { ...SMC_DEFAULTS.orderBlocks, zoneMode: 'mid' } },
      // A version 2 profile (Phase 4) has no zone settings, a version 3 one (Phase 5) no setups.
      (({ orderBlocks: _o, supplyDemand: _s, ...v2 }) => v2)(SMC_DEFAULTS),
      (({ setups: _s, ...v3 }) => v3)(SMC_DEFAULTS),
      { ...SMC_DEFAULTS, setups: { ...SMC_DEFAULTS.setups, patterns: ['head_and_shoulders'] } },
      { ...SMC_DEFAULTS, setups: { ...SMC_DEFAULTS.setups, pattern2: { proximityAtr: 1, maxPoiFill: 1.5 } } },
    ])
      expect(SmcParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('describe points of interest and their queries', () => {
    const zone = {
      id: ID,
      tf: '1h',
      type: 'order_block',
      direction: 'bearish',
      top: '108.5',
      bottom: '106',
      originFrom: 1_000,
      originTo: 2_000,
      knownAt: 3_000,
      htf: true,
      location: 'none',
      status: 'partially_filled',
      fillPct: 37.5,
      firstTouchAt: 4_000,
      statusChangedAt: 4_000,
      structureEventId: ID,
      linkedZoneId: null,
      sweptLiquidityAtOrigin: false,
      flags: [],
    };
    expect(PoiZoneSchema.parse(zone)).toEqual(zone);
    expect(PoiZoneSchema.safeParse({ ...zone, type: 'breaker' }).success).toBe(false);
    expect(
      ZonesQuerySchema.parse({ tf: '15m', types: 'fvg,order_block', status: 'untouched' }),
    ).toMatchObject({
      types: ['fvg', 'order_block'],
      status: ['untouched'],
      limit: 1000,
    });
    expect(ZonesQuerySchema.safeParse({ tf: '15m', status: 'swept' }).success).toBe(false);
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

  it('describe setups, their queries and their channels (Phase 6)', () => {
    const summary = {
      id: ID,
      instrumentId: ID,
      runId: ID,
      pattern: 'double_liquidity_trap',
      variant: 'A',
      direction: 'bearish',
      contextTf: '1h',
      setupTf: '5m',
      state: 'confirmed',
      resolution: null,
      displayLabel: SETUP_LABELS.confirmed,
      levels: { entry: '98.2', invalidation: '102.48', target1: '96', target2: null, rr: 0.514 },
      score: 62.5,
      mandatoryPassed: true,
      qualityFlags: ['liquidity_unverified'],
      flags: [],
      createdAt: 1_000,
      updatedAt: 2_000,
      resolvedAt: null,
      disclaimer: SETUP_DISCLAIMER,
    };
    expect(SetupSummarySchema.parse(summary)).toEqual(summary);
    expect(SetupSummarySchema.safeParse({ ...summary, disclaimer: 'trade this' }).success).toBe(false);
    expect(SetupSummarySchema.safeParse({ ...summary, resolution: 'cancelled' }).success).toBe(false);
    const transition = {
      from: 'triggered',
      to: 'confirmed',
      reason: 'mss_confirmed',
      candleTime: 1_700,
      decidedAt: 2_000,
      processedAt: 2_050,
      late: false,
      evidence: {},
    };
    expect(SetupTransitionMessageSchema.parse({ ...summary, transition }).transition).toEqual(transition);
    const detail = SetupDetailSchema.parse({
      ...summary,
      transitions: [transition],
      checklist: [{ item: 'sweep', credit: 1, weight: 15, mandatory: true, evidence: {} }],
      checklistByState: {
        confirmed: [{ item: 'sweep', credit: 1, weight: 15, mandatory: true, evidence: {} }],
      },
      outcome: null,
      targets: { target1: { kind: 'level', id: ID, price: '96' }, target2: null },
      refs: { sweeps: [], mss: null, entryZone: null, levels: [], range: null, poi: null },
    });
    expect(detail.checklist[0]!.credit).toBe(1);
    expect(
      SetupDetailSchema.safeParse({ ...detail, checklist: [{ ...detail.checklist[0], credit: 0.3 }] })
        .success,
    ).toBe(false);

    expect(
      SetupsQuerySchema.parse({ pattern: 'eq_near_poi,htf_order_block', state: 'confirmed', minScore: '60' }),
    ).toEqual({
      pattern: ['eq_near_poi', 'htf_order_block'],
      state: ['confirmed'],
      minScore: 60,
      limit: 100,
    });
    expect(SetupsQuerySchema.safeParse({ pattern: 'head_and_shoulders' }).success).toBe(false);
    expect(SetupsQuerySchema.safeParse({ minScore: '101' }).success).toBe(false);

    expect(channels.setups()).toBe('setups');
    expect(channels.setups(ID)).toBe(`setups:${ID}`);
    for (const ch of ['setups', `setups:${ID}`]) {
      expect(CHANNEL_PATTERN.test(ch)).toBe(true);
      expect(isDurableChannel(ch)).toBe(true);
    }
    expect(CHANNEL_PATTERN.test('setups:nope')).toBe(false);
  });
});
