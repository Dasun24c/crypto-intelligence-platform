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
const hour = z.string().regex(/^\d\d:00$/, 'a whole UTC hour, "HH:00"');

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
});
export type SmcParamsDto = z.infer<typeof SmcParamsSchema>;
