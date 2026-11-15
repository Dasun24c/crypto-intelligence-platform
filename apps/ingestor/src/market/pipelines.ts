import type { Redis } from 'ioredis';
import { type BookSnapshot, channels, type Ticker, toWireCandle } from '@cip/contracts';
import { type Candle, floorTo, MINUTE_MS } from '@cip/domain';
import type { NewTrade } from '@cip/db';
import type {
  BookSnapshotEvent,
  KlineEvent,
  MarketEvent,
  TickerEvent,
  TradeEvent,
} from '@cip/exchange-adapters';
import {
  BinanceBookSync,
  type BookMetrics,
  CoinbaseBookSync,
  DelayTracker,
  detectionParams,
  HeartbeatTradeCheck,
  KlineCandleAssembler,
  LargeTradeDetector,
  type OrderBook,
  RunningCandles,
  SequenceTracker,
  type TakerOrder,
  TakerOrderGrouper,
  TradeCandleBuilder,
  WallDetector,
  type WallEvent,
} from '@cip/market-data';
import type { Logger } from '@cip/observability';
import type { Detections } from './detections.js';
import type { StreamedInstrument } from './instruments.js';
import type { LivePublisher } from './live.js';
import type { BatchWriter, CandleWriter, GapRecorder, GapStream } from './writers.js';

export type FeedState = 'connected' | 'degraded' | 'disconnected';

/** Per-stream feed status (API contracts §4 FeedStatus; the API adds open gaps). */
export interface FeedStatus {
  instrumentId: string;
  stream: GapStream;
  state: FeedState;
  lastMessageAt: number | null;
  lagMsP50: number | null;
  lagMsP95: number | null;
  detail: string;
}

export interface MetricsRow {
  instrument_id: string;
  ts: Date;
  mid: string;
  spread_bps: number;
  bid_usd_10bp: number | null;
  ask_usd_10bp: number | null;
  bid_usd_50bp: number | null;
  ask_usd_50bp: number | null;
  bid_usd_100bp: number | null;
  ask_usd_100bp: number | null;
  imbalance_10bp: number | null;
  imbalance_50bp: number | null;
  imbalance_100bp: number | null;
  coverage_bps: number;
}

export interface SnapshotRow {
  instrument_id: string;
  ts: Date;
  bids: string[];
  asks: string[];
  venue_seq: string | null;
}

export interface PipelineDeps {
  instrument: StreamedInstrument;
  candles: CandleWriter;
  trades: BatchWriter<NewTrade>;
  metrics: BatchWriter<MetricsRow>;
  snapshots: BatchWriter<SnapshotRow>;
  gaps: GapRecorder;
  redis: Redis;
  log: Logger;
  closed: (start: number, end: number) => boolean;
  profileBuckets: number;
  fetchDepthSnapshot?: (symbol: string) => Promise<BookSnapshotEvent>;
  /** Live channel output; omitted in tests that only check storage. */
  live?: LivePublisher;
  /** Exchange-flow detection output; omitted (or a reference instrument) means no detection. */
  detections?: Detections;
  /** USD per unit of the quote currency: USDT-USD for USDT pairs, "1" for USD pairs. */
  usdPerQuote?: () => string;
  /** Venue time − local time (ms), so feed lag measures delay rather than this host's clock error. */
  clockOffset?: () => number;
}

/** Streams whose silence means trouble; quiet trade streams are normal on thin markets. */
const SILENCE_MS: Record<GapStream, number> = {
  kline: 30_000,
  ticker: 30_000,
  trades: 30_000,
  depth: 5 * 60_000,
};

const NO_LIVE = { publish: () => undefined } as unknown as LivePublisher;

/** Maximum live rates (architecture §10): book 10 Hz, ticker 4 Hz. */
const BOOK_INTERVAL_MS = 100;
const TICKER_INTERVAL_MS = 250;

/**
 * Everything that happens to one instrument's live data: candles, trades, book, ticker, gaps,
 * exchange-flow detection, live channels and feed health. Candle writes are chained so they reach
 * the database strictly in order; detection writes likewise.
 */
