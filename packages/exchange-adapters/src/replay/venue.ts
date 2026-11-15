import type { BookSnapshotEvent, Level, MarketEvent } from '../events.js';
import type { VenueHooks } from '../live/venues.js';
import { type RecordedLine, replayEvents } from './recording.js';

/**
 * The replay venue (architecture principle 1, §19): recorded public venue traffic played back, in
 * real time and in a loop, through the production parsers, so the ingestor's pipelines run
 * unchanged. It is for tests, CI and demos; its instruments are venue "replay" and the UI always
 * labels them so. Nothing is invented: every price, size and time offset comes from a recording.
 *
 * How a recording becomes a stream:
 * - Each symbol's window starts at its book snapshot (Binance: the REST snapshot the recorder took;
 *   Coinbase: the channel snapshot) and spans whole minutes, so each loop has exactly one final
 *   kline per minute and times are moved forward by whole minutes, keeping minute boundaries.
 * - Sequence ids (aggTrade ids, trade ids, depth update ids, Coinbase trade ids) are renumbered from
 *   contiguous counters, so a loop never looks like a gap.
 * - At each loop boundary the book returns to the window's starting state: Binance through one
 *   depth update, Coinbase through a new channel snapshot (what the venues would send).
 * - Starting mid-window, earlier book changes are applied silently, never emitted as a burst.
 */
export type ReplayFormat = 'binance' | 'coinbase';

interface Book {
  bids: Map<string, string>;
  asks: Map<string, string>;
}

interface Track {
  symbol: string;
  format: ReplayFormat;
  /** Events inside the window, in receive order, with times relative to the window start. */
  events: MarketEvent[];
  start: number;
  periodMs: number;
  startBook: Book;
  /**
   * The recording host's clock error, estimated as the median of (receive − venue) times; removed
   * on replay, so replayed lag reflects this host's processing rather than the recorder's clock.
   */
  clockOffsetMs: number;
}

interface Playing {
  track: Track;
  /** Per symbol, as at the venues: aggTrade, trade, depth-update and Coinbase trade ids. */
  counters: { aggTrade: number; trade: number; update: number; cbTrade: number };
  /** Shift applied to recorded times in the current loop. */
  delta: number;
  index: number;
  book: Book;
  loop: number;
}

export interface ReplayVenueOptions {
  /** Recordings made by tools/recorder (JSON Lines, parsed). */
  recordings: readonly (readonly RecordedLine[])[];
  now?: () => number;
  tickMs?: number;
  /** Test only: a loop shorter than a minute (minute alignment is then not kept). */
  periodMs?: number;
}

const MINUTE_MS = 60_000;

export class ReplayVenue {
  private readonly tracks = new Map<string, Track>();
  private readonly playing = new Map<string, Playing>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  emitted = 0;

  constructor(
    private readonly hooks: VenueHooks,
    private readonly opts: ReplayVenueOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    const bySymbol = new Map<string, MarketEvent[]>();
    for (const lines of opts.recordings)
      for (const e of replayEvents(lines).events) {
        const list = bySymbol.get(e.symbol) ?? [];
        list.push(e);
        bySymbol.set(e.symbol, list);
      }
    for (const [symbol, events] of bySymbol) {
      const track = buildTrack(symbol, events, opts.periodMs);
      if (track) this.tracks.set(symbol, track);
    }
  }

  /** Symbols this replay can stream, with the venue format each was recorded in. */
  get symbols(): { symbol: string; format: ReplayFormat }[] {
    return [...this.tracks.values()].map((t) => ({ symbol: t.symbol, format: t.format }));
  }

  formatOf(symbol: string): ReplayFormat | null {
    return this.tracks.get(symbol)?.format ?? null;
  }

