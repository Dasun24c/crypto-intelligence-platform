import { floorTo, TF_MS, type Timeframe } from '@cip/domain';
import { assertPeriod, type Bar } from './bar.js';
import { Atr, atr } from './atr.js';
import { Ema, ema } from './ema.js';
import { Macd, macd, macdLookback } from './macd.js';
import { Rsi, rsi } from './rsi.js';
import { classifyTrend, type Trend } from './trend.js';
import { isVolumeAnomaly, VolumeZ, volumeZ } from './volume.js';
import { DAY_MS, Vwap, vwap } from './vwap.js';

/** Indicator settings, part of an instrument profile (data model §4: `instrument_profiles.params`). */
export interface IndicatorParams {
  rsi: { period: number };
  macd: { fast: number; slow: number; signal: number };
  /** Three EMAs, used for the trend as well as shown on charts. */
  ema: { fast: number; mid: number; slow: number };
  atr: { period: number };
  /** The robust z-score window and the anomaly threshold. */
  volume: { lookback: number; zThreshold: number };
  /**
   * How many candles back the mid EMA's slope is measured from, and the slope (in ATRs) a trend
   * needs before it counts.
   */
  trend: { slopeBars: number; minStrength: number };
}

export const DEFAULT_INDICATOR_PARAMS: IndicatorParams = Object.freeze({
  rsi: { period: 14 },
  macd: { fast: 12, slow: 26, signal: 9 },
  ema: { fast: 20, mid: 50, slow: 200 },
  atr: { period: 14 },
  volume: { lookback: 50, zThreshold: 3.5 },
  trend: { slopeBars: 5, minStrength: 0.1 },
});

/** One candle's indicator values (data model: `analysis.indicator_values`). Null during warm-up. */
export interface IndicatorValues {
  openTime: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  /** Null on 1d candles: a day-anchored VWAP of a single daily candle is just its typical price. */
  vwap: number | null;
  atr: number | null;
  volumeZ: number | null;
  volumeAnomaly: boolean | null;
  trend: Trend | null;
  trendStrength: number | null;
}

/** Throws a RangeError naming the first invalid setting. */
export function validateIndicatorParams(p: IndicatorParams): void {
  assertPeriod('RSI period', p.rsi.period);
  macdLookback(p.macd.fast, p.macd.slow, p.macd.signal);
  assertPeriod('fast EMA period', p.ema.fast);
  assertPeriod('mid EMA period', p.ema.mid);
  assertPeriod('slow EMA period', p.ema.slow);
  if (!(p.ema.fast < p.ema.mid && p.ema.mid < p.ema.slow))
    throw new RangeError('the EMA periods must increase: fast < mid < slow');
  assertPeriod('ATR period', p.atr.period);
  assertPeriod('volume lookback', p.volume.lookback);
  if (!(Number.isFinite(p.volume.zThreshold) && p.volume.zThreshold > 0))
    throw new RangeError('the volume z threshold must be a positive number');
  assertPeriod('trend slope candles', p.trend.slopeBars, 1);
  if (!(Number.isFinite(p.trend.minStrength) && p.trend.minStrength > 0))
    throw new RangeError('the minimum trend strength must be a positive number');
}

/**
 * How many candles each indicator needs before its first value. These are the warm-ups to skip
 * when comparing with another implementation; with the defaults: RSI 14, MACD 33, EMAs 19/49/199,
 * ATR 14, volume 50, trend 199. VWAP has none (it waits only for volume).
 */
export function indicatorLookbacks(p: IndicatorParams = DEFAULT_INDICATOR_PARAMS) {
  return {
    rsi: p.rsi.period,
    macd: macdLookback(p.macd.fast, p.macd.slow, p.macd.signal),
    emaFast: p.ema.fast - 1,
    emaMid: p.ema.mid - 1,
    emaSlow: p.ema.slow - 1,
    atr: p.atr.period,
    volume: p.volume.lookback,
    trend: Math.max(p.ema.slow - 1, p.ema.mid - 1 + p.trend.slopeBars, p.atr.period),
  };
}

const usesVwap = (tf: Timeframe) => TF_MS[tf] < DAY_MS;

function checkOrder(tf: Timeframe, previous: number | null, openTime: number): void {
  if (floorTo(openTime, tf) !== openTime)
    throw new RangeError(`candle at ${openTime} is not aligned to ${tf}`);
  if (previous !== null && openTime !== previous + TF_MS[tf])
    throw new RangeError(
      `${tf} candles must be consecutive: expected ${new Date(previous + TF_MS[tf]).toISOString()}, got ${new Date(openTime).toISOString()}`,
    );
}

/**
 * Every indicator for one instrument and timeframe, one closed candle at a time (the analyzer's
 * form). Candles must be consecutive: the analyzer pauses on a gap instead of skipping it.
 * Gives exactly the values {@link computeIndicators} gives for the same candles (criterion 3.4).
 */