export abstract class InstrumentPipeline {
  protected readonly lastMessage = new Map<GapStream, number>();
  protected readonly delay = new DelayTracker();
  protected ticker: TickerEvent | null = null;
  protected connected = false;
  protected readonly running = new RunningCandles();
  private readonly live: LivePublisher;
  private readonly grouper = new TakerOrderGrouper();
  readonly largeTrades: LargeTradeDetector | null;
  private readonly walls: WallDetector | null;
  private readonly wallIds = new Map<string, string>();
  private disconnectedAt: number | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private detectionWrites: Promise<unknown> = Promise.resolve();
  private lastTrade: { price: string; ts: number } | null = null;
  private lastSnapshotAt = 0;
  private publishedBook = -1;
  private publishedTicker = '';
  private readonly throttles = {
    book: { timer: null as ReturnType<typeof setTimeout> | null, lastAt: 0, rx: 0 },
    ticker: { timer: null as ReturnType<typeof setTimeout> | null, lastAt: 0, rx: 0 },
  };
  candlesWritten = 0;

  constructor(protected readonly deps: PipelineDeps) {
    this.live = deps.live ?? NO_LIVE;
    const detect = deps.detections !== undefined && deps.instrument.role === 'monitored';
    const params = detectionParams(deps.instrument.base);
    this.largeTrades = detect ? new LargeTradeDetector({ floorUsd: params.largeTradeFloorUsd }) : null;
    this.walls = detect ? new WallDetector(params.walls) : null;
  }

  get instrument(): StreamedInstrument {
    return this.deps.instrument;
  }

  abstract onEvent(event: MarketEvent): void;
  protected abstract get book(): OrderBook;
  /** The 1m candle in progress, for `candle.update`. */
  protected abstract inProgress(now: number): Candle | null;
  /** Streams this venue's health is judged on. */
  protected abstract readonly watched: GapStream[];

  /**
   * The venue's clock: local time plus the measured offset. Minute boundaries (closing a candle,
   * a kline that is overdue) are decided on it, because trades and klines carry venue times. On a
   * host whose clock runs ahead, local time would close minutes before they end and drop the
   * last trades as late.
   */
  protected venueTime(now: number): number {
    return now + (this.deps.clockOffset?.() ?? 0);
  }

  /** Folds stored minutes of the current day into the candles in progress (after a start). */
  seedRunning(minutes: readonly Candle[]): void {
    for (const m of minutes) this.running.onMinuteClosed(m);
  }

  protected seen(stream: GapStream, event: { ts: number; receivedAt: number }): void {
    this.lastMessage.set(stream, event.receivedAt);
    this.delay.add(event.ts, event.receivedAt + (this.deps.clockOffset?.() ?? 0));
    if (stream === 'depth') this.schedule('book', event.receivedAt);
    else this.schedule('ticker', event.receivedAt);
  }

  /**
   * Live output at each channel's maximum rate, leading edge: an update after a quiet interval goes
   * out at once (after the current message is applied); faster updates wait for the next slot and
   * only the latest state is sent. The envelope's `ts` is when the newest venue message it contains
   * was received, so delivery latency (NFR-01) can be measured end to end.
   */
  private schedule(kind: 'book' | 'ticker', receivedAt: number): void {
    if (!this.deps.live) return;
    const t = this.throttles[kind];
    t.rx = Math.max(t.rx, receivedAt);
    if (t.timer) return;
    const interval = kind === 'book' ? BOOK_INTERVAL_MS : TICKER_INTERVAL_MS;
    t.timer = setTimeout(
      () => {
        t.timer = null;
        t.lastAt = Date.now();
        if (kind === 'book') this.publishBook(t.rx);
        else this.publishTicker(t.rx);
      },
      Math.max(0, t.lastAt + interval - Date.now()),
    );
  }

  protected writeCandle(candle: Candle): void {
    const id = this.instrument.id;
    this.running.onMinuteClosed(candle);
    this.writes = this.writes
      .then(() => this.deps.candles.writeMinute(id, candle))
      .then((written) => {
        this.candlesWritten++;
        for (const c of written)
          this.live.publish(channels.candles(id, c.timeframe), 'candle.closed', toWireCandle(c));
      })
      .catch((err: unknown) =>
        this.deps.log.error({ err, instrumentId: id, openTime: candle.openTime }, 'candle write failed'),
      );
  }