  setSymbols(symbols: readonly string[]): void {
    const wanted = new Set(symbols.filter((s) => this.tracks.has(s)));
    for (const s of this.playing.keys()) if (!wanted.has(s)) this.playing.delete(s);
    const now = this.now();
    const added: Playing[] = [];
    for (const s of wanted)
      if (!this.playing.has(s)) {
        const p = this.position(this.tracks.get(s)!, now);
        this.playing.set(s, p);
        added.push(p);
      }
    if (this.playing.size === 0) {
      this.halt();
      return;
    }
    if (added.length > 0) this.hooks.onStatus('open', 'replay');
    // Like a venue answering a subscription: Coinbase sends the current book at once.
    for (const p of added) if (p.track.format === 'coinbase') this.emit(this.snapshotEvent(p, now, now));
    if (!this.timer) {
      this.timer = setInterval(() => this.pump(), this.opts.tickMs ?? 50);
      this.timer.unref();
    }
  }

  stop(): void {
    this.playing.clear();
    this.halt();
  }

  /** The book as it stands at the current replay position (the Binance REST depth snapshot). */
  depthSnapshot(symbol: string): Promise<BookSnapshotEvent> {
    const p = this.playing.get(symbol);
    if (!p) return Promise.reject(new Error(`replay is not streaming ${symbol}`));
    const now = this.now();
    return Promise.resolve({
      ...this.snapshotEvent(p, now, now),
      lastUpdateId: p.counters.update - 1,
    });
  }

  private halt(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.hooks.onStatus('closed', 'replay stopped');
  }

  /** Where `now` falls in a track: the loop's shift and the next event, with the book so far. */
  private position(track: Track, now: number): Playing {
    const loop = Math.max(0, Math.floor((now - track.start) / track.periodMs));
    const delta = loop * track.periodMs;
    const book = cloneBook(track.startBook);
    let index = 0;
    while (index < track.events.length && track.events[index]!.receivedAt + delta < now) {
      applyToBook(book, track.events[index]!);
      index++;
    }
    return { track, delta, index, book, loop, counters: { aggTrade: 1, trade: 1, update: 1, cbTrade: 1 } };
  }

  pump(): void {
    const now = this.now();
    for (const p of this.playing.values()) {
      for (let guard = 0; guard < 10_000; guard++) {
        if (p.index >= p.track.events.length) this.nextLoop(p);
        const e = p.track.events[p.index]!;
        if (e.receivedAt + p.delta > now) break;
        p.index++;
        applyToBook(p.book, e);
        this.emit(this.renumber(shift(e, p.delta + p.track.clockOffsetMs, p.delta, now), p));
      }
    }
  }

  private nextLoop(p: Playing): void {
    p.loop++;
    p.delta += p.track.periodMs;
    p.index = 0;
    const at = p.track.start + p.delta;
    const now = this.now();
    if (p.track.format === 'coinbase') {
      p.book = cloneBook(p.track.startBook);
      this.emit(this.snapshotEvent(p, at, now));
      return;
    }
    // Binance: one depth update that turns the current book back into the window's first one.
    const bids = resetLevels(p.book.bids, p.track.startBook.bids);
    const asks = resetLevels(p.book.asks, p.track.startBook.asks);
    p.book = cloneBook(p.track.startBook);
    if (bids.length + asks.length === 0) return;
    const id = p.counters.update++;
    this.emit({
      type: 'book_delta',
      venue: 'binance',
      symbol: p.track.symbol,
      ts: at,
      receivedAt: now,
      bids,
      asks,
      firstUpdateId: id,
      lastUpdateId: id,
    });
  }

  private snapshotEvent(p: Playing, ts: number, receivedAt: number): BookSnapshotEvent {
    return {
      type: 'book_snapshot',
      venue: p.track.format,
      symbol: p.track.symbol,
      ts,
      receivedAt,
      bids: levels(p.book.bids, true),
      asks: levels(p.book.asks, false),
    };
  }

  /** Contiguous ids across loops; Coinbase heartbeats point at the last trade actually sent. */
  private renumber(e: MarketEvent, p: Playing): MarketEvent {
    switch (e.type) {
      case 'trade':
        if (e.venue === 'binance') {
          const seq = p.counters.aggTrade++;
          const fills = e.fills ? e.fills.last - e.fills.first : 0;
          const first = p.counters.trade;
          p.counters.trade += fills + 1;
          return { ...e, seq, tradeId: String(seq), fills: { first, last: first + fills } };
        } else {
          const id = p.counters.cbTrade++;
          return {
            ...e,
            seq: id,
            tradeId: String(id),
            takerOrderRef: e.takerOrderRef === null ? null : `${e.takerOrderRef}:${p.loop}`,
          };
        }
      case 'heartbeat':
        return { ...e, lastTradeId: p.counters.cbTrade - 1 };
      case 'book_delta':
        if (e.venue !== 'binance') return e;
        {
          const id = p.counters.update++;
          return { ...e, firstUpdateId: id, lastUpdateId: id };
        }
      default:
        return e;
    }
  }

