import type { Closure, FeedStatus, Instrument } from '@cip/contracts';

export const VENUE_LABEL: Record<Instrument['venue'], string> = {
  binance: 'Binance',
  coinbase: 'Coinbase',
  replay: 'Replay',
};

/** The Command Center's order: the monitored majors, gold, other monitored assets, reference rates. */
const BASE_ORDER = ['BTC', 'ETH', 'SOL', 'PAXG'];

export interface InstrumentGroup {
  /** The base asset, or 'reference' for reference rates such as USDT-USD. */
  key: string;
  title: string;
  instruments: Instrument[];
}

function byVenue(a: Instrument, b: Instrument): number {
  if (a.isPrimaryVenue !== b.isPrimaryVenue) return a.isPrimaryVenue ? -1 : 1;
  return a.venue.localeCompare(b.venue) || a.venueSymbol.localeCompare(b.venueSymbol);
}

/** Instruments grouped by base asset; reference instruments last, in a group of their own. */
export function groupInstruments(instruments: readonly Instrument[]): InstrumentGroup[] {
  const groups = new Map<string, Instrument[]>();
  const reference: Instrument[] = [];
  for (const i of instruments) {
    if (i.role === 'reference') {
      reference.push(i);
      continue;
    }
    groups.set(i.base, [...(groups.get(i.base) ?? []), i]);
  }
  const rank = (base: string) => {
    const i = BASE_ORDER.indexOf(base);
    return i < 0 ? BASE_ORDER.length : i;
  };
  const out: InstrumentGroup[] = [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([base, list]) => ({
      key: base,
      title: base === 'PAXG' ? 'PAXG (gold-backed token)' : base,
      instruments: list.sort(byVenue),
    }));
  if (reference.length > 0)
    out.push({ key: 'reference', title: 'Reference rates', instruments: reference.sort(byVenue) });
  return out;
}

/** The instrument a page shows when none is chosen: the first one in Command Center order. */
export function defaultInstrument(instruments: readonly Instrument[]): Instrument | null {
  return groupInstruments(instruments)[0]?.instruments[0] ?? null;
}

// -----------------------------------------------------------------------------------------------
// Gold-market hours (GLD-02)
// -----------------------------------------------------------------------------------------------

export interface GoldMarketState {
  open: boolean;
  /** Closed: when it reopens. Open: when the next closure starts; null if none is in the calendar. */
  changesAt: number | null;
  /** Closed: why. */
  reason: Closure['reason'] | null;
}

const REASON_RANK: Record<Closure['reason'], number> = { holiday: 0, weekend: 1, daily_break: 2 };

/**
 * Whether the gold market PAXG tracks is open at `now`, from the closure calendar. Closures that
 * overlap or touch (a holiday running into a weekend) count as one closed period. Null when the
 * calendar is empty: then nothing can be said.
 */
export function goldMarketState(closures: readonly Closure[], now: number): GoldMarketState | null {
  if (closures.length === 0) return null;
  const sorted = [...closures].sort((a, b) => a.from - b.from);
  const periods: { from: number; to: number }[] = [];
  for (const c of sorted) {
    const last = periods.at(-1);
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
    else periods.push({ from: c.from, to: c.to });
  }
  const current = periods.find((p) => p.from <= now && now < p.to);
  if (current) {
    const reason =
      sorted
        .filter((c) => c.from <= now && now < c.to)
        .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason])[0]?.reason ?? null;
    return { open: false, changesAt: current.to, reason };
  }
  return { open: true, changesAt: periods.find((p) => p.from > now)?.from ?? null, reason: null };
}

export const CLOSURE_REASON: Record<Closure['reason'], string> = {
  weekend: 'weekend close',
  daily_break: 'daily break',
  holiday: 'holiday',
};

// -----------------------------------------------------------------------------------------------
// Feed status
// -----------------------------------------------------------------------------------------------

export type FeedState = FeedStatus['state'];

/** A `feed.status` message: a FeedStatus without the open-gap count, plus the previous state. */
export type FeedEvent = Omit<FeedStatus, 'openGaps'> & { previous?: string };

export const feedKey = (f: { instrumentId: string; stream: string }) => `${f.instrumentId}:${f.stream}`;

const FEED_RANK: Record<FeedState, number> = { connected: 0, degraded: 1, disconnected: 2 };

/**
 * The polled feed list with the live `feed.status` transitions newer than it applied on top. The
 * open-gap count is kept from the list (the events do not carry it).
 */
export function applyFeedEvents(
  feeds: readonly FeedStatus[],
  asOf: number,
  events: ReadonlyMap<string, { event: FeedEvent; ts: number }>,
): FeedStatus[] {
  const out = new Map(feeds.map((f) => [feedKey(f), f]));
  for (const [key, { event, ts }] of events) {
    if (ts <= asOf) continue;
    out.set(key, {
      instrumentId: event.instrumentId,
      stream: event.stream,
      state: event.state,
      lastMessageAt: event.lastMessageAt,
      lagMsP50: event.lagMsP50,
      lagMsP95: event.lagMsP95,
      detail: event.detail,
      openGaps: out.get(key)?.openGaps ?? 0,
    });
  }
  return [...out.values()];
}

export interface InstrumentFeed {
  /** The worst stream state; null when no status is reported (replay instruments have none). */
  state: FeedState | null;
  /** "streaming", or which streams are affected and why. */
  detail: string;
  openGaps: number;
}

/** One instrument's feed health across its streams. */
export function instrumentFeed(feeds: readonly FeedStatus[], instrumentId: string): InstrumentFeed {
  const streams = feeds.filter((f) => f.instrumentId === instrumentId);
  const openGaps = streams.reduce((n, f) => n + f.openGaps, 0);
  if (streams.length === 0) return { state: null, detail: 'no feed status reported', openGaps };
  const worst = streams.reduce((a, b) => (FEED_RANK[b.state] > FEED_RANK[a.state] ? b : a)).state;
  const affected = streams.filter((s) => s.state !== 'connected');
  if (affected.length === 0) return { state: worst, detail: 'streaming', openGaps };
  // "depth: delayed; ticker: not streaming", or just "not streaming" when every stream says so.
  const byDetail = new Map<string, string[]>();
  for (const s of affected) byDetail.set(s.detail, [...(byDetail.get(s.detail) ?? []), s.stream]);
  const detail = [...byDetail]
    .map(([why, names]) => (names.length === streams.length ? why : `${names.join(', ')}: ${why}`))
    .join('; ');
  return { state: worst, detail, openGaps };
}

export const FEED_LABEL: Record<FeedState, string> = {
  connected: 'Streaming',
  degraded: 'Degraded',
  disconnected: 'Feed down',
};