  protected gap(
    stream: GapStream,
    from: number,
    to: number | null,
    detectedBy: 'sequence' | 'heartbeat' | 'timer' | 'reconnect',
    details?: Record<string, unknown>,
  ): void {
    void this.deps.gaps.record({
      instrumentId: this.instrument.id,
      stream,
      from,
      to,
      detectedBy,
      ...(details ? { details } : {}),
    });
  }

  /** Every new (non-duplicate) trade: raw storage, last price, walls and large-trade grouping. */
  protected onTrade(t: TradeEvent): void {
    if (this.instrument.storeRawTrades)
      this.deps.trades.add({
        instrument_id: this.instrument.id,
        ts: new Date(t.ts),
        trade_id: t.tradeId,
        price: t.price,
        qty: t.qty,
        taker_side: t.takerSide,
        taker_order_ref: t.takerOrderRef,
        received_at: new Date(t.receivedAt),
      });
    if (!this.lastTrade || t.ts >= this.lastTrade.ts) this.lastTrade = { price: t.price, ts: t.ts };
    this.walls?.onTrade(t);
    if (this.largeTrades) this.observeOrder(this.grouper.add(t));
  }

  private usdPerQuote(): string {
    return this.deps.usdPerQuote?.() ?? '1';
  }

  private observeOrder(order: TakerOrder | null): void {
    if (!order || !this.largeTrades) return;
    const large = this.largeTrades.observe(order, this.usdPerQuote());
    if (large) this.detect((d) => d.largeTrade(this.instrument.id, large));
  }

  private detect(write: (d: Detections) => Promise<unknown>): void {
    const detections = this.deps.detections;
    if (!detections) return;
    this.detectionWrites = this.detectionWrites
      .then(() => write(detections))
      .catch((err: unknown) =>
        this.deps.log.error({ err, instrumentId: this.instrument.id }, 'detection write failed'),
      );
  }

  private onWallEvents(events: readonly WallEvent[]): void {
    const id = this.instrument.id;
    for (const e of events) {
      const key = `${e.wall.side}:${e.wall.price}`;
      if (e.kind === 'appeared')
        this.detect(async (d) => {
          this.wallIds.set(key, await d.wallAppeared(id, e.wall));
        });
      else
        this.detect(async (d) => {
          const wallId = this.wallIds.get(key);
          this.wallIds.delete(key);
          if (wallId) await d.wallEnded(id, wallId, e.wall, e.reason);
        });
    }
  }

  /** The local book was discarded (resync or disconnect): standing walls ended for unknown reasons. */
  protected bookLost(now: number): void {
    if (this.walls) this.onWallEvents(this.walls.endAll(now, 'unknown'));
  }

  onConnectionOpen(now: number): void {
    this.connected = true;
    const first = this.disconnectedAt === null;
    if (this.disconnectedAt !== null) {
      this.gap('trades', this.disconnectedAt, now, 'reconnect');
      this.disconnectedAt = null;
    }
    this.afterReconnect(now, first);
  }

  onConnectionClosed(now: number): void {
    if (this.connected) this.disconnectedAt = Math.max(...this.lastMessage.values(), now - 1);
    this.connected = false;
    this.observeOrder(this.grouper.reset());
    this.bookLost(now);
  }

  /** The instrument stopped streaming (disabled, halted or delisted). */
  close(now: number): void {
    for (const t of Object.values(this.throttles)) if (t.timer) clearTimeout(t.timer);
    this.observeOrder(this.grouper.reset());
    this.bookLost(now);
  }

  /** The connection opened: `first` when no outage gap was recorded (the first connection). */
  protected abstract afterReconnect(now: number, first: boolean): void;

