import type { IndicatorPoint, Tf } from '@cip/contracts';
import {
  type ChartCandle,
  extent,
  formatCandleTime,
  formatIndicator,
  type IndicatorField,
} from '../lib/analysis.js';
import { formatDecimal } from '../lib/decimal.js';

/**
 * The Technical Analysis chart's text alternative (WCAG 1.1.1): what each pane shows, in words,
 * with every number as the API sent it (Phase 3's chart summaries, kept for the Phase 7 chart).
 */
export interface IndicatorSummaryInput {
  candles: readonly ChartCandle[];
  points: readonly IndicatorPoint[];
  labels: Readonly<Record<IndicatorField, string>>;
  runFrom: number | null;
  tf: Tf;
  /** Decimals for prices. */
  dp: number;
  quote: string;
  base: string;
  timeZone: string;
}

const OVERLAYS = ['emaFast', 'emaMid', 'emaSlow', 'vwap'] as const;

function valueText(value: number | null, dp: number): string {
  return value === null ? 'warming up' : formatIndicator(value, dp);
}

export function indicatorSummaries(i: IndicatorSummaryInput): {
  price: string;
  rsi: string;
  macd: string;
  volume: string;
} {
  const { candles, points, labels, runFrom, tf, dp, quote, base, timeZone } = i;
  const time = (t: number) => formatCandleTime(t, tf, timeZone);

  // Price
  const last = candles.at(-1);
  const high = candles.reduce<ChartCandle | null>((m, c) => (m && Number(m.h) >= Number(c.h) ? m : c), null);
  const low = candles.reduce<ChartCandle | null>((m, c) => (m && Number(m.l) <= Number(c.l) ? m : c), null);
  const latest = points.at(-1);
  const price: string[] = [];
  if (last && high && low)
    price.push(
      `${candles.length} candles from ${time(candles[0]!.t)} to ${time(last.t)}.`,
      `Last price ${formatDecimal(last.c, dp)} ${quote}${last.inProgress ? ' (candle in progress)' : ''}; high ${formatDecimal(high.h, dp)}, low ${formatDecimal(low.l, dp)}.`,
    );
  else price.push('No candles stored in this window.');
  if (latest)
    price.push(
      `At ${time(latest.t)}: ${OVERLAYS.filter((k) => k !== 'vwap' || tf !== '1d')
        .map((k) => `${labels[k]} ${valueText(latest[k], dp)}`)
        .join(', ')}.`,
    );
  const first = candles[0]?.t ?? points[0]?.t;
  if (runFrom !== null && first !== undefined && runFrom > first)
    price.push(`Candles before ${time(runFrom)} are warm-up.`);

  // RSI
  const valued = points.filter((p) => p.rsi !== null);
  const lastRsi = valued.at(-1);
  const range = extent(valued.map((p) => p.rsi));
  const above = valued.filter((p) => p.rsi! > 70).length;
  const below = valued.filter((p) => p.rsi! < 30).length;
  const rsi =
    lastRsi && range
      ? `${labels.rsi} ${formatIndicator(lastRsi.rsi!, 2)} at ${time(lastRsi.t)}; lowest ${formatIndicator(range[0], 2)}, highest ${formatIndicator(range[1], 2)} over ${valued.length} candles. ${above} closed above 70 and ${below} below 30.`
      : `${labels.rsi} is warming up: no value in this window yet.`;

  // MACD
  const lastMacd = points.filter((p) => p.macd !== null).at(-1);
  let macd = `${labels.macd} is warming up: no value in this window yet.`;
  if (lastMacd) {
    const hist = lastMacd.macdHist;
    const relation =
      hist === null
        ? ''
        : hist > 0
          ? ' MACD is above its signal line.'
          : hist < 0
            ? ' MACD is below its signal line.'
            : '';
    macd = `${labels.macd} at ${time(lastMacd.t)}: MACD ${valueText(lastMacd.macd, dp)}, signal ${valueText(lastMacd.macdSignal, dp)}, histogram ${valueText(hist, dp)}.${relation}`;
  }

  // Volume
  const anomalyAt = new Set(points.filter((p) => p.volumeAnomaly === true).map((p) => p.t));
  const anomalies = candles.filter((c) => anomalyAt.has(c.t));
  const closed = candles.filter((c) => !c.inProgress).at(-1);
  const forming = candles.at(-1)?.inProgress ? candles.at(-1) : undefined;
  const volume: string[] = [];
  if (closed)
    volume.push(`Volume of the last closed candle (${time(closed.t)}): ${formatDecimal(closed.v)} ${base}.`);
  if (forming) volume.push(`The candle in progress has traded ${formatDecimal(forming.v)} ${base} so far.`);
  volume.push(
    anomalies.length === 0
      ? `No ${labels.volumeAnomaly.toLowerCase()} in this window.`
      : `${anomalies.length} volume ${anomalies.length === 1 ? 'anomaly' : 'anomalies'} in this window, the latest at ${time(anomalies.at(-1)!.t)}.`,
  );

  return { price: price.join(' '), rsi, macd, volume: volume.join(' ') };
}
