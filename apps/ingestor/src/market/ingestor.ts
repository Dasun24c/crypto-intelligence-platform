import type { Meter } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import {
  floorTo,
  HISTORY_CANDLES,
  MINUTE_MS,
  restSettledAt,
  TF_MS,
  type Timeframe,
  type VenueId,
} from '@cip/domain';
import type { Database, NewTrade } from '@cip/db';
import {
  BinanceVenue,
  CoinbaseVenue,
  type MarketEvent,
  type RecordedLine,
  ReplayVenue,
  type SocketStatus,
  type Unparsed,
} from '@cip/exchange-adapters';
import type { HeartbeatProbe, Logger } from '@cip/observability';
import { CONFIG_CHANNELS } from '@cip/contracts';
import { NOTIONAL_BIN_RATIO } from '@cip/market-data';
import { Detections } from './detections.js';
import { ClosureCalendar, loadInstruments, type StreamedInstrument } from './instruments.js';
import { LivePublisher } from './live.js';
import {
  BinancePipeline,
  CoinbasePipeline,
  type FeedStatus,
  type InstrumentPipeline,
  type MetricsRow,
  type SnapshotRow,
} from './pipelines.js';
import { decimal, SPREAD_BASES, SpreadMonitor, spreadLegs } from './spread.js';
import { BatchWriter, CandleWriter, GapRecorder, publishEvent } from './writers.js';

type StreamVenue = 'binance' | 'coinbase' | 'replay';
/** Health warning above this clock offset (architecture §5.4). */
const CLOCK_WARN_MS = 500;

/**
 * Timeframes whose warm-up the stored 1m history may not cover. Seven days of 1m (BACKFILL_DAYS)
 * aggregate to 2,016 5m candles but only 672 15m, 168 1h, 42 4h and 7 1d candles, short of
 * HISTORY_CANDLES; a shorter 1m history leaves 5m short too. Whatever falls short is fetched at its
 * own timeframe (a timeframe whose history already reaches back far enough records no gap).
 */
export const DEEP_HISTORY_TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

/**
 * Candles of deep history to keep per timeframe: HISTORY_CANDLES plus a 10% margin, so a run that
 * starts a little later, or a venue that omits a few early periods, still leaves enough.
 */
export const DEEP_HISTORY_CANDLES = HISTORY_CANDLES + Math.ceil(HISTORY_CANDLES / 10);

export interface MarketIngestorOptions {
  db: Kysely<Database>;
  redis: Redis;
  redisUrl: string;
  log: Logger;
  meter: Meter;
  instance: string;
  queuePrefix: string;
  profileBuckets: number;
  /** History to request on first start when an instrument has no candles yet (MD-03). */
  backfillDays: number;
  venueOverrides?: {
    binance?: ConstructorParameters<typeof BinanceVenue>[1];
    coinbase?: ConstructorParameters<typeof CoinbaseVenue>[1];
  };
  /** Live venues, or recordings played by the replay venue (tests, CI, demos). Default live. */
  source?:
    | { kind: 'live' }
    | {
        kind: 'replay';
        recordings: readonly (readonly RecordedLine[])[];
        /** Test only: loops shorter than a minute. */
        periodMs?: number;
      };
}

/** One active ingestor per venue (architecture §6 leases): 15 s TTL, renewed every 5 s. */
class VenueLease {
  private static readonly RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
  held = false;

  constructor(
    private readonly redis: Redis,
    private readonly venue: VenueId,
    private readonly instance: string,
  ) {}

  async refresh(): Promise<boolean> {
    const key = `lease:ingestor:${this.venue}`;
    if (this.held)
      this.held = (await this.redis.eval(VenueLease.RENEW, 1, key, this.instance, '15000')) === 1;
    if (!this.held) this.held = (await this.redis.set(key, this.instance, 'PX', 15_000, 'NX')) === 'OK';
    return this.held;
  }

  async release(): Promise<void> {
    if (this.held)
      await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        `lease:ingestor:${this.venue}`,
        this.instance,
      );
    this.held = false;
  }
}

