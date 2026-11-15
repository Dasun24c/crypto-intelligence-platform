import type { LevelType, Pattern, SetupState, ZoneType } from '@cip/contracts';
import type { EvaluableRule, Found } from './types.js';
import type { AlertSource } from './sources.js';

const LEVEL: Record<LevelType, string> = {
  eqh: 'equal highs',
  eql: 'equal lows',
  pdh: 'previous day high',
  pdl: 'previous day low',
  pwh: 'previous week high',
  pwl: 'previous week low',
  pmh: 'previous month high',
  pml: 'previous month low',
  session_high: 'session high',
  session_low: 'session low',
  range_high: 'range high',
  range_low: 'range low',
  weekend_high: 'weekend high',
  weekend_low: 'weekend low',
  swing_high: 'swing high',
  swing_low: 'swing low',
  sweep_extreme: 'sweep extreme',
};
const ZONE: Record<ZoneType, string> = {
  order_block: 'order block',
  fvg: 'fair value gap',
  supply: 'supply zone',
  demand: 'demand zone',
};
const PATTERN: Record<Pattern, string> = {
  double_liquidity_trap: 'Pattern 1, double liquidity trap',
  eq_near_poi: 'Pattern 2, equal highs/lows near a POI',
  htf_order_block: 'Pattern 3, higher-timeframe order block',
  sweep_outside_fill_inside: 'Pattern 4, sweep outside, fill inside',
};
const STATE: Record<SetupState, string> = {
  forming: 'watching',
  triggered: 'triggered',
  confirmed: 'confirmed',
  entry_active: 'entry zone active',
  resolved: 'resolved',
};
const INDICATOR = {
  rsi: 'RSI',
  macd_hist: 'MACD histogram',
  volume_z: 'Volume z-score',
  atr: 'ATR',
} as const;
const OP = {
  '>': 'above',
  '<': 'below',
  cross_above: 'crossed above',
  cross_below: 'crossed below',
} as const;
const FEED = {
  gap: 'data gap',
  delayed: 'delayed',
  halted: 'halted',
  delisted: 'delisted',
  disconnected: 'disconnected',
} as const;

/** Up to `dp` decimal places, without trailing zeros. */
const num = (n: number, dp = 2) => String(Math.round(n * 10 ** dp) / 10 ** dp);
/** "1.2M", "850k": for USD amounts in titles; bodies give the exact figure. */
function usdShort(usd: string): string {
  const n = Number(usd);
  if (n >= 1e9) return `$${num(n / 1e9, 1)}B`;
  if (n >= 1e6) return `$${num(n / 1e6, 1)}M`;
  if (n >= 1e3) return `$${num(n / 1e3, 0)}k`;
  return `$${num(n, 0)}`;
}
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/**
 * The alert's title and body. They state facts the platform recorded; setup alerts say their levels
 * are hypothetical (analysis, not advice), as every setup does.
 */
export function describe(
  rule: EvaluableRule,
  source: AlertSource,
  found: Found,
): { title: string; body: string } {
  const c = rule.condition;
  const f = found.facts;
  switch (source.kind) {
    case 'price': {
      const name = source.instrument.name;
      if (c.kind === 'price_cross')
        return { title: `${name} crossed ${c.direction} ${c.price}`, body: `Last price ${source.price}.` };
      const change = Number(f['change']);
      const windowMin = c.kind === 'price_change_pct' ? c.windowMin : 0;
      return {
        title: `${name} ${change >= 0 ? 'up' : 'down'} ${num(Math.abs(change))}% in ${windowMin} min`,
        body: `From ${String(f['reference'])} to ${source.price}.`,
      };
    }
    case 'indicator': {
      const name = `${source.instrument.name} ${source.tf}`;
      if (c.kind === 'volume_anomaly')
        return {
          title: `${name}: volume anomaly (z ${num(Number(f['z']))})`,
          body: `Volume z-score ${num(Number(f['z']))} on the latest closed candle (threshold ${c.minZ}).`,
        };
      if (c.kind !== 'indicator_threshold') break;
      return {
        title: `${name}: ${INDICATOR[c.indicator]} ${OP[c.op]} ${c.value}`,
        body: `${INDICATOR[c.indicator]} ${num(Number(f['value']), 4)} on the latest closed candle.`,
      };
    }
    case 'smc': {
      const name = `${source.instrument.name} ${source.tf}`;
      const dir = source.direction ? `${source.direction} ` : '';
      switch (source.event) {
        case 'sweep':
        case 'false_breakout': {
          const level = source.levelType ? LEVEL[source.levelType] : 'liquidity level';
          const what = source.event === 'sweep' ? 'sweep' : 'false breakout';
          return {
            title: `${name}: ${what} of the ${level}`,
            body: `Liquidity at ${source.price} was taken, confirmed on a closed candle.`,
          };
        }
        case 'poi_entry': {
          const zone = source.zoneType ? ZONE[source.zoneType] : 'point of interest';
          return {
            title: `${name}: price entered a ${dir}${zone}`,
            body: `First touch of the zone at ${source.price}.`,
          };
        }
        default:
          return {
            title: `${name}: ${dir}${source.event.toUpperCase()}`,
            body: `Structure broke at ${source.price}, confirmed on a closed candle.`,
          };
      }
    }
    case 'setup':
      return {
        title: `${source.instrument.name} ${source.tf}: ${PATTERN[source.pattern]}, ${source.direction}, ${STATE[source.toState]}`,
        body: `Score ${String(f['score'])}. All levels are hypothetical. Educational analysis — not financial advice.`,
      };
    case 'spread': {
      const bps = Number(f['bps']);
      return {
        title: `PAXG spread ${num(Math.abs(bps), 1)} bps`,
        // The stored spread is (Coinbase − Binance) / Binance: positive when Coinbase is higher.
        body: `${bps >= 0 ? 'Coinbase is above Binance' : 'Binance is above Coinbase'} by ${num(Math.abs(bps), 1)} bps (threshold ${c.kind === 'spread_threshold' ? c.absBps : 0} bps).`,
      };
    }
    case 'economic_event':
      return {
        title: `${source.event.title} in ${String(f['minutes'])} min`,
        body: `${source.event.impact === 'high' ? 'High' : 'Medium'}-impact ${source.event.currency} release at ${utc(source.event.scheduledAt)}.`,
      };
    case 'gold_session':
      return source.change === 'open'
        ? {
            title: 'Gold market open',
            body: 'The underlying gold market reopened; PAXG prices can track it again.',
          }
        : {
            title: 'Gold market closed',
            body: 'The underlying gold market is closed; PAXG keeps trading, usually on thinner books.',
          };
    case 'large_trade':
      return {
        title: `${source.instrument.name}: large ${source.side} ${usdShort(source.usd)}`,
        body: `${source.usd} USD at ${source.price}.`,
      };
    case 'wall':
      return {
        title: `${source.instrument.name}: ${source.side} wall ${source.event} ${usdShort(source.usd)}`,
        body: `${source.usd} USD at ${source.price}.`,
      };
    case 'feed':
      return {
        title: `${source.instrument.name}: feed ${FEED[source.event]}`,
        body: source.detail,
      };
  }
  return { title: rule.name, body: '' };
}