export class IndicatorSeries {
  private readonly rsi: Rsi;
  private readonly macd: Macd;
  private readonly emaFast: Ema;
  private readonly emaMid: Ema;
  private readonly emaSlow: Ema;
  private readonly atr: Atr;
  private readonly vwap: Vwap | null;
  private readonly volume: VolumeZ;
  /** The mid EMA of the last slopeBars + 1 candles, oldest first. */
  private readonly midHistory: (number | null)[] = [];
  private last: number | null = null;

  constructor(
    readonly timeframe: Timeframe,
    readonly params: IndicatorParams = DEFAULT_INDICATOR_PARAMS,
  ) {
    validateIndicatorParams(params);
    this.rsi = new Rsi(params.rsi.period);
    this.macd = new Macd(params.macd.fast, params.macd.slow, params.macd.signal);
    this.emaFast = new Ema(params.ema.fast);
    this.emaMid = new Ema(params.ema.mid);
    this.emaSlow = new Ema(params.ema.slow);
    this.atr = new Atr(params.atr.period);
    this.vwap = usesVwap(timeframe) ? new Vwap() : null;
    this.volume = new VolumeZ(params.volume.lookback);
  }

  /** Open time of the last candle taken, or null before the first. */
  get lastOpenTime(): number | null {
    return this.last;
  }

  next(bar: Bar): IndicatorValues {
    checkOrder(this.timeframe, this.last, bar.openTime);
    this.last = bar.openTime;
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const m = this.macd.next(close);
    const emaFast = this.emaFast.next(close);
    const emaMid = this.emaMid.next(close);
    const emaSlow = this.emaSlow.next(close);
    const atrValue = this.atr.next(high, low, close);
    const z = this.volume.next(Number(bar.volume));
    this.midHistory.push(emaMid);
    if (this.midHistory.length > this.params.trend.slopeBars + 1) this.midHistory.shift();
    const emaMidBefore = this.midHistory.length > this.params.trend.slopeBars ? this.midHistory[0]! : null;
    const trend = classifyTrend(
      { close, emaFast, emaMid, emaSlow, emaMidBefore, atr: atrValue },
      this.params.trend.minStrength,
    );
    return {
      openTime: bar.openTime,
      rsi: this.rsi.next(close),
      macd: m?.macd ?? null,
      macdSignal: m?.signal ?? null,
      macdHist: m?.hist ?? null,
      emaFast,
      emaMid,
      emaSlow,
      vwap: this.vwap?.next(bar) ?? null,
      atr: atrValue,
      volumeZ: z,
      volumeAnomaly: isVolumeAnomaly(z, this.params.volume.zThreshold),
      trend: trend.trend,
      trendStrength: trend.strength,
    };
  }
}

/**
 * Every indicator over a whole series at once (the batch form, for replays and checks). An
 * independent implementation of the same definitions as {@link IndicatorSeries}.
 */
export function computeIndicators(
  bars: readonly Bar[],
  timeframe: Timeframe,
  params: IndicatorParams = DEFAULT_INDICATOR_PARAMS,
): IndicatorValues[] {
  validateIndicatorParams(params);
  bars.forEach((bar, i) => checkOrder(timeframe, i === 0 ? null : bars[i - 1]!.openTime, bar.openTime));
  const high = bars.map((b) => Number(b.high));
  const low = bars.map((b) => Number(b.low));
  const close = bars.map((b) => Number(b.close));
  const rsiValues = rsi(close, params.rsi.period);
  const m = macd(close, params.macd.fast, params.macd.slow, params.macd.signal);
  const emaFast = ema(close, params.ema.fast);
  const emaMid = ema(close, params.ema.mid);
  const emaSlow = ema(close, params.ema.slow);
  const atrValues = atr(high, low, close, params.atr.period);
  const vwapValues = usesVwap(timeframe) ? vwap(bars) : null;
  const z = volumeZ(
    bars.map((b) => Number(b.volume)),
    params.volume.lookback,
  );
  const lag = params.trend.slopeBars;
  return bars.map((bar, i) => {
    const trend = classifyTrend(
      {
        close: close[i]!,
        emaFast: emaFast[i]!,
        emaMid: emaMid[i]!,
        emaSlow: emaSlow[i]!,
        emaMidBefore: i >= lag ? emaMid[i - lag]! : null,
        atr: atrValues[i]!,
      },
      params.trend.minStrength,
    );
    return {
      openTime: bar.openTime,
      rsi: rsiValues[i]!,
      macd: m.macd[i]!,
      macdSignal: m.signal[i]!,
      macdHist: m.hist[i]!,
      emaFast: emaFast[i]!,
      emaMid: emaMid[i]!,
      emaSlow: emaSlow[i]!,
      vwap: vwapValues ? vwapValues[i]! : null,
      atr: atrValues[i]!,
      volumeZ: z[i]!,
      volumeAnomaly: isVolumeAnomaly(z[i]!, params.volume.zThreshold),
      trend: trend.trend,
      trendStrength: trend.strength,
    };
  });
}