  /**
   * 1 Hz: completed taker orders, wall scan, candles in progress, book metrics, 10 s snapshots, and
   * the latest ticker and book in Redis for REST and subscribe snapshots.
   */
  async tick(now: number): Promise<void> {
    const id = this.instrument.id;
    this.observeOrder(this.grouper.flush(now));
    if (this.walls) this.onWallEvents(this.walls.scan(this.book, now, Number(this.usdPerQuote())));
    const venueNow = this.venueTime(now);
    for (const c of Object.values(this.running.current(this.inProgress(venueNow), venueNow)))
      this.live.publish(channels.candles(id, c.timeframe), 'candle.update', toWireCandle(c), now);

    // Only a live book is measured and served: during an outage the last known book and ticker
    // must expire from Redis (REST then answers "not streaming") rather than be refreshed as if live.
    const depthAt = this.lastMessage.get('depth');
    const bookLive = this.connected && depthAt !== undefined && now - depthAt <= SILENCE_MS.depth;
    const metrics = bookLive ? this.book.metrics() : null;
    if (metrics) {
      this.deps.metrics.add(metricsRow(id, now, metrics));
      if (now - this.lastSnapshotAt >= 10_000) {
        this.lastSnapshotAt = now;
        const top = this.book.top(50);
        this.deps.snapshots.add({
          instrument_id: id,
          ts: new Date(floorTo(now, '1m') + Math.floor((now % MINUTE_MS) / 1000) * 1000),
          bids: top.bids.flat(),
          asks: top.asks.flat(),
          venue_seq: null,
        });
      }
      await this.deps.redis.set(`book:${id}`, JSON.stringify(this.bookSnapshot(now, metrics)), 'PX', 30_000);
    }
    const ticker = this.connected ? this.currentTicker() : null;
    if (ticker) await this.deps.redis.set(`ticker:${id}`, JSON.stringify(ticker), 'PX', 60_000);
  }

  /** The top 50 levels on `book:{id}` when the book has changed; `rx`: newest message received. */
  publishBook(rx: number): void {
    const version = this.book.version;
    if (version === this.publishedBook) return;
    const metrics = this.book.metrics();
    if (!metrics) return;
    this.publishedBook = version;
    this.live.publish(channels.book(this.instrument.id), 'book.snapshot', this.bookSnapshot(rx, metrics), rx);
  }

  /** The ticker on `ticker:{id}` when it has changed; `rx`: newest message received. */
  publishTicker(rx: number): void {
    const t = this.currentTicker();
    if (!t) return;
    const key = `${t.last}|${t.bid}|${t.ask}|${t.volume24hQuote}`;
    if (key === this.publishedTicker) return;
    this.publishedTicker = key;
    this.live.publish(channels.ticker(this.instrument.id), 'ticker', t, rx);
  }

  private bookSnapshot(now: number, metrics: BookMetrics): BookSnapshot {
    const top = this.book.top(50);
    return {
      instrumentId: this.instrument.id,
      ts: now,
      bids: top.bids,
      asks: top.asks,
      coverageBps: metrics.coverageBps,
    };
  }

  /**
   * The venue ticker, kept current between ticker messages: the latest trade price and the local
   * book's best prices when they are newer (Binance sends its ticker once a second).
   */
  currentTicker(): Ticker | null {
    const tk = this.ticker;
    const trade = this.lastTrade;
    if (!tk && !trade) return null;
    const last = trade && (!tk || trade.ts >= tk.ts) ? trade.price : tk!.last;
    const top = this.book.top(1);
    const open = tk ? Number(tk.open24h) : 0;
    return {
      instrumentId: this.instrument.id,
      ts: Math.max(tk?.ts ?? 0, trade?.ts ?? 0),
      last,
      bid: top.bids[0]?.[0] ?? tk?.bid ?? last,
      ask: top.asks[0]?.[0] ?? tk?.ask ?? last,
      change24hPct: open > 0 ? ((Number(last) - open) / open) * 100 : (tk?.change24hPct ?? 0),
      volume24hQuote: tk?.volume24hQuote ?? '0',
    };
  }

  /** The book's mid while the connection is up and the depth stream is not silent (spread input). */
  mid(now: number): number | null {
    const depthAt = this.lastMessage.get('depth');
    if (!this.connected || depthAt === undefined || now - depthAt > SILENCE_MS.depth) return null;
    return this.book.mid();
  }

  status(now: number): FeedStatus[] {
    return this.watched.map((stream) => {
      const last = this.lastMessage.get(stream) ?? null;
      const silent = last === null || now - last > SILENCE_MS[stream];
      const delayed = this.delay.delayed(now);
      const state: FeedState = !this.connected
        ? 'disconnected'
        : silent || delayed
          ? 'degraded'
          : 'connected';
      return {
        instrumentId: this.instrument.id,
        stream,
        state,
        lastMessageAt: last,
        lagMsP50: this.delay.percentile(50, now),
        lagMsP95: this.delay.percentile(95, now),
        detail: !this.connected ? 'disconnected' : silent ? 'no messages' : delayed ? 'delayed' : 'streaming',
      };
    });
  }
}

