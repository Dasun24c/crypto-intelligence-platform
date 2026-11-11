import { TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';

/**
 * The version of the rulebook this engine implements (docs/phase-0/07-smc-rulebook.md, v0.1).
 * Every detection carries it; changing a rule means a new version and a new run (ADR 004).
 */
/** 0.2.0: Phase 5 adds the points of interest (rulebook §4). */
export const RULESET_VERSION = '0.2.0';

export const SESSION_NAMES = ['asia', 'london', 'new_york'] as const;
export type SessionName = (typeof SESSION_NAMES)[number];

/** A trading session in UTC whole hours, [start, end). Its high and low become levels when it ends. */
export interface SessionWindow {
  name: SessionName;
  /** "HH:00", UTC. */
  start: string;
  end: string;
}

/**
 * The `smc` part of an instrument profile (rulebook §10, the rules Phase 4 implements). Thresholds
 * named `…Atr` are multiples of ATR(atrPeriod) on the same timeframe at the evaluated candle's close.
 */
export interface SmcParams {
  atrPeriod: number;
  /** Timeframes with swings, structure, equal highs/lows and swing levels. */
  structureTimeframes: Timeframe[];
  /**
   * The (context, setup) pairs of §5. Ranges are detected on the setup timeframes; sweeps are
   * evaluated on the setup and context timeframes.
   */
  timeframePairs: { context: Timeframe; setup: Timeframe }[];
  swings: { internalOrder: number; externalOrder: number };
  structure: { breakBufferAtr: number };
  displacement: {
    candleBodyAtr: number;
    candleBodyRatio: number;
    legMinCandles: number;
    legMaxCandles: number;
    legBodyAtr: number;
    legCandleBodyRatio: number;
  };
  /** §4.1 order blocks: the search back from the leg start, the cluster, and how soon the break must come. */
  orderBlocks: {
    lookback: number;
    maxClusterCandles: number;
    breakWithinBars: number;
    /** `wick`: the cluster's full range; `body`: its bodies only. */
    zoneMode: 'wick' | 'body';
  };
  /** §4.2 fair value gaps, and `createdFvg` on displacement (§2.3). */
  fvg: { minSizeAtr: number };
  /** §4.3 supply and demand zones: the base's candles and the departure's travel beyond it. */
  supplyDemand: { baseMaxCandles: number; baseBodyAtr: number; departureAtr: number };
  ranges: {
    lookback: number;
    maxHeightAtr: number;
    maxEfficiency: number;
    touchTolAtr: number;
    minTouches: number;
    minTouchSeparation: number;
    breakCloses: number;
    breakBufferAtr: number;
    maxAge: number;
  };
  equalLevels: { tolAtr: number; minGap: number; maxGap: number };
  sweeps: { minPenetrationAtr: number; maxPenetrationAtr: number; closeBackBars: number };
  thinBook: { notionalUsd: number };
  sessions: SessionWindow[];
  /**
   * Level lifetimes (§3.3). Candle counts are of the level's origin timeframe and are applied as
   * that many candle durations after the level became known. Weekend levels and sweep extremes
   * have no lifetime in the rulebook; these are the engine's (see the README).
   */
  expiry: {
    sessionDays: number;
    dayDays: number;
    weekWeeks: number;
    monthMonths: number;
    weekendDays: number;
    equalCandles: number;
    swingCandles: number;
    sweepExtremeCandles: number;
    /** §4.4 zone lifetimes, in candles of the zone's timeframe. */
    fvgCandles: number;
    orderBlockCandles: number;
    supplyDemandCandles: number;
  };
}

const base: SmcParams = {
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
    legBodyAtr: 2.0,
    legCandleBodyRatio: 0.5,
  },
  orderBlocks: { lookback: 5, maxClusterCandles: 3, breakWithinBars: 10, zoneMode: 'wick' },
  fvg: { minSizeAtr: 0.2 },
  supplyDemand: { baseMaxCandles: 4, baseBodyAtr: 0.5, departureAtr: 2.0 },
  ranges: {
    lookback: 48,
    maxHeightAtr: 6.0,
    maxEfficiency: 0.3,
    touchTolAtr: 0.25,
    minTouches: 2,
    minTouchSeparation: 5,
    breakCloses: 2,
    breakBufferAtr: 0.25,
    maxAge: 300,
  },
  equalLevels: { tolAtr: 0.1, minGap: 5, maxGap: 200 },
  sweeps: { minPenetrationAtr: 0.02, maxPenetrationAtr: 2.0, closeBackBars: 3 },
  thinBook: { notionalUsd: 100_000 },
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
};

