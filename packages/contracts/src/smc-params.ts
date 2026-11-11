import { z } from 'zod';
import { TimeframeSchema } from './market.js';

/**
 * The `smc` part of an instrument profile (rulebook §10, the rules Phase 4 implements): the same
 * shape as `SmcParams` in packages/smc-engine, whose `validateSmcParams` checks the rules between
 * fields (for example that a context timeframe is longer than its setup timeframe).
 */
const count = (min: number) => z.number().int().min(min).max(100_000);
const positive = z.number().positive();
const atLeastZero = z.number().nonnegative();
const ratio = z.number().positive().max(1);
const fraction = z.number().min(0).max(1);
const hour = z.string().regex(/^\d\d:00$/, 'a whole UTC hour, "HH:00"');

/** Rulebook §6 patterns and §7 checklist items (the same lists as packages/smc-engine's). */
export const PATTERN_NAMES = [
  'double_liquidity_trap',
  'eq_near_poi',
  'htf_order_block',
  'sweep_outside_fill_inside',
] as const;
export const CHECKLIST_ITEM_NAMES = [
  'htf_bias',
  'liquidity_marked',
  'poi_present',
  'sweep',
  'mss',
  'levels_defined',
  'risk_reward',
  'news_clear',
] as const;
const PatternSchema = () => z.enum(PATTERN_NAMES);

export const SmcParamsSchema = z.strictObject({
  atrPeriod: count(2),
  structureTimeframes: z.array(TimeframeSchema),
  timeframePairs: z.array(z.strictObject({ context: TimeframeSchema, setup: TimeframeSchema })).min(1),
  swings: z.strictObject({ internalOrder: count(1), externalOrder: count(1) }),
  structure: z.strictObject({ breakBufferAtr: atLeastZero }),
  displacement: z.strictObject({
    candleBodyAtr: positive,
    candleBodyRatio: ratio,
    legMinCandles: count(2),
    legMaxCandles: count(2),
    legBodyAtr: positive,
    legCandleBodyRatio: ratio,
  }),
  orderBlocks: z.strictObject({
    lookback: count(1),
    maxClusterCandles: count(1),
    breakWithinBars: count(1),
    zoneMode: z.enum(['wick', 'body']),
  }),
  fvg: z.strictObject({ minSizeAtr: atLeastZero }),
  supplyDemand: z.strictObject({ baseMaxCandles: count(1), baseBodyAtr: positive, departureAtr: positive }),
  ranges: z.strictObject({
    lookback: count(3),
    maxHeightAtr: positive,
    maxEfficiency: ratio,
    touchTolAtr: atLeastZero,
    minTouches: count(1),
    minTouchSeparation: count(0),
    breakCloses: count(1),
    breakBufferAtr: atLeastZero,
    maxAge: count(1),
  }),
  equalLevels: z.strictObject({ tolAtr: atLeastZero, minGap: count(1), maxGap: count(1) }),
  sweeps: z.strictObject({
    minPenetrationAtr: atLeastZero,
    maxPenetrationAtr: positive,
    closeBackBars: count(0),
  }),
  thinBook: z.strictObject({ notionalUsd: atLeastZero }),
  sessions: z.array(z.strictObject({ name: z.enum(['asia', 'london', 'new_york']), start: hour, end: hour })),
  expiry: z.strictObject({
    sessionDays: count(1),
    dayDays: count(1),
    weekWeeks: count(1),
    monthMonths: count(1),
    weekendDays: count(1),
    equalCandles: count(1),
    swingCandles: count(1),
    sweepExtremeCandles: count(1),
    fvgCandles: count(1),
    orderBlockCandles: count(1),
    supplyDemandCandles: count(1),
  }),
  setups: z.strictObject({
    patterns: z.array(PatternSchema()),
    mss: z.strictObject({ maxBars: count(1), maxDistanceAtr: positive, requireDisplacement: z.boolean() }),
    levels: z.strictObject({
      slBufferAtr: atLeastZero,
      targetMinDistanceAtr: atLeastZero,
      entryRef: z.literal('proximal'),
    }),
    timing: z.strictObject({ entryExpiryBars: count(1), maxHoldBars: count(1) }),
    pattern1: z.strictObject({
      minBarsBetweenSweeps: count(1),
      maxBarsBetweenSweeps: count(1),
      rangeEdgeTolAtr: atLeastZero,
    }),
    pattern2: z.strictObject({ proximityAtr: positive, maxPoiFill: fraction }),
    pattern3: z.strictObject({
      approachAtr: positive,
      liqProximityAtr: atLeastZero,
      sweepWindowBars: count(0),
      maxObFill: fraction,
    }),
    pattern4: z.strictObject({ maxTargetFvgFill: fraction }),
    checklist: z.strictObject({
      minRR: positive,
      newsBlackoutMin: z.strictObject({ before: count(0), after: count(0) }),
      newsCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
      weights: z.strictObject(
        Object.fromEntries(CHECKLIST_ITEM_NAMES.map((k) => [k, count(0)])) as Record<
          (typeof CHECKLIST_ITEM_NAMES)[number],
          ReturnType<typeof count>
        >,
      ),
      mandatory: z.array(z.enum(CHECKLIST_ITEM_NAMES)),
    }),
    quality: z.strictObject({
      lowLiqVolumeRatio: positive,
      maxSpreadBps: positive,
      lateThresholdSec: count(1),
      blockConfirmWhenUnderlyingClosed: z.boolean(),
      blockConfirmOnLowLiquidity: z.boolean(),
    }),
  }),
});
export type SmcParamsDto = z.infer<typeof SmcParamsSchema>;