  private emit(e: MarketEvent): void {
    this.emitted++;
    this.hooks.onEvent(e);
  }
}

function buildTrack(symbol: string, all: MarketEvent[], periodOverride?: number): Track | null {
  const sorted = [...all].sort((a, b) => a.receivedAt - b.receivedAt);
  const format: ReplayFormat = sorted[0]?.venue === 'coinbase' ? 'coinbase' : 'binance';
  // The window starts at the book snapshot; a symbol recorded without book data starts at its first event.
  const snapshotIndex = sorted.findIndex((e) => e.type === 'book_snapshot');
  const snapshot = snapshotIndex >= 0 ? (sorted[snapshotIndex] as BookSnapshotEvent) : null;
  if (sorted.length === 0) return null;
  const start = snapshot?.receivedAt ?? sorted[0]!.receivedAt;
  const span = sorted.at(-1)!.receivedAt - start;
  const periodMs = periodOverride ?? Math.floor(span / MINUTE_MS) * MINUTE_MS;
  if (periodMs <= 0) return null;
  const events = sorted.filter((e, i) => {
    if (i <= snapshotIndex || e.receivedAt >= start + periodMs) return false;
    if (e.type === 'book_snapshot') return false; // later snapshots: the book is kept by deltas
    // Binance depth updates already contained in the snapshot.
    if (e.type === 'book_delta' && e.lastUpdateId !== undefined && snapshot?.lastUpdateId !== undefined)
      return e.lastUpdateId > snapshot.lastUpdateId;
    return true;
  });
  if (events.length === 0) return null;
  const startBook: Book = { bids: new Map(), asks: new Map() };
  for (const [p, q] of snapshot?.bids ?? []) startBook.bids.set(p, q);
  for (const [p, q] of snapshot?.asks ?? []) startBook.asks.set(p, q);
  const lags = events.map((e) => e.receivedAt - e.ts).sort((a, b) => a - b);
  const clockOffsetMs = lags[Math.floor(lags.length / 2)] ?? 0;
  return { symbol, format, events, start, periodMs, startBook, clockOffsetMs };
}

/** Venue times move by `tsDelta` (loop shift plus clock correction); kline minutes by whole minutes. */
function shift(e: MarketEvent, tsDelta: number, minuteDelta: number, receivedAt: number): MarketEvent {
  const moved = { ...e, ts: e.ts + tsDelta, receivedAt };
  return moved.type === 'kline' ? { ...moved, openTime: moved.openTime + minuteDelta } : moved;
}

function applyToBook(book: Book, e: MarketEvent): void {
  if (e.type !== 'book_delta') return;
  const set = (side: Map<string, string>, [p, q]: Level) => {
    if (Number(q) === 0) side.delete(p);
    else side.set(p, q);
  };
  for (const l of e.bids) set(book.bids, l);
  for (const l of e.asks) set(book.asks, l);
}

/** The changes that turn `current` into `target`: removed levels at "0", the rest at target's size. */
function resetLevels(current: Map<string, string>, target: Map<string, string>): Level[] {
  const out: Level[] = [];
  for (const p of current.keys()) if (!target.has(p)) out.push([p, '0']);
  for (const [p, q] of target) if (current.get(p) !== q) out.push([p, q]);
  return out;
}

function levels(side: Map<string, string>, descending: boolean): Level[] {
  return [...side.entries()].sort(([a], [b]) => (descending ? Number(b) - Number(a) : Number(a) - Number(b)));
}

function cloneBook(b: Book): Book {
  return { bids: new Map(b.bids), asks: new Map(b.asks) };
}