const clone = (p: SmcParams): SmcParams => JSON.parse(JSON.stringify(p)) as SmcParams;

/** Rulebook §10, crypto majors (profile `crypto-majors`). */
export const CRYPTO_MAJORS_SMC_PARAMS: SmcParams = deepFreeze(clone(base));

/** Rulebook §10, gold (profile `gold`): wider equal-level tolerance, lower thin-book notional. */
export const GOLD_SMC_PARAMS: SmcParams = deepFreeze({
  ...clone(base),
  equalLevels: { tolAtr: 0.15, minGap: 5, maxGap: 200 },
  thinBook: { notionalUsd: 20_000 },
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const positive = (name: string, v: number) => {
  if (!(Number.isFinite(v) && v > 0)) throw new RangeError(`${name} must be a positive number`);
};
const nonNegative = (name: string, v: number) => {
  if (!(Number.isFinite(v) && v >= 0)) throw new RangeError(`${name} must be zero or more`);
};
const count = (name: string, v: number, min = 1) => {
  if (!(Number.isInteger(v) && v >= min && v <= 100_000))
    throw new RangeError(`${name} must be a whole number from ${min}`);
};
const ratio = (name: string, v: number) => {
  if (!(Number.isFinite(v) && v > 0 && v <= 1)) throw new RangeError(`${name} must be in (0, 1]`);
};
const isTf = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);

function hour(name: string, hhmm: string): number {
  const m = /^(\d\d):00$/.exec(hhmm);
  const h = m ? Number(m[1]) : NaN;
  if (!(h >= 0 && h <= 24)) throw new RangeError(`${name} must be a whole UTC hour, "HH:00"`);
  return h;
}

/** Session windows as whole hours; sessions are built from 1h candles. */
export function sessionHours(s: SessionWindow): { start: number; end: number } {
  return { start: hour(`session ${s.name} start`, s.start), end: hour(`session ${s.name} end`, s.end) };
}

/** Throws a RangeError naming the first invalid setting. */
export function validateSmcParams(p: SmcParams): void {
  count('atrPeriod', p.atrPeriod, 2);
  if (!Array.isArray(p.structureTimeframes) || !p.structureTimeframes.every(isTf))
    throw new RangeError('structureTimeframes must list timeframes');
  if (!Array.isArray(p.timeframePairs) || p.timeframePairs.length === 0)
    throw new RangeError('timeframePairs needs at least one (context, setup) pair');
  for (const pair of p.timeframePairs) {
    if (!isTf(pair.context) || !isTf(pair.setup)) throw new RangeError('timeframePairs must hold timeframes');
    if (TF_MS[pair.context] <= TF_MS[pair.setup])
      throw new RangeError(`context ${pair.context} must be longer than setup ${pair.setup}`);
  }
  count('swings.internalOrder', p.swings.internalOrder);
  count('swings.externalOrder', p.swings.externalOrder);
  if (p.swings.externalOrder < p.swings.internalOrder)
    throw new RangeError('swings.externalOrder must be at least swings.internalOrder');
  nonNegative('structure.breakBufferAtr', p.structure.breakBufferAtr);
  const d = p.displacement;
  positive('displacement.candleBodyAtr', d.candleBodyAtr);
  ratio('displacement.candleBodyRatio', d.candleBodyRatio);
  count('displacement.legMinCandles', d.legMinCandles, 2);
  count('displacement.legMaxCandles', d.legMaxCandles, d.legMinCandles);
  positive('displacement.legBodyAtr', d.legBodyAtr);
  ratio('displacement.legCandleBodyRatio', d.legCandleBodyRatio);
  const ob = p.orderBlocks;
  count('orderBlocks.lookback', ob.lookback);
  count('orderBlocks.maxClusterCandles', ob.maxClusterCandles);
  count('orderBlocks.breakWithinBars', ob.breakWithinBars);
  if (ob.zoneMode !== 'wick' && ob.zoneMode !== 'body')
    throw new RangeError('orderBlocks.zoneMode must be "wick" or "body"');
  if (ob.lookback + ob.maxClusterCandles + ob.breakWithinBars > ZONE_HORIZON)
    throw new RangeError(`orderBlocks windows must add up to at most ${ZONE_HORIZON} candles`);
  nonNegative('fvg.minSizeAtr', p.fvg.minSizeAtr);
  const sd = p.supplyDemand;
  count('supplyDemand.baseMaxCandles', sd.baseMaxCandles);
  positive('supplyDemand.baseBodyAtr', sd.baseBodyAtr);
  positive('supplyDemand.departureAtr', sd.departureAtr);
  if (sd.baseMaxCandles + 1 + d.legMaxCandles > ZONE_HORIZON)
    throw new RangeError(`supplyDemand windows must add up to at most ${ZONE_HORIZON} candles`);
  const r = p.ranges;
  count('ranges.lookback', r.lookback, 3);
  positive('ranges.maxHeightAtr', r.maxHeightAtr);
  ratio('ranges.maxEfficiency', r.maxEfficiency);
  nonNegative('ranges.touchTolAtr', r.touchTolAtr);
  count('ranges.minTouches', r.minTouches);
  count('ranges.minTouchSeparation', r.minTouchSeparation, 0);
  count('ranges.breakCloses', r.breakCloses);
  nonNegative('ranges.breakBufferAtr', r.breakBufferAtr);
  count('ranges.maxAge', r.maxAge);
  nonNegative('equalLevels.tolAtr', p.equalLevels.tolAtr);
  count('equalLevels.minGap', p.equalLevels.minGap);
  count('equalLevels.maxGap', p.equalLevels.maxGap, p.equalLevels.minGap);
  if (p.equalLevels.maxGap > MAX_LOOKBACK - 2)
    throw new RangeError(`equalLevels.maxGap must be at most ${MAX_LOOKBACK - 2}`);
  if (r.lookback > MAX_LOOKBACK) throw new RangeError(`ranges.lookback must be at most ${MAX_LOOKBACK}`);
  if (2 * p.swings.externalOrder + 1 > MAX_LOOKBACK) throw new RangeError('swing windows are too long');
  nonNegative('sweeps.minPenetrationAtr', p.sweeps.minPenetrationAtr);
  positive('sweeps.maxPenetrationAtr', p.sweeps.maxPenetrationAtr);
  count('sweeps.closeBackBars', p.sweeps.closeBackBars, 0);
  nonNegative('thinBook.notionalUsd', p.thinBook.notionalUsd);
  const names = new Set<string>();
  const ends = new Set<number>();
  for (const s of p.sessions) {
    if (!(SESSION_NAMES as readonly string[]).includes(s.name))
      throw new RangeError(`unknown session ${s.name}`);
    if (names.has(s.name)) throw new RangeError(`session ${s.name} is listed twice`);
    names.add(s.name);
    const { start, end } = sessionHours(s);
    if (!(end > start))
      throw new RangeError(`session ${s.name} must end after it starts, within the UTC day`);
    if (ends.has(end)) throw new RangeError('two sessions end at the same hour');
    ends.add(end);
  }
  const e = p.expiry;
  for (const [k, v] of Object.entries(e)) count(`expiry.${k}`, v);
}

/**
 * Candles each timeframe keeps for look-back rules (equal highs/lows up to 200 apart, range windows,
 * swing windows, displacement legs). Older candles are needed by no Phase 4 rule.
 */
export const MAX_LOOKBACK = 512;

/**
 * How far back (in candles of its timeframe) a zone can start from the candle that creates it:
 * order-block searches and supply/demand bases stay within it. An ended zone's key is kept this
 * long, so the same zone is never created twice.
 */
export const ZONE_HORIZON = 64;

/** The timeframes each rule group runs on, from the params. */
export interface RuleTimeframes {
  structure: ReadonlySet<Timeframe>;
  ranges: ReadonlySet<Timeframe>;
  sweeps: ReadonlySet<Timeframe>;
}

export function ruleTimeframes(p: SmcParams): RuleTimeframes {
  return {
    structure: new Set(p.structureTimeframes),
    ranges: new Set(p.timeframePairs.map((x) => x.setup)),
    sweeps: new Set(p.timeframePairs.flatMap((x) => [x.setup, x.context])),
  };
}