/**
 * The ingestor (architecture §3, §5): live public streams from both venues routed to one pipeline per
 * instrument, final candles stored and announced, trades, book metrics and snapshots batched, gaps
 * recorded and queued for backfill, feed health published for System Health.
 */
export class MarketIngestor {
  private readonly pipelines = new Map<string, InstrumentPipeline>(); // `${venue}:${symbol}`
  private readonly candles: CandleWriter;
  private readonly gaps: GapRecorder;
  private readonly trades: BatchWriter<NewTrade>;
  private readonly metrics: BatchWriter<MetricsRow>;
  private readonly snapshots: BatchWriter<SnapshotRow>;
  private readonly closures = new ClosureCalendar();
  private readonly leases: Record<StreamVenue, VenueLease>;
  private readonly venueState: Record<StreamVenue, SocketStatus> = {
    binance: 'closed',
    coinbase: 'closed',
    replay: 'closed',
  };
  /** The venues this instance streams: Binance and Coinbase, or the replay venue alone. */
  private readonly venues: readonly StreamVenue[];
  private replay: ReplayVenue | null = null;
  /** Venue time − local time, measured every 5 minutes against Binance (architecture §5.4). */
  private clock: { offsetMs: number; rttMs: number; measuredAt: number } | null = null;
  private readonly backfillQueue: Queue;
  private readonly queueConnection: Redis;
  private readonly subscriber: Redis;
  private readonly live: LivePublisher;
  private readonly detections: Detections;
  private readonly spreads: { base: string; monitor: SpreadMonitor }[];
  private syncing: Promise<void> = Promise.resolve();
  private binance!: BinanceVenue;
  private coinbase!: CoinbaseVenue;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastStatus = new Map<string, string>();
  private unparsed = 0;
  private eventsSeen = 0;

