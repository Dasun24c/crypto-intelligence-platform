import type { CrossVenueSpread, DataGap, LargeTrade, Wall } from '@cip/contracts';

/**
 * Market Activity state: what REST returned, plus what the live channels delivered since. Each piece
 * merges idempotently (by id), so a message that is also in a REST page counts once, and a newer
 * state never goes back to an older one when a slow REST response lands after a live update.
 */

/** The snapshot `market:{id}` sends after a resync it could not replay (API contracts §5.4). */
export interface MarketSnapshot {
  openGaps?: DataGap[];
  activeWalls?: Wall[];
}

// -----------------------------------------------------------------------------------------------
// Large trades
// -----------------------------------------------------------------------------------------------

const LIVE_TRADES_KEPT = 500;

export interface LiveTrades {
  readonly trades: ReadonlyMap<string, LargeTrade>;
}

export const NO_LIVE_TRADES: LiveTrades = { trades: new Map() };

export type TradesAction =
  | { type: 'trade'; trade: LargeTrade }
  /** A resync snapshot: the latest trades, including any missed while disconnected. */
  | { type: 'snapshot'; trades: readonly LargeTrade[] };

export function liveTradesReducer(state: LiveTrades, action: TradesAction): LiveTrades {
  const trades = new Map(state.trades);
  for (const t of action.type === 'trade' ? [action.trade] : action.trades) trades.set(t.id, t);
  if (trades.size > LIVE_TRADES_KEPT) {
    const oldest = [...trades.values()].sort((a, b) => a.ts - b.ts).slice(0, trades.size - LIVE_TRADES_KEPT);
    for (const t of oldest) trades.delete(t.id);
  }
  return { trades };
}

/**
 * REST pages and live trades, newest first, each once. Trades never change once detected, so a resync
 * snapshot only adds what was missed.
 */
export function mergeTrades(rest: readonly LargeTrade[], live: LiveTrades): LargeTrade[] {
  const byId = new Map<string, LargeTrade>();
  for (const t of rest) byId.set(t.id, t);
  for (const t of live.trades.values()) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
}

// -----------------------------------------------------------------------------------------------
// Walls
// -----------------------------------------------------------------------------------------------

export interface LiveWalls {
  readonly updates: ReadonlyMap<string, Wall>;
  /** Set by a resync snapshot: the walls standing now, replacing the REST list of active walls. */
  readonly standing: readonly Wall[] | null;
}

export const NO_LIVE_WALLS: LiveWalls = { updates: new Map(), standing: null };

export type WallsAction = { type: 'wall'; wall: Wall } | { type: 'snapshot'; standing: readonly Wall[] };

/** The later state of a wall: an ended wall never stands again; otherwise the later sighting wins. */
export function laterWall(a: Wall | undefined, b: Wall): Wall {
  if (!a) return b;
  if ((a.endedReason === null) !== (b.endedReason === null)) return a.endedReason !== null ? a : b;
  return b.lastSeen >= a.lastSeen ? b : a;
}

export function liveWallsReducer(state: LiveWalls, action: WallsAction): LiveWalls {
  if (action.type === 'snapshot')
    return {
      // Walls seen ending stay as history; whatever still stands comes from the snapshot.
      updates: new Map([...state.updates].filter(([, w]) => w.endedReason !== null)),
      standing: action.standing,
    };
  const updates = new Map(state.updates);
  updates.set(action.wall.id, laterWall(updates.get(action.wall.id), action.wall));
  return { ...state, updates };
}

const notional = (w: Wall) => Number(w.maxNotionalUsd);

/** Standing walls (largest first) and ended ones (most recent first). */
export function mergeWalls(
  active: readonly Wall[],
  ended: readonly Wall[],
  live: LiveWalls,
): { standing: Wall[]; ended: Wall[] } {
  const byId = new Map<string, Wall>();
  const put = (w: Wall) => byId.set(w.id, laterWall(byId.get(w.id), w));
  for (const w of ended) put(w);
  for (const w of live.standing ?? active) put(w);
  for (const w of live.updates.values()) put(w);
  const all = [...byId.values()];
  return {
    standing: all.filter((w) => w.endedReason === null).sort((a, b) => notional(b) - notional(a)),
    ended: all.filter((w) => w.endedReason !== null).sort((a, b) => b.lastSeen - a.lastSeen),
  };
}

// -----------------------------------------------------------------------------------------------
// Data gaps
// -----------------------------------------------------------------------------------------------

