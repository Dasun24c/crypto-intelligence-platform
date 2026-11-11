export type Trend = 'bullish' | 'bearish' | 'neutral';

export interface TrendInput {
  close: number;
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  /** The mid EMA `slopeBars` candles earlier. */
  emaMidBefore: number | null;
  atr: number | null;
}

export interface TrendValue {
  trend: Trend | null;
  strength: number | null;
}

/**
 * Indicator trend (TA-03). It is separate from the SMC structure trend (requirements C3) and is a
 * description of recent prices, never a prediction.
 *
 * - **Strength**: (mid EMA now − mid EMA `slopeBars` candles earlier) / ATR, the mid EMA's slope
 *   measured in average true ranges.
 * - **Bullish**: close > fast EMA > mid EMA > slow EMA, and strength ≥ `minStrength`.
 * - **Bearish**: close < fast EMA < mid EMA < slow EMA, and strength ≤ −`minStrength`.
 * - **Neutral**: anything else. An ATR of 0 (no range at all) gives a null strength and neutral.
 * - **Warm-up**: null until the slow EMA, the earlier mid EMA and the ATR all exist (199 candles
 *   with the defaults).
 *
 * The minimum strength (0.1 by default) keeps EMAs that are merely in order on a flat market
 * from reading as a trend. On 90,000 Binance candles (BTC, ETH and PAXG at 5m, 1h and 4h) it
 * relabels as neutral only the weakest tenth of the aligned candles; noise that alternates candle
 * to candle scores about 0.02, and a steady 0.2 % move per candle about 2.
 */
export function classifyTrend(input: TrendInput, minStrength: number): TrendValue {
  const { close, emaFast, emaMid, emaSlow, emaMidBefore, atr } = input;
  if (emaFast === null || emaMid === null || emaSlow === null || emaMidBefore === null || atr === null)
    return { trend: null, strength: null };
  const strength = atr > 0 ? (emaMid - emaMidBefore) / atr : null;
  if (strength === null) return { trend: 'neutral', strength };
  if (strength >= minStrength && close > emaFast && emaFast > emaMid && emaMid > emaSlow)
    return { trend: 'bullish', strength };
  if (strength <= -minStrength && close < emaFast && emaFast < emaMid && emaMid < emaSlow)
    return { trend: 'bearish', strength };
  return { trend: 'neutral', strength };
}