function metricsRow(instrumentId: string, now: number, m: BookMetrics): MetricsRow {
  return {
    instrument_id: instrumentId,
    ts: new Date(Math.floor(now / 1000) * 1000),
    mid: String(m.mid),
    spread_bps: m.spreadBps,
    bid_usd_10bp: m.bidUsd10bp,
    ask_usd_10bp: m.askUsd10bp,
    bid_usd_50bp: m.bidUsd50bp,
    ask_usd_50bp: m.askUsd50bp,
    bid_usd_100bp: m.bidUsd100bp,
    ask_usd_100bp: m.askUsd100bp,
    imbalance_10bp: m.imbalance10bp,
    imbalance_50bp: m.imbalance50bp,
    imbalance_100bp: m.imbalance100bp,
    coverage_bps: m.coverageBps,
  };
}

/** Binance: kline-authoritative candles, aggTrade sequence checks, snapshot + diff book. */
export class BinancePipeline extends InstrumentPipeline {
  private readonly assembler: KlineCandleAssembler;
  private readonly sync = new BinanceBookSync();
  private readonly tradeSeq = new SequenceTracker();
  private readonly fillsByMinute = new Map<number, number>();
  private lastFinalOpen: number | null = null;
  /** Minutes before this are stored or covered by a recorded gap, so none is reported twice. */
  private klineCovered: number | null = null;
  private liveKline: KlineEvent | null = null;
  private snapshotInFlight = false;
  private lastSnapshotRequest = 0;
  private lastRefresh = 0;
  protected readonly watched: GapStream[] = ['kline', 'trades', 'depth', 'ticker'];

  constructor(deps: PipelineDeps) {
    super(deps);
    this.assembler = new KlineCandleAssembler({ profileBuckets: deps.profileBuckets, closed: deps.closed });
  }

  protected get book(): OrderBook {
    return this.sync.book;
  }

  protected inProgress(now: number): Candle | null {
    const k = this.liveKline;
    return k && k.openTime === floorTo(now, '1m') ? this.assembler.inProgress(k) : null;
  }

  onEvent(e: MarketEvent): void {
    switch (e.type) {
      case 'trade': {
        this.seen('trades', e);
        const s = this.tradeSeq.observe(e.seq);
        if (s.kind === 'gap')
          this.gap('trades', e.ts - 1, e.ts, 'sequence', {
            missingFrom: s.missingFrom,
            missingTo: s.missingTo,
          });
        if (s.kind === 'duplicate') return;
        const minute = floorTo(e.ts, '1m');
        this.fillsByMinute.set(
          minute,
          (this.fillsByMinute.get(minute) ?? 0) + (e.fills ? e.fills.last - e.fills.first + 1 : 1),
        );
        this.assembler.addTrade(e);
        this.onTrade(e);
        return;
      }
      case 'kline': {
        this.seen('kline', e);
        if (!e.final) {
          this.liveKline = e;
          return;
        }
        if (this.klineCovered !== null && e.openTime > this.klineCovered) {
          this.gap('kline', this.klineCovered, e.openTime, 'sequence');
        }
        if (this.lastFinalOpen !== null && e.openTime <= this.lastFinalOpen) return;
        this.lastFinalOpen = e.openTime;
        this.klineCovered = Math.max(this.klineCovered ?? 0, e.openTime + MINUTE_MS);
        const fills = this.fillsByMinute.get(e.openTime) ?? 0;
        for (const key of this.fillsByMinute.keys()) if (key <= e.openTime) this.fillsByMinute.delete(key);
        this.writeCandle(this.assembler.onFinalKline(e, () => fills));
        return;
      }
      case 'book_delta': {
        this.seen('depth', e);
        const outcome = this.sync.onDelta({
          firstUpdateId: e.firstUpdateId!,
          lastUpdateId: e.lastUpdateId!,
          bids: e.bids,
          asks: e.asks,
        });
        if (outcome.kind === 'resync') {
          this.gap('depth', e.ts, null, 'sequence', { reason: outcome.reason });
          this.bookLost(e.receivedAt);
          this.requestSnapshot(e.receivedAt);
        } else if (this.sync.status === 'awaiting_snapshot') {
          this.requestSnapshot(e.receivedAt);
        }
        return;
      }
      case 'ticker':
        this.seen('ticker', e);
        this.ticker = e;
        return;
      default:
        return;
    }
  }