const GAP_RANK: Record<DataGap['status'], number> = { open: 0, backfilling: 1, repaired: 2, unrepairable: 2 };

export interface LiveGaps {
  readonly opened: ReadonlyMap<string, DataGap>;
  readonly closed: ReadonlyMap<string, { status: DataGap['status']; at: number }>;
}

export const NO_LIVE_GAPS: LiveGaps = { opened: new Map(), closed: new Map() };

export type GapsAction =
  | { type: 'opened'; gap: DataGap }
  | { type: 'closed'; gapId: string; status: DataGap['status']; at: number }
  /** A resync snapshot: the gaps open now. */
  | { type: 'snapshot'; open: readonly DataGap[] };

export function liveGapsReducer(state: LiveGaps, action: GapsAction): LiveGaps {
  if (action.type === 'closed')
    return {
      ...state,
      closed: new Map(state.closed).set(action.gapId, { status: action.status, at: action.at }),
    };
  const opened = new Map(state.opened);
  for (const g of action.type === 'opened' ? [action.gap] : action.open) opened.set(g.id, g);
  return { ...state, opened };
}

/** A gap from a `gap.opened` message ({gapId, instrumentId, stream, from, to, detectedBy}). */
export function gapFromEvent(data: unknown, ts: number): DataGap | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Record<string, unknown>>;
  if (typeof d['gapId'] !== 'string' || typeof d['instrumentId'] !== 'string') return null;
  if (typeof d['stream'] !== 'string' || typeof d['from'] !== 'number') return null;
  return {
    id: d['gapId'],
    instrumentId: d['instrumentId'],
    stream: d['stream'] as DataGap['stream'],
    from: d['from'],
    to: typeof d['to'] === 'number' ? d['to'] : null,
    detectedAt: ts,
    detectedBy: (typeof d['detectedBy'] === 'string' ? d['detectedBy'] : 'timer') as DataGap['detectedBy'],
    status: 'open',
    resolvedAt: null,
    details: {},
  };
}

/** A `gap.closed` message ({gapId, instrumentId, status, ...details}), or null. */
export function gapClosure(data: unknown): { gapId: string; status: DataGap['status'] } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Partial<Record<string, unknown>>;
  if (typeof d['gapId'] !== 'string') return null;
  const status = d['status'] === 'unrepairable' ? 'unrepairable' : 'repaired';
  return { gapId: d['gapId'], status };
}

/** A gap's status only moves forward: open → backfilling → repaired or unrepairable. */
function laterGap(a: DataGap | undefined, b: DataGap): DataGap {
  if (!a) return b;
  return GAP_RANK[b.status] >= GAP_RANK[a.status]
    ? { ...a, ...b, details: { ...a.details, ...b.details } }
    : a;
}

/** REST and live gaps, most recently detected first. */
export function mergeGaps(rest: readonly DataGap[], live: LiveGaps): DataGap[] {
  const byId = new Map<string, DataGap>();
  for (const g of rest) byId.set(g.id, g);
  for (const g of live.opened.values()) byId.set(g.id, laterGap(byId.get(g.id), g));
  for (const [id, c] of live.closed) {
    const g = byId.get(id);
    if (g && GAP_RANK[c.status] >= GAP_RANK[g.status])
      byId.set(id, { ...g, status: c.status, resolvedAt: g.resolvedAt ?? c.at });
  }
  return [...byId.values()].sort((a, b) => b.detectedAt - a.detectedAt);
}

// -----------------------------------------------------------------------------------------------
// Cross-venue spread
// -----------------------------------------------------------------------------------------------

const LIVE_SPREADS_KEPT = 4_000; // a little over an hour at 1 Hz

export function liveSpreadsReducer(
  state: readonly CrossVenueSpread[],
  spread: CrossVenueSpread,
): readonly CrossVenueSpread[] {
  const next = [...state, spread];
  return next.length > LIVE_SPREADS_KEPT ? next.slice(next.length - LIVE_SPREADS_KEPT) : next;
}

export interface SpreadPoint {
  ts: number;
  bps: number;
}

/** Stored rows (every 10 s) and live points (every second) from `from` on, oldest first, one per ts. */
export function spreadSeries(
  stored: readonly CrossVenueSpread[],
  live: readonly CrossVenueSpread[],
  from: number,
): SpreadPoint[] {
  const byTs = new Map<number, number>();
  for (const s of [...stored, ...live]) if (s.ts >= from) byTs.set(s.ts, s.spreadBps);
  return [...byTs].sort(([a], [b]) => a - b).map(([ts, bps]) => ({ ts, bps }));
}
