import { createHash } from 'node:crypto';
import type { AiContext } from '@cip/contracts';

/** About 8k tokens (architecture §8); a token is counted as 4 characters of the JSON. */
export const CONTEXT_TOKEN_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const tokensOf = (ctx: AiContext) => estimateTokens(JSON.stringify(ctx));

const TF_RANK: Record<string, number> = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5 };

/**
 * Fits the context to the token budget, dropping the lowest-priority items first: the oldest recent
 * events, the farthest levels, the farthest zones, the latest calendar entries, then the longest
 * timeframes' indicators. The instrument, the market, the gold market, the setups, the structure
 * and the data-quality notes are always kept.
 */
export function trimContext(
  ctx: AiContext,
  maxTokens = CONTEXT_TOKEN_BUDGET,
): { context: AiContext; dropped: number } {
  const c: AiContext = structuredClone(ctx);
  let dropped = 0;
  const last = c.market.last === null ? null : Number(c.market.last);
  const zoneDistance = (z: AiContext['zones'][number]) =>
    last === null ? 0 : Math.min(Math.abs(Number(z.top) - last), Math.abs(Number(z.bottom) - last));
  const steps: (() => boolean)[] = [
    () => {
      if (!c.recentEvents.length) return false;
      c.recentEvents.sort((a, b) => b.at - a.at).pop();
      return true;
    },
    () => {
      if (!c.levels.length) return false;
      c.levels.sort((a, b) => (a.distanceAtr ?? Infinity) - (b.distanceAtr ?? Infinity)).pop();
      return true;
    },
    () => {
      if (!c.zones.length) return false;
      c.zones.sort((a, b) => zoneDistance(a) - zoneDistance(b)).pop();
      return true;
    },
    () => {
      if (!c.calendar.length) return false;
      c.calendar.sort((a, b) => a.at - b.at).pop();
      return true;
    },
    () => {
      if (!c.indicators.length) return false;
      c.indicators.sort((a, b) => (TF_RANK[a.tf] ?? 9) - (TF_RANK[b.tf] ?? 9)).pop();
      return true;
    },
  ];
  for (const step of steps) while (tokensOf(c) > maxTokens && step()) dropped++;
  return { context: c, dropped };
}

const TIMES = new Set(['asOf', 'at', 'nextChangeAt']);

const sig = (v: number, digits: number) => (v === 0 ? 0 : Number(v.toPrecision(digits)));

/**
 * The context as the cache compares it: without times, and with the market's moving figures at the
 * precision they are read at (the last price to 4 significant digits, the 24 h change to 0.1 point,
 * the volume to 2 significant digits, spreads to whole basis points, indicators to 3 significant
 * digits). Keys are sorted.
 */
export function canonicalContext(ctx: AiContext): string {
  const c: AiContext = structuredClone(ctx);
  c.market.last = c.market.last === null ? null : String(sig(Number(c.market.last), 4));
  c.market.change24hPct = c.market.change24hPct === null ? null : Math.round(c.market.change24hPct * 10) / 10;
  c.market.volume24hUsd = c.market.volume24hUsd === null ? null : sig(c.market.volume24hUsd, 2);
  c.market.spreadBps = c.market.spreadBps === null ? null : Math.round(c.market.spreadBps);
  if (c.goldMarket?.crossVenueSpreadBps != null)
    c.goldMarket.crossVenueSpreadBps = Math.round(c.goldMarket.crossVenueSpreadBps);
  for (const i of c.indicators) i.value = sig(i.value, 3);
  for (const l of c.levels) if (l.distanceAtr !== null) l.distanceAtr = Math.round(l.distanceAtr * 10) / 10;
  return JSON.stringify(sortKeys(c));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => !TIMES.has(k))
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/** The cache key (ADR 023): SHA-256 of the canonical context. */
export function contextHash(ctx: AiContext): string {
  return createHash('sha256').update(canonicalContext(ctx)).digest('hex');
}

/**
 * A short id for an entity (`lvl:3f2a9c1e`): the end of its UUID, longer only when that one is
 * taken in this context. The end, not the start: a time-ordered UUID (v7) starts with its time, so
 * entities made in the same minute share their first digits.
 */
export function shortId(prefix: string, uuid: string, taken: Set<string>): string {
  const hex = uuid.replace(/-/g, '');
  for (let n = 8; n <= hex.length; n += 4) {
    const id = `${prefix}:${hex.slice(-n)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  const id = `${prefix}:${hex}:${taken.size}`;
  taken.add(id);
  return id;
}