  constructor(private readonly o: MarketIngestorOptions) {
    this.queueConnection = new Redis(o.redisUrl, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-ingestor-queue',
    });
    this.backfillQueue = new Queue('backfill', { connection: this.queueConnection, prefix: o.queuePrefix });
    this.subscriber = new Redis(o.redisUrl, { connectionName: 'cip-ingestor-config', lazyConnect: true });
    this.live = new LivePublisher(o.redis, o.log);
    this.detections = new Detections(o.db, o.redis, o.log);
    this.spreads = SPREAD_BASES.map((base) => ({
      base,
      monitor: new SpreadMonitor(base, o.db, this.live, o.log),
    }));
    this.candles = new CandleWriter(o.db, o.redis, o.log);
    this.gaps = new GapRecorder(o.db, o.redis, o.log, (gap) =>
      this.backfillQueue
        .add('gap', gap, {
          jobId: `backfill:${gap.instrumentId}:${gap.id}`,
          // A gap that ends at the next minute boundary is repaired once that minute has settled.
          delay: Math.max(0, restSettledAt(gap.to) - Date.now()),
          attempts: 8,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        })
        .then(() => undefined),
    );
    this.trades = new BatchWriter(
      (rows) =>
        o.db
          .insertInto('market.trades')
          .values(rows)
          .onConflict((oc) => oc.doNothing())
          .execute()
          .then(() => undefined),
      o.log,
      'trades',
    );
    this.metrics = new BatchWriter(
      (rows) =>
        o.db
          .insertInto('market.orderbook_metrics')
          .values(rows)
          .onConflict((oc) => oc.doNothing())
          .execute()
          .then(() => undefined),
      o.log,
      'book metrics',
    );
    this.snapshots = new BatchWriter(
      (rows) =>
        o.db
          .insertInto('market.orderbook_snapshots')
          .values(rows)
          .onConflict((oc) => oc.doNothing())
          .execute()
          .then(() => undefined),
      o.log,
      'book snapshots',
      5_000,
    );
    this.leases = {
      binance: new VenueLease(o.redis, 'binance', o.instance),
      coinbase: new VenueLease(o.redis, 'coinbase', o.instance),
      replay: new VenueLease(o.redis, 'replay', o.instance),
    };
    this.venues = o.source?.kind === 'replay' ? ['replay'] : ['binance', 'coinbase'];
    const events = o.meter.createCounter('cip_ingest_messages_total', {
      description: 'Venue messages processed',
    });
    this.countEvent = (venue: string) => events.add(1, { venue });
  }

  private readonly countEvent: (venue: string) => void;

  async start(): Promise<void> {
    const now = Date.now();
    await this.closures.refresh(this.o.db, now);
    this.binance = new BinanceVenue(this.hooks('binance'), this.o.venueOverrides?.binance);
    this.coinbase = new CoinbaseVenue(this.hooks('coinbase'), this.o.venueOverrides?.coinbase);
    if (this.o.source?.kind === 'replay')
      this.replay = new ReplayVenue(this.hooks('replay'), {
        recordings: this.o.source.recordings,
        ...(this.o.source.periodMs ? { periodMs: this.o.source.periodMs } : {}),
      });
    for (const w of [this.trades, this.metrics, this.snapshots]) w.start();
    await this.renewLeases(false);
    if (!this.replay) {
      await this.measureClock();
      this.timers.push(setInterval(() => void this.measureClock(), 5 * 60_000));
    }
    await this.syncInstruments();
    // Admin changes take effect at once (MD-02); the 60 s sync is the fallback.
    await this.subscriber.connect();
    await this.subscriber.subscribe(CONFIG_CHANNELS.instruments, CONFIG_CHANNELS.closures);
    this.subscriber.on('message', (channel: string) => {
      if (channel === CONFIG_CHANNELS.instruments) void this.syncInstruments();
      if (channel === CONFIG_CHANNELS.closures)
        void this.closures
          .refresh(this.o.db, Date.now())
          .catch((err: unknown) => this.o.log.warn({ err }, 'closure refresh failed'));
    });
    this.timers.push(setInterval(() => void this.renewLeases(true), 5_000));
    this.timers.push(setInterval(() => void this.tick(), 1_000));
    this.timers.push(setInterval(() => void this.syncInstruments(), 60_000));
    this.timers.push(
      setInterval(
        () =>
          void this.closures
            .refresh(this.o.db, Date.now())
            .catch((err: unknown) => this.o.log.warn({ err }, 'closure refresh failed')),
        3_600_000,
      ),
    );
    this.timers.push(setInterval(() => void this.publishStatus(), 2_000));
    for (const t of this.timers) t.unref();
  }

  private hooks(venue: StreamVenue) {
    return {
      onEvent: (e: MarketEvent) => {
        this.eventsSeen++;
        this.countEvent(venue);
        // Replayed events keep their recorded format (binance/coinbase); they belong to replay instruments.
        this.pipelines.get(`${venue}:${e.symbol}`)?.onEvent(e);
      },
      onUnparsed: (u: Unparsed) => {
        this.unparsed++;
        if (this.unparsed % 100 === 1) this.o.log.warn({ venue, reason: u.reason }, 'unparsed venue message');
      },
      onStatus: (status: SocketStatus, detail: string) => this.onVenueStatus(venue, status, detail),
    };
  }

  private onVenueStatus(venue: StreamVenue, status: SocketStatus, detail: string): void {
    const previous = this.venueState[venue];
    this.venueState[venue] = status;
    const now = Date.now();
    for (const p of this.pipelines.values()) {
      if (p.instrument.venue !== venue) continue;
      if (status === 'open') p.onConnectionOpen(now);
      if (status === 'closed') p.onConnectionClosed(now);
    }
    if (status !== previous) {
      const event = status === 'open' ? 'connected' : status === 'closed' ? 'disconnected' : 'reconnecting';
      this.o.log.info({ venue, status, detail }, 'venue connection');
      void this.o.db
        .insertInto('market.feed_events')
        .values({ ts: new Date(now), venue_id: venue, instrument_id: null, event, details: { detail } })
        .execute()
        .catch((err: unknown) => this.o.log.warn({ err }, 'feed event insert failed'));
    }
  }

  /**
   * Loads instruments, adds and removes pipelines, and (re)subscribes each venue we hold a lease for.
   * Calls are serialised, so a reload announced while one is running cannot interleave with it.
   */
  syncInstruments(): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync());
    return this.syncing;
  }

  /**
   * One active ingestor per venue (architecture §6): the lease has a 15 s TTL and is renewed every
   * 5 s. Only the holder has pipelines for that venue, so a standby never writes candles, gaps or
   * live messages. Winning or losing a lease resynchronises at once.
   */
  private async renewLeases(syncOnChange: boolean): Promise<void> {
    let changed = false;
    for (const venue of this.venues) {
      const before = this.leases[venue].held;
      let held = false;
      try {
        held = await this.leases[venue].refresh();
      } catch (err) {
        this.o.log.warn({ err, venue }, 'lease renewal failed');
        this.leases[venue].held = false;
      }
      if (held === before) continue;
      changed = true;
      this.o.log.info({ venue, held }, held ? 'venue lease acquired' : 'venue lease lost');
      if (held) await this.closeStaleWalls(venue);
    }
    if (changed && syncOnChange) await this.syncInstruments();
  }

  private async measureClock(): Promise<void> {
    try {
      const sample = await this.binance.clockOffset();
      this.clock = { ...sample, measuredAt: Date.now() };
      if (Math.abs(sample.offsetMs) > CLOCK_WARN_MS)
        this.o.log.warn(sample, 'local clock is off venue time: run time synchronisation (chrony/NTP)');
    } catch (err) {
      this.o.log.warn({ err }, 'clock offset measurement failed');
      // Without any measurement, minutes close on the local clock (and lag is skewed by its error)
      // until the next 5-minute round: try again soon instead. A known offset is kept until replaced.
      if (this.clock === null) this.timers.push(setTimeout(() => void this.measureClock(), 15_000));
    }
  }

  /** Walls a previous holder left open can no longer be followed: they ended for unknown reasons. */
  private async closeStaleWalls(venue: StreamVenue): Promise<void> {
    await this.o.db
      .updateTable('market.orderbook_walls')
      .set({ ended_reason: 'unknown' })
      .where('ended_reason', 'is', null)
      .where('instrument_id', 'in', (eb) =>
        eb.selectFrom('market.instruments').select('id').where('venue_id', '=', venue),
      )
      .execute()
      .catch((err: unknown) => this.o.log.warn({ err, venue }, 'could not close stale walls'));
  }

  private async doSync(): Promise<void> {
    try {
      const instruments = (await loadInstruments(this.o.db, this.venues)).filter(
        (i) => this.leases[i.venue].held && (i.venue !== 'replay' || this.replay?.formatOf(i.venueSymbol)),
      );
      const wanted = new Map(instruments.map((i) => [`${i.venue}:${i.venueSymbol}`, i]));
      for (const [key, p] of this.pipelines)
        if (!wanted.has(key)) {
          p.close(Date.now());
          this.pipelines.delete(key);
          // A stopped feed must not leave its last price behind as if it were live.
          await this.o.redis.del(`ticker:${p.instrument.id}`, `book:${p.instrument.id}`);
          this.o.log.info(
            { instrument: p.instrument.venueSymbol, venue: p.instrument.venue },
            'pipeline removed',
          );
        }
      for (const [key, inst] of wanted)
        if (!this.pipelines.has(key)) {
          const pipeline = await this.createPipeline(inst);
          this.pipelines.set(key, pipeline);
          // Added to an open connection (a live subscribe): it is connected from now on.
          if (this.venueState[inst.venue] === 'open') pipeline.onConnectionOpen(Date.now());
        }

      for (const venue of this.venues) {
        const symbols = instruments.filter((i) => i.venue === venue).map((i) => i.venueSymbol);
        if (venue === 'binance') this.binance.setSymbols(symbols);
        else if (venue === 'coinbase') this.coinbase.setProducts(symbols);
        else this.replay?.setSymbols(symbols);
      }
    } catch (err) {
      this.o.log.error({ err }, 'instrument sync failed');
    }
  }

  private async createPipeline(inst: StreamedInstrument): Promise<InstrumentPipeline> {
    const now = Date.now();
    // The first minute to build is decided on venue time (the measured clock offset).
    const venueNow = now + (inst.venue === 'replay' ? 0 : (this.clock?.offsetMs ?? 0));
    const nextOpen = floorTo(venueNow, '1m') + MINUTE_MS;
    const last = await this.candles.lastClose(inst.id);
    // History we have not stored yet is a gap: the backfill job fetches it from REST (MD-03).
    // The replay venue has no history to fetch.
    const from = last ? last.openTime + MINUTE_MS : floorTo(now - this.o.backfillDays * 86_400_000, '1m');
    if (from < nextOpen && inst.venue !== 'replay') {
      await this.gaps.record({
        instrumentId: inst.id,
        stream: 'kline',
        from,
        to: nextOpen,
        detectedBy: 'timer',
        details: { reason: last ? 'since last stored candle' : 'initial history' },
      });
    }
    if (inst.venue !== 'replay') await this.recordDeepHistory(inst.id, now);
    const deps = {
      instrument: inst,
      candles: this.candles,
      trades: this.trades,
      metrics: this.metrics,
      snapshots: this.snapshots,
      gaps: this.gaps,
      redis: this.o.redis,
      log: this.o.log,
      closed: this.closures.checkFor(inst),
      profileBuckets: this.o.profileBuckets,
      live: this.live,
      detections: this.detections,
      usdPerQuote: () => this.usdPerQuote(inst.quote),
      clockOffset: () => (inst.venue === 'replay' ? 0 : (this.clock?.offsetMs ?? 0)),
    };
    const format = inst.venue === 'replay' ? this.replay?.formatOf(inst.venueSymbol) : inst.venue;
    const pipeline =
      format === 'binance'
        ? new BinancePipeline({
            ...deps,
            fetchDepthSnapshot: (s) =>
              inst.venue === 'replay' ? this.replay!.depthSnapshot(s) : this.binance.depthSnapshot(s),
          })
        : new CoinbasePipeline(deps, { nextOpen, lastClose: last?.close ?? null });
    pipeline.seedRunning(await this.candles.minutesSince(inst.id, floorTo(now, '1d')));
    const detector = pipeline.largeTrades;
    if (detector) {
      // The threshold's trailing day comes from stored trades before detection starts.
      void this.seedOrders(inst, now)
        .then((rows) => detector.seed(rows))
        .catch((err: unknown) =>
          this.o.log.warn({ err, instrument: inst.venueSymbol }, 'large-trade seed failed'),
        )
        .finally(() => detector.start());
    }
    this.o.log.info({ instrument: inst.venueSymbol, venue: inst.venue }, 'pipeline created');
    return pipeline;
  }

  /**
   * Each deep-history timeframe whose stored candles do not reach back DEEP_HISTORY_CANDLES periods
   * (before the last one that has ended) gets a gap of its own, which the backfill job fills from the
   * venue's candles at that timeframe. History that already reaches back that far is not fetched
   * again, so a restart costs one query per timeframe.
   */
  private async recordDeepHistory(instrumentId: string, now: number): Promise<void> {
    for (const tf of DEEP_HISTORY_TIMEFRAMES) {
      const end = floorTo(now, tf);
      const origin = end - DEEP_HISTORY_CANDLES * TF_MS[tf];
      const first = await this.candles.firstOpenTime(instrumentId, tf);
      if (first !== null && first <= origin) continue;
      await this.gaps.record({
        instrumentId,
        stream: 'kline',
        from: origin,
        to: end,
        detectedBy: 'timer',
        details: { timeframe: tf, reason: 'deep history' },
      });
    }
  }

  /**
   * Hourly log-binned counts of taker-order notional over the trailing 24 h of stored trades, binned
   * exactly as `notionalBin` does. Coinbase fills are grouped by taker order; a Binance aggTrade is
   * already one taker order at one price (sweeps are not merged here: a small low bias that leaves
   * the window within a day). USDT is taken at the current USDT-USD rate.
   */
  private async seedOrders(
    inst: StreamedInstrument,
    now: number,
  ): Promise<{ hour: number; bin: number; count: number }[]> {
    const since = new Date(now - 86_400_000);
    const usd = Number(this.usdPerQuote(inst.quote));
    const { rows } = await sql<{ hour: number; bin: number; count: number }>`
      WITH orders AS (
        SELECT ts, price * qty AS notional FROM market.trades
        WHERE instrument_id = ${inst.id} AND ts > ${since} AND taker_order_ref IS NULL
        UNION ALL
        SELECT min(ts), sum(price * qty) FROM market.trades
        WHERE instrument_id = ${inst.id} AND ts > ${since} AND taker_order_ref IS NOT NULL
        GROUP BY taker_order_ref
      )
      SELECT floor(extract(epoch FROM ts) / 3600)::int AS hour,
             greatest(0, floor(ln(greatest(notional * ${usd}, 1)) / ln(${NOTIONAL_BIN_RATIO})))::int AS bin,
             count(*)::int AS count
      FROM orders GROUP BY 1, 2`.execute(this.o.db);
    return rows;
  }

  /** USD per unit of a quote currency: 1 for USD; the USDT-USD mid for USDT ("1" until it is known). */
  private usdPerQuote(quote: string): string {
    if (quote !== 'USDT') return '1';
    const usdt = [...this.pipelines.values()].find(
      (p) => p.instrument.base === 'USDT' && p.instrument.quote === 'USD',
    );
    const mid = usdt?.mid(Date.now());
    return mid ? decimal(mid, 8) : '1';
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const { base, monitor } of this.spreads) {
      try {
        monitor.tick(now, spreadLegs(base, this.pipelines.values()));
      } catch (err) {
        this.o.log.warn({ err, base }, 'spread tick failed');
      }
    }
    await Promise.all(
      [...this.pipelines.values()].map((p) =>
        p
          .tick(now)
          .catch((err: unknown) =>
            this.o.log.warn({ err, instrument: p.instrument.venueSymbol }, 'tick failed'),
          ),
      ),
    );
  }

  /**
   * Feed status per instrument and stream, for System Health: one key per venue, written by that
   * venue's lease holder (so a standby never overwrites it). Transitions become feed events.
   */
  private async publishStatus(): Promise<void> {
    const now = Date.now();
    const byVenue: Record<StreamVenue, FeedStatus[]> = { binance: [], coinbase: [], replay: [] };
    for (const p of this.pipelines.values()) {
      for (const s of p.status(now)) {
        byVenue[p.instrument.venue].push(s);
        const key = `${s.instrumentId}:${s.stream}`;
        if (this.lastStatus.get(key) !== s.state) {
          const previous = this.lastStatus.get(key);
          this.lastStatus.set(key, s.state);
          if (previous !== undefined) await publishEvent(this.o.redis, 'feed.status', { ...s, previous });
        }
      }
    }
    for (const venue of this.venues)
      if (this.leases[venue].held)
        await this.o.redis.set(
          `feed:status:${venue}`,
          JSON.stringify({ ts: now, instance: this.o.instance, feeds: byVenue[venue] }),
          'PX',
          15_000,
        );
  }

  probe(): HeartbeatProbe {
    const venues = this.venues
      .map((v) => `${v} ${this.leases[v].held ? this.venueState[v] : 'standby'}`)
      .join(', ');
    const degraded = this.venues.some((v) => this.leases[v].held && this.venueState[v] !== 'open');
    const d = this.detections;
    let late = 0;
    for (const p of this.pipelines.values()) if (p instanceof CoinbasePipeline) late += p.lateTrades;
    const drift = this.clock && Math.abs(this.clock.offsetMs) > CLOCK_WARN_MS ? this.clock.offsetMs : null;
    return {
      status: degraded || drift !== null ? 'degraded' : 'ok',
      detail:
        `streaming ${this.pipelines.size} instruments (${venues}); ${this.gaps.openGaps} gaps recorded; ${d.largeTrades} large trades, ${d.wallsOpened} walls; ${late} late trades` +
        (drift !== null
          ? `; local clock ${drift > 0 ? 'behind' : 'ahead of'} venue time by ${Math.abs(drift)} ms`
          : ''),
    };
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
    const now = Date.now();
    for (const p of this.pipelines.values()) p.close(now);
    this.binance.stop();
    this.coinbase.stop();
    this.replay?.stop();
    await Promise.all([this.trades.stop(), this.metrics.stop(), this.snapshots.stop()]);
    await Promise.all(this.venues.map((v) => this.leases[v].release()));
    await this.backfillQueue.close();
    await this.queueConnection.quit().catch(() => this.queueConnection.disconnect());
  }
}