  private requestSnapshot(now: number): void {
    const fetchSnapshot = this.deps.fetchDepthSnapshot;
    if (!fetchSnapshot || this.snapshotInFlight || now - this.lastSnapshotRequest < 5_000) return;
    this.snapshotInFlight = true;
    this.lastSnapshotRequest = now;
    // Give the diff stream a moment to buffer events that precede the snapshot.
    setTimeout(() => {
      fetchSnapshot(this.instrument.venueSymbol)
        .then((s) => {
          const outcome = this.sync.onSnapshot({ lastUpdateId: s.lastUpdateId!, bids: s.bids, asks: s.asks });
          if (outcome.kind === 'resync')
            this.deps.log.warn(
              { symbol: this.instrument.venueSymbol, reason: outcome.reason },
              'book resync needed',
            );
        })
        .catch((err: unknown) =>
          this.deps.log.warn({ err, symbol: this.instrument.venueSymbol }, 'depth snapshot failed'),
        )
        .finally(() => {
          this.snapshotInFlight = false;
        });
    }, 500).unref();
  }

  /**
   * Missing candle close (architecture §5.4): a minute whose final kline has not arrived 10 s after
   * its boundary plus the 2 s grace is recorded as a gap and backfilled, even while the stream is
   * silent, rather than when (if) it resumes.
   */
  override async tick(now: number): Promise<void> {
    this.refreshIfNarrow(now);
    const overdueEnd = floorTo(this.venueTime(now) - MINUTE_MS - KLINE_DUE_MS, '1m') + MINUTE_MS;
    if (this.connected && this.klineCovered !== null && overdueEnd > this.klineCovered) {
      this.gap('kline', this.klineCovered, overdueEnd, 'timer', { reason: 'missing candle close' });
      this.klineCovered = overdueEnd;
    }
    await super.tick(now);
  }

  /**
   * A Binance snapshot covers the best 5,000 levels; as the price moves, the complete range on one
   * side shrinks. Below ±1% plus a margin, a new snapshot is merged in the background (at most every
   * 2 minutes), so the ±1% depth band stays known without interrupting the live book or its walls.
   */
  private refreshIfNarrow(now: number): void {
    const fetchSnapshot = this.deps.fetchDepthSnapshot;
    const coverage = this.sync.book.coverage();
    if (
      !fetchSnapshot ||
      this.sync.status !== 'synced' ||
      this.sync.refreshing ||
      coverage === null ||
      coverage >= REFRESH_BELOW_BPS ||
      now - this.lastRefresh < REFRESH_EVERY_MS
    )
      return;
    this.lastRefresh = now;
    this.sync.beginRefresh();
    setTimeout(() => {
      fetchSnapshot(this.instrument.venueSymbol)
        .then((s) => {
          const outcome = this.sync.onRefreshSnapshot({
            lastUpdateId: s.lastUpdateId!,
            bids: s.bids,
            asks: s.asks,
          });
          this.deps.log.debug(
            { symbol: this.instrument.venueSymbol, outcome: outcome.kind, coverage },
            'book coverage refreshed',
          );
        })
        .catch((err: unknown) => {
          this.sync.onRefreshSnapshot({ lastUpdateId: -1, bids: [], asks: [] });
          this.deps.log.warn({ err, symbol: this.instrument.venueSymbol }, 'book refresh failed');
        });
    }, 500).unref();
  }

  protected afterReconnect(now: number): void {
    this.sync.reset();
    this.tradeSeq.reset();
    this.liveKline = null;
    // The reconnect gap's backfill covers the outage up to this minute, which the venue's kline completes.
    if (this.klineCovered !== null) this.klineCovered = Math.max(this.klineCovered, floorTo(now, '1m'));
  }
}

/** Refresh the Binance book when its complete range falls below ±1.1% (the ±1% band plus a margin). */
const REFRESH_BELOW_BPS = 110;
const REFRESH_EVERY_MS = 2 * 60_000;

/** A final kline is due this long after its minute's boundary: 2 s grace plus 10 s (architecture §5.4). */
const KLINE_DUE_MS = 12_000;

/** Coinbase: candles built from trades, trade_id and heartbeat checks, channel-snapshot book. */
export class CoinbasePipeline extends InstrumentPipeline {
  private builder: TradeCandleBuilder;
  private readonly sync = new CoinbaseBookSync();
  private readonly tradeSeq = new SequenceTracker();
  private readonly heartbeat = new HeartbeatTradeCheck();
  protected readonly watched: GapStream[] = ['trades', 'depth', 'ticker'];

  constructor(deps: PipelineDeps, start: { nextOpen: number; lastClose: string | null }) {
    super(deps);
    this.builder = this.newBuilder(start);
  }

  private newBuilder(start: { nextOpen: number; lastClose: string | null }): TradeCandleBuilder {
    return new TradeCandleBuilder(
      { profileBuckets: this.deps.profileBuckets, graceMs: 2_000, closed: this.deps.closed },
      start,
    );
  }

  protected get book(): OrderBook {
    return this.sync.book;
  }

  protected inProgress(now: number): Candle | null {
    return this.builder.inProgress(now);
  }

  onEvent(e: MarketEvent): void {
    switch (e.type) {
      case 'trade': {
        this.seen('trades', e);
        const s = this.tradeSeq.observe(e.seq);
        if (s.kind === 'gap')
          this.gap('trades', e.ts - 1, e.ts, 'sequence', {
            missingFrom: s.missingFrom,
            missingTo: s.missingTo,
          });
        if (s.kind === 'duplicate') return;
        this.builder.addTrade(e);
        this.onTrade(e);
        return;
      }
      case 'heartbeat': {
        this.seen('trades', e);
        // Coinbase sends ticker messages only when the product trades: on a thin product the
        // heartbeat is what shows the subscription is alive (architecture §5.4: "no message or heartbeat").
        this.lastMessage.set('ticker', e.receivedAt);
        const h = this.heartbeat.onHeartbeat(e.lastTradeId, this.tradeSeq.lastSeen);
        if (h.kind === 'gap')
          this.gap('trades', e.ts - 2_000, e.ts, 'heartbeat', {
            missingFrom: h.missingFrom,
            missingTo: h.missingTo,
          });
        return;
      }
      case 'book_snapshot':
        this.seen('depth', e);
        this.sync.onSnapshot(e.bids, e.asks);
        return;
      case 'book_delta': {
        this.seen('depth', e);
        const outcome = this.sync.onDelta(e.bids, e.asks);
        if (outcome.kind === 'resync') {
          this.gap('depth', e.ts, null, 'sequence', { reason: outcome.reason });
          this.bookLost(e.receivedAt);
        }
        return;
      }
      case 'ticker':
        this.seen('ticker', e);
        this.ticker = e;
        this.builder.primeClose(e.last);
        return;
      default:
        return;
    }
  }

  override async tick(now: number): Promise<void> {
    for (const candle of this.builder.finalize(this.venueTime(now))) this.writeCandle(candle);
    await super.tick(now);
  }

  /** Trades that arrived after their minute was final (counted, never applied: published candles do not change). */
  get lateTrades(): number {
    return this.builder.lateTrades;
  }

  protected afterReconnect(now: number, first: boolean): void {
    // Minutes during the outage are unknown, not empty: rebuild from the next full minute and let
    // the recorded gap's backfill fill them from REST.
    const resume = floorTo(this.venueTime(now), '1m') + MINUTE_MS;
    // The first connection can open after the minute the pipeline planned to build first (the
    // socket connects a few seconds after start). Those minutes were never seen, and no outage gap
    // covers them: without this they would be lost, and analysis would wait at them (ADR 005).
    if (first && resume > this.builder.next)
      this.gap('trades', this.builder.next, resume, 'reconnect', { reason: 'stream opened late' });
    const lastClose = this.ticker?.last ?? null;
    this.builder = this.newBuilder({ nextOpen: resume, lastClose });
    this.tradeSeq.reset();
    this.heartbeat.reset();
  }
}
