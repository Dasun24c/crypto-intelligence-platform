import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { HttpAdapterHost } from '@nestjs/core';
import { Redis } from 'ioredis';
import { type DefaultEventsMap, type Namespace, Server, type Socket } from 'socket.io';
import {
  ACTIVITY_SNAPSHOT_MS,
  ACTIVITY_STREAM,
  type ActivityPulse,
  ActivityReportSchema,
  AI_EVENTS_STREAM,
  AI_MESSAGE_TYPES,
  type AiSnapshot,
  ALERTS_STREAM,
  type AlertsSnapshot,
  ANALYSIS_EVENTS_STREAM,
  type CalendarUpdated,
  CalendarUpdatedSchema,
  can,
  type Capability,
  CHANNEL_PATTERN,
  CONFIG_CHANNELS,
  type Envelope,
  isDurableChannel,
  PRACTICE_EVENTS_STREAM,
  type PracticeSnapshot,
  type SetupTransitionMessage,
  type SmcEventMessage,
  type SubscribeAck,
  SubscribeRequestSchema,
  TimeframeSchema,
  UnsubscribeRequestSchema,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import type { Logger } from '@cip/observability';
import { AiRepository } from '../ai/ai.repository.js';
import { AlertsRepository } from '../alerts/alerts.repository.js';
import { AnalysisRepository } from '../analysis/analysis.repository.js';
import { SetupsRepository } from '../analysis/setups.repository.js';
import { SmcRepository } from '../analysis/smc.repository.js';
import { TokenService } from '../auth/token.service.js';
import { CalendarRepository } from '../calendar/calendar.repository.js';
import type { AuthenticatedUser } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { TAURI_ORIGINS, type ApiConfig } from '../config.js';
import { MarketRepository } from '../market/market.repository.js';
import { PracticeRepository } from '../practice/practice.repository.js';
import { HealthService } from '../system/health.service.js';
import { ActivityAggregator, aiOutcomeOf, aiResultOf, PulseLimiter, pulseOf } from './activity.js';
import { API_CONFIG, CLOCK, type Clock, LOGGER, REDIS } from '../tokens.js';
import { effectiveStatus, toSummary, UsersRepository } from '../users/users.repository.js';

/** Where the ingestor publishes non-durable messages (ADR 014). */
const LIVE_PATTERN = 'live:*';
/**
 * The durable streams: market events from the ingestor, analysis events from the analyzer, the
 * users' alert messages from the jobs service and the API (Phase 8, ADR 020), their practice
 * orders, fills and balances from the broker (Phase 14, ADR 021), and the AI analyses' lifecycle
 * from the jobs service and the API (Phase 9, ADR 023).
 */
const MARKET_EVENTS = 'md:events';
const STREAMS = [
  MARKET_EVENTS,
  ANALYSIS_EVENTS_STREAM,
  ALERTS_STREAM,
  PRACTICE_EVENTS_STREAM,
  AI_EVENTS_STREAM,
] as const;
type DurableStream = (typeof STREAMS)[number];

/**
 * Channels implicit per user, so their names carry no id: each takes its user's entries from a
 * stream of `type`, `user`, `data` and delivers them to a room of that user's sockets, for roles
 * with the capability.
 */
const USER_CHANNELS = {
  alerts: {
    stream: ALERTS_STREAM,
    capability: 'alerts.own',
    types: ['alert.fired', 'notification.read'],
  },
  practice: {
    stream: PRACTICE_EVENTS_STREAM,
    capability: 'practice.own',
    types: ['practice.order', 'practice.fill', 'practice.account', 'practice.automatic'],
  },
} as const satisfies Record<
  string,
  { stream: DurableStream; capability: Capability; types: readonly string[] }
>;
export type UserChannel = keyof typeof USER_CHANNELS;
export const isUserChannel = (ch: string): ch is UserChannel => Object.hasOwn(USER_CHANNELS, ch);
const USER_CHANNEL_OF_STREAM = new Map<string, UserChannel>(
  (Object.keys(USER_CHANNELS) as UserChannel[]).map((ch) => [USER_CHANNELS[ch].stream, ch]),
);
/** A user's sockets subscribed to one of their implicit channels. */
export const userRoom = (ch: UserChannel, userId: string) => `_${ch}:${userId}`;

/** The stream a durable channel's messages come from. */
export const streamOf = (ch: string): DurableStream =>
  isUserChannel(ch)
    ? USER_CHANNELS[ch].stream
    : ch === 'ai'
      ? AI_EVENTS_STREAM
      : ch.startsWith('indicators:') || ch.startsWith('smc:') || ch === 'setups' || ch.startsWith('setups:')
        ? ANALYSIS_EVENTS_STREAM
        : MARKET_EVENTS;
/** Channels that carry every instrument: no instrument id to check. */
const GLOBAL_CHANNELS = new Set<string>([
  'system:health',
  'system:activity',
  'setups',
  'calendar',
  'ai',
  ...Object.keys(USER_CHANNELS),
]);
const MARKET_TYPES = new Set(['gap.opened', 'gap.closed', 'feed.status', 'wall.appeared', 'wall.ended']);
const MAX_CHANNELS = 200;
const MAX_REPLAY = 10_000;
/** Ask for a new token this long before the current one expires; disconnect this long after. */
const RENEW_LEAD_MS = 60_000;
const RENEW_GRACE_MS = 30_000;
/** Backpressure (architecture §10): a socket this far behind for 30 s is disconnected. */
const BUFFER_LIMIT = 500;
const OVER_LIMIT_MS = 30_000;
/**
 * Sockets over the buffer limit sit in this room and are skipped for non-durable messages (the next
 * one supersedes it anyway). Socket.IO's `volatile` is not used: it drops a message whenever a write
 * is in flight, which loses most of a burst (six candle updates per tick) even for a fast client.
 */
const SLOW_ROOM = '_slow';
/** The 3D brain's channel (Phase 10, ADR 024). */
const ACTIVITY_CHANNEL = 'system:activity';
/** System Health older than this is checked again before a new subscriber's first snapshot. */
const ERRORS_FRESH_MS = 10_000;

interface SocketState {
  user: AuthenticatedUser;
  expiresAt: number;
  overLimitSince: number | null;
  timers: NodeJS.Timeout[];
}

type LiveSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketState>;

/**
 * The real-time gateway (architecture §10, API contracts §5): Socket.IO on `/v1`, WebSocket only,
 * an access token at the handshake. Non-durable channels arrive from the ingestor over Redis pub/sub
 * and are skipped, never queued, for a client that is behind. Durable channels are
 * read from the `md:events` and `an:events` streams and carry the entry id as `seq`, so a
 * reconnecting client can replay what it missed. Each API instance delivers to its own sockets only; no adapter is needed.
 * A client that falls behind is skipped for non-durable messages until it catches up.
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private io: Server | null = null;
  private nsp: Namespace | null = null;
  private subscriber: Redis | null = null;
  private reader: Redis | null = null;
  private running = false;
  private readonly lastSeq: Record<DurableStream, string> = {
    'md:events': '0-0',
    'an:events': '0-0',
    'alerts:events': '0-0',
    'practice:events': '0-0',
    'ai:events': '0-0',
  };
  private readonly lastLive = new Map<string, string>();
  private instrumentIds: { at: number; ids: Set<string> } | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastHealth = { json: '', at: 0 };
  /** The brain's activity (ADR 024): the services' reports, alerts, AI results and pulses. */
  private readonly activity = new ActivityAggregator();
  private readonly pulseLimiter = new PulseLimiter();
  private activitySeq = '0-0';
  delivered = 0;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tokens: TokenService,
    private readonly users: UsersRepository,
    private readonly market: MarketRepository,
    private readonly health: HealthService,
    private readonly analysis: AnalysisRepository,
    private readonly smc: SmcRepository,
    private readonly setups: SetupsRepository,
    private readonly calendar: CalendarRepository,
    private readonly alerts: AlertsRepository,
    private readonly practice: PracticeRepository,
    private readonly ai: AiRepository,
  ) {}

  onApplicationBootstrap(): void {
    const io = new Server(this.adapterHost.httpAdapter.getHttpServer() as HttpServer, {
      path: WS_PATH,
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: 64 * 1024,
      cors: { origin: [...this.config.CORS_ORIGINS, ...TAURI_ORIGINS], credentials: false },
    });
    this.io = io;
    const nsp = io.of(WS_NAMESPACE);
    this.nsp = nsp;
    nsp.use((socket, next) => {
      const token: unknown = (socket.handshake.auth as Record<string, unknown> | undefined)?.['token'];
      this.authenticate(typeof token === 'string' ? token : '')
        .then((state) => {
          socket.data = state;
          next();
        })
        .catch((err: unknown) => {
          const code = err instanceof ProblemError ? err.code : 'AUTH_REQUIRED';
          next(Object.assign(new Error(code), { data: { code } }));
        });
    });
    nsp.on('connection', (socket: LiveSocket) => this.onConnection(socket));

    this.running = true;
    this.subscriber = new Redis(this.config.REDIS_URL, { connectionName: 'cip-api-live' });
    void this.subscriber.psubscribe(LIVE_PATTERN);
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) =>
      this.forwardLive(channel.slice('live:'.length), message),
    );
    this.subscriber.on('message', (channel: string, message: string) => {
      // An instrument added or disabled changes which channels exist.
      if (channel === CONFIG_CHANNELS.instruments) this.instrumentIds = null;
      // A calendar sync or an admin's entry: clients reload the calendar (Phase 7).
      else if (channel === CONFIG_CHANNELS.calendar) this.forwardCalendar(message);
    });
    void this.subscriber.subscribe(CONFIG_CHANNELS.instruments, CONFIG_CHANNELS.calendar);
    this.reader = new Redis(this.config.REDIS_URL, {
      connectionName: 'cip-api-events',
      maxRetriesPerRequest: null,
    });
    void this.readEvents();
    this.timers.push(setInterval(() => this.checkBackpressure(), 1_000));
    this.timers.push(setInterval(() => void this.broadcastHealth(), 5_000));
    this.timers.push(setInterval(() => this.broadcastActivity(), ACTIVITY_SNAPSHOT_MS));
    for (const t of this.timers) t.unref();
    void this.seedAi();
  }

  /** The AI's last result before this instance started (ADR 024); later ones come from ai:events. */
  private async seedAi(): Promise<void> {
    try {
      const [latest] = await this.ai.latest(1);
      if (latest) this.activity.aiFinished(aiResultOf(latest.status), latest.createdAt);
    } catch (err) {
      this.log.warn({ err }, 'could not read the last AI analysis for the activity view');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.subscriber?.disconnect();
    this.reader?.disconnect();
    if (this.io) await this.io.close();
  }

  /** Same checks as the REST access guard: valid token, active user, token newer than the password. */
  private async authenticate(token: string): Promise<SocketState> {
    if (!token) throw new ProblemError('AUTH_REQUIRED');
    const claims = await this.tokens.verifyAccessToken(token);
    const user = await this.users.findById(claims.userId);
    if (!user || effectiveStatus(user, this.clock()) !== 'active') throw new ProblemError('AUTH_REQUIRED');
    if (claims.issuedAt < Math.floor(user.password_changed_at.getTime() / 1000))
      throw new ProblemError('AUTH_EXPIRED');
    if (!can(user.role, 'dashboards.view')) throw new ProblemError('FORBIDDEN');
    return { user: toSummary(user), expiresAt: claims.expiresAt, overLimitSince: null, timers: [] };
  }

  private onConnection(socket: LiveSocket): void {
    this.scheduleRenewal(socket);
    socket.on('disconnect', () => {
      for (const t of socket.data.timers) clearTimeout(t);
    });
    socket.on('auth:renew', (payload: unknown, ack?: unknown) => {
      const reply = replier(ack);
      const token = (payload as { token?: unknown } | null)?.token;
      this.authenticate(typeof token === 'string' ? token : '')
        .then((state) => {
          for (const t of socket.data.timers) clearTimeout(t);
          socket.data = { ...state, overLimitSince: socket.data.overLimitSince };
          this.scheduleRenewal(socket);
          reply({ ok: true });
        })
        .catch(() => {
          reply({ ok: false });
          socket.disconnect(true);
        });
    });
    socket.on('subscribe', (payload: unknown, ack?: unknown) => {
      if (typeof ack !== 'function') return;
      const reply = replier(ack);
      this.subscribe(socket, payload)
        .then((result) => reply(result))
        .catch((err: unknown) => {
          this.log.warn({ err }, 'subscribe failed');
          reply({ ok: false, results: {} } satisfies SubscribeAck);
        });
    });
    socket.on('unsubscribe', (payload: unknown) => {
      const parsed = UnsubscribeRequestSchema.safeParse(payload);
      if (parsed.success)
        for (const ch of parsed.data.channels)
          void socket.leave(isUserChannel(ch) ? userRoom(ch, socket.data.user.id) : ch);
    });
  }

  /** `auth:expired` shortly before the token expires; disconnect if no renewal arrives in time. */
  private scheduleRenewal(socket: LiveSocket): void {
    const left = socket.data.expiresAt - this.clock();
    socket.data.timers = [
      setTimeout(() => socket.emit('auth:expired'), Math.max(0, left - RENEW_LEAD_MS)),
      setTimeout(() => socket.disconnect(true), Math.max(0, left + RENEW_GRACE_MS)),
    ];
  }

  private async subscribe(socket: LiveSocket, payload: unknown): Promise<SubscribeAck> {
    const parsed = SubscribeRequestSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, results: {} };
    const known = await this.knownInstruments();
    const results: SubscribeAck['results'] = {};
    for (const ch of parsed.data.channels) {
      const id = ch.split(':')[1];
      if (!CHANNEL_PATTERN.test(ch) || (!GLOBAL_CHANNELS.has(ch) && (!id || !known.has(id)))) {
        results[ch] = { mode: 'live', error: 'CHANNEL_UNKNOWN' };
        continue;
      }
      const room = isUserChannel(ch) ? userRoom(ch, socket.data.user.id) : ch;
      if (isUserChannel(ch) && !can(socket.data.user.role, USER_CHANNELS[ch].capability)) {
        results[ch] = { mode: 'live', error: 'FORBIDDEN' };
        continue;
      }
      if (!socket.rooms.has(room) && socket.rooms.size > MAX_CHANNELS) {
        results[ch] = { mode: 'live', error: 'RATE_LIMITED' };
        continue;
      }
      await socket.join(room);
      results[ch] = await this.initial(socket, ch, parsed.data.since?.[ch]);
    }
    return { ok: true, results };
  }

  private async knownInstruments(): Promise<Set<string>> {
    const now = this.clock();
    if (!this.instrumentIds || now - this.instrumentIds.at > 30_000) {
      const ids = new Set((await this.market.instruments({ includeDisabled: false })).map((i) => i.id));
      this.instrumentIds = { at: now, ids };
    }
    return this.instrumentIds.ids;
  }

  /** What a new subscriber gets first (API contracts §5.4). */
  private async initial(
    socket: LiveSocket,
    ch: string,
    since: string | undefined,
  ): Promise<SubscribeAck['results'][string]> {
    if (ch === 'system:health') return { mode: 'snapshot', snapshot: await this.health.check() };
    if (ch === ACTIVITY_CHANNEL) {
      const now = this.clock();
      if (now - this.activity.errorsAt > ERRORS_FRESH_MS)
        await this.health
          .check()
          .then((h) => this.activity.health(h, now))
          .catch((err: unknown) => this.log.warn({ err }, 'health check for the activity view failed'));
      return { mode: 'snapshot', snapshot: this.activity.snapshot(now) };
    }
    if (!isDurableChannel(ch)) return { mode: 'snapshot', snapshot: await this.liveSnapshot(ch) };

    const stream = streamOf(ch);
    const latest = (await this.redis.xrevrange(stream, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
    if (since === undefined) return { mode: 'live', seq: latest };
    const first = (await this.redis.xrange(stream, '-', '+', 'COUNT', 1))[0]?.[0];
    const replayable = first !== undefined && compareSeq(since, first) >= 0;
    const entries = replayable
      ? await this.redis.xrange(stream, `(${since}`, latest, 'COUNT', MAX_REPLAY)
      : [];
    if (replayable && entries.length < MAX_REPLAY) {
      for (const [seq, fields] of entries) {
        if (isUserChannel(ch)) {
          // Only the user's own messages.
          const u = toUserEnvelope(ch, seq, fields);
          if (u && u.user === socket.data.user.id) socket.emit('message', u.envelope);
          continue;
        }
        for (const envelope of toEnvelopes(seq, fields))
          if (envelope.ch === ch) socket.emit('message', envelope);
      }
      return { mode: 'replayed', seq: latest };
    }
    return {
      mode: 'snapshot',
      seq: latest,
      snapshot: isUserChannel(ch)
        ? await this.userSnapshot(ch, socket.data.user.id)
        : await this.durableSnapshot(ch),
    };
  }

  /**
   * A user channel's state, which the client puts in place of its own: for `alerts` the unread
   * count and the latest inbox items; for `practice` the balances and the open orders (criterion
   * 14.9: resynchronised after a disconnect).
   */
  private async userSnapshot(ch: UserChannel, userId: string): Promise<AlertsSnapshot | PracticeSnapshot> {
    if (ch === 'practice') {
      const [accounts, openOrders] = await Promise.all([
        this.practice.accounts(userId),
        this.practice.openOrders(userId),
      ]);
      return { accounts, openOrders };
    }
    const [unread, latest] = await Promise.all([
      this.alerts.unreadCount(userId),
      this.alerts.latest(userId, 20),
    ]);
    return { unread, latest };
  }

  private async liveSnapshot(ch: string): Promise<unknown> {
    const cached = this.lastLive.get(ch);
    if (cached) return (JSON.parse(cached) as Envelope).data;
    if (ch.startsWith('ticker:') || ch.startsWith('book:')) {
      const raw = await this.redis.get(ch);
      return raw ? (JSON.parse(raw) as unknown) : null;
    }
    if (ch === 'calendar') {
      const at = await this.calendar.lastChange();
      return at === null ? null : ({ at, reason: 'sync', changed: 0 } satisfies CalendarUpdated);
    }
    return null;
  }

  /** The current state when a replay is impossible: the client replaces its local copy with it. */
  private async durableSnapshot(ch: string): Promise<unknown> {
    const [, id = '', tf] = ch.split(':');
    if (ch.startsWith('indicators:'))
      return { series: await this.analysis.series(id, TimeframeSchema.parse(tf), { limit: 500 }) };
    if (ch.startsWith('smc:')) {
      // The live run's active levels and ranges; history comes from GET /smc/{id}/overlay.
      const run = await this.smc.run(id);
      return { run, ...(run ? await this.smc.active(run.id) : { levels: [], ranges: [], zones: [] }) };
    }
    // The budget and the latest analyses (Phase 9).
    if (ch === 'ai') {
      const [budget, latest] = await Promise.all([this.ai.budget(this.clock()), this.ai.latest(20)]);
      return { budget, latest } satisfies AiSnapshot;
    }
    // Setups that are not resolved, and the latest 50 transitions (API contracts §5.4).
    if (ch === 'setups') return this.setups.snapshot();
    if (ch.startsWith('setups:')) return this.setups.snapshot(id);
    if (ch.startsWith('trades:'))
      return { largeTrades: (await this.market.largeTrades(id, { limit: 50 })).items };
    const now = this.clock();
    return {
      openGaps: (await this.market.gaps({ instrumentId: id, status: 'open', limit: 100 })).items,
      activeWalls: await this.market.walls(id, { from: now - 86_400_000, to: now, active: true }),
    };
  }

  /**
   * `calendar.updated` on the `calendar` channel. It is not durable (as implemented in Phase 7): a
   * subscriber gets the latest change as its snapshot and reloads the calendar from REST.
   */
  private forwardCalendar(message: string): void {
    const parsed = CalendarUpdatedSchema.safeParse(safeJson(message));
    if (!parsed.success) return;
    const envelope: Envelope = {
      ch: 'calendar',
      ts: this.clock(),
      type: 'calendar.updated',
      data: parsed.data,
    };
    this.forwardLive('calendar', JSON.stringify(envelope));
  }

  private forwardLive(ch: string, message: string): void {
    this.lastLive.set(ch, message);
    if (!this.nsp?.adapter.rooms.has(ch)) return;
    this.delivered++;
    this.nsp.to(ch).except(SLOW_ROOM).emit('message', JSON.parse(message));
  }

  /** Tails the durable streams and delivers each entry on its channel (a user's, to their room). */
  private async readEvents(): Promise<void> {
    const reader = this.reader!;
    for (const stream of STREAMS) {
      try {
        this.lastSeq[stream] = (await reader.xrevrange(stream, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
      } catch (err) {
        this.log.warn({ err, stream }, 'could not read the event stream position');
      }
    }
    await this.seedActivity(reader);
    while (this.running) {
      try {
        const res = await reader.xread(
          'COUNT',
          500,
          'BLOCK',
          5_000,
          'STREAMS',
          ...STREAMS,
          ACTIVITY_STREAM,
          ...STREAMS.map((s) => this.lastSeq[s]),
          this.activitySeq,
        );
        for (const [stream, entries] of res ?? [])
          for (const [seq, fields] of entries) {
            if (stream === ACTIVITY_STREAM) {
              this.activitySeq = seq;
              this.onActivityReport(fields);
              continue;
            }
            this.lastSeq[stream as DurableStream] = seq;
            this.observeActivity(stream, seq, fields);
            const userChannel = USER_CHANNEL_OF_STREAM.get(stream);
            if (userChannel) {
              const u = toUserEnvelope(userChannel, seq, fields);
              const room = u ? userRoom(userChannel, u.user) : '';
              if (u && this.nsp?.adapter.rooms.has(room)) {
                this.delivered++;
                this.nsp.to(room).emit('message', u.envelope);
              }
              continue;
            }
            for (const envelope of toEnvelopes(seq, fields))
              if (this.nsp?.adapter.rooms.has(envelope.ch)) {
                this.delivered++;
                this.nsp.to(envelope.ch).emit('message', envelope);
              }
          }
      } catch (err) {
        if (!this.running) return;
        this.log.warn({ err }, 'event stream read failed');
        await new Promise((r) => setTimeout(r, 1_000).unref());
      }
    }
  }

  /**
   * Where the activity view starts (ADR 024): the latest report position, and the alerts fired in the
   * last minute up to where the reader starts (later ones arrive on the stream).
   */
  private async seedActivity(reader: Redis): Promise<void> {
    try {
      this.activitySeq = (await reader.xrevrange(ACTIVITY_STREAM, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
      const until = this.lastSeq[ALERTS_STREAM];
      if (until === '0-0') return;
      const since = String(this.clock() - 60_000);
      for (const [seq, fields] of await reader.xrange(ALERTS_STREAM, since, until, 'COUNT', 10_000))
        if (fields[1] === 'alert.fired') this.activity.alertFired(Number(seq.split('-')[0]));
    } catch (err) {
      this.log.warn({ err }, 'could not read the activity stream position');
    }
  }

  /** A service instance's second (ADR 024); a malformed report is ignored. */
  private onActivityReport(fields: string[]): void {
    const raw = fields[3];
    const parsed = fields[1] === 'activity' && raw ? ActivityReportSchema.safeParse(safeJson(raw)) : null;
    if (parsed?.success) this.activity.report(parsed.data);
  }

  /** What a durable stream's entry means for the activity view: an AI result, an alert, a pulse. */
  private observeActivity(stream: string, seq: string, fields: string[]): void {
    const ts = Number(seq.split('-')[0]);
    if (stream === AI_EVENTS_STREAM) {
      const outcome = aiOutcomeOf(fields);
      if (outcome) this.activity.aiFinished(outcome, ts);
    }
    if (stream === ALERTS_STREAM && fields[1] === 'alert.fired') this.activity.alertFired(ts);
    const pulse = pulseOf(stream, seq, fields);
    if (pulse) this.emitPulse(pulse);
  }

  private emitPulse(pulse: ActivityPulse): void {
    if (!this.nsp?.adapter.rooms.has(ACTIVITY_CHANNEL) || !this.pulseLimiter.allow(this.clock())) return;
    this.delivered++;
    this.nsp
      .to(ACTIVITY_CHANNEL)
      .except(SLOW_ROOM)
      .emit('message', {
        ch: ACTIVITY_CHANNEL,
        ts: pulse.ts,
        type: 'activity.pulse',
        data: pulse,
      } satisfies Envelope);
  }

  /** `activity.snapshot` every ACTIVITY_SNAPSHOT_MS while anyone is subscribed (≤ 4 Hz). */
  private broadcastActivity(): void {
    if (!this.nsp?.adapter.rooms.has(ACTIVITY_CHANNEL)) return;
    const now = this.clock();
    this.delivered++;
    this.nsp
      .to(ACTIVITY_CHANNEL)
      .except(SLOW_ROOM)
      .emit('message', {
        ch: ACTIVITY_CHANNEL,
        ts: now,
        type: 'activity.snapshot',
        data: this.activity.snapshot(now),
      } satisfies Envelope);
  }

  private checkBackpressure(): void {
    const now = this.clock();
    for (const socket of this.nsp?.sockets.values() ?? []) {
      const s = socket as LiveSocket;
      const buffered = (socket.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0;
      if (buffered <= BUFFER_LIMIT) {
        s.data.overLimitSince = null;
        void socket.leave(SLOW_ROOM);
      } else if (s.data.overLimitSince === null) {
        s.data.overLimitSince = now;
        void socket.join(SLOW_ROOM);
      } else if (now - s.data.overLimitSince > OVER_LIMIT_MS) {
        this.log.warn({ userId: s.data.user.id, buffered }, 'slow live client disconnected');
        socket.disconnect(true);
      }
    }
  }

  /**
   * `system:health` on change, and at least every 10 s, while anyone is subscribed; and the activity
   * view's errors, while anyone watches it (ADR 024).
   */
  private async broadcastHealth(): Promise<void> {
    const forHealth = this.nsp?.adapter.rooms.has('system:health') ?? false;
    const forActivity = this.nsp?.adapter.rooms.has(ACTIVITY_CHANNEL) ?? false;
    if (!forHealth && !forActivity) return;
    try {
      const health = await this.health.check();
      const now = this.clock();
      if (forActivity) this.activity.health(health, now);
      if (!forHealth || !this.nsp) return;
      const json = JSON.stringify({ ...health, checkedAt: 0 });
      if (json === this.lastHealth.json && now - this.lastHealth.at < 10_000) return;
      this.lastHealth = { json, at: now };
      this.nsp.to('system:health').emit('message', {
        ch: 'system:health',
        ts: now,
        type: 'health.update',
        data: health,
      } satisfies Envelope);
    } catch (err) {
      this.log.warn({ err }, 'health broadcast failed');
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A client acknowledgement callback, or a no-op when the client sent none. */
function replier(ack: unknown): (response: unknown) => void {
  return typeof ack === 'function'
    ? (response) => void (ack as (r: unknown) => unknown)(response)
    : () => undefined;
}

/**
 * An `md:events` or `an:events` entry as the envelopes of its durable channels (none for types no
 * channel carries). A setup transition goes to its instrument's `setups:{id}` and to `setups`.
 */
export function toEnvelopes(seq: string, fields: string[]): Envelope[] {
  const type = fields[1];
  const raw = fields[3];
  // The AI analyses' lifecycle (Phase 9): one global channel.
  if (type && raw && (AI_MESSAGE_TYPES as readonly string[]).includes(type)) {
    const data = safeJson(raw);
    return data === null ? [] : [{ ch: 'ai', seq, ts: Number(seq.split('-')[0]), type, data }];
  }
  if (type === 'setup' && raw) {
    const m = JSON.parse(raw) as Partial<SetupTransitionMessage>;
    if (typeof m.instrumentId !== 'string') return [];
    const ts = Number(seq.split('-')[0]);
    return [`setups:${m.instrumentId}`, 'setups'].map((ch) => ({
      ch,
      seq,
      ts,
      type: 'setup.transition',
      data: m,
    }));
  }
  const envelope = toEnvelope(seq, fields);
  return envelope ? [envelope] : [];
}

/**
 * An `md:events` or `an:events` entry as the envelope of its durable channel, or null for types
 * no channel carries (setup transitions: see toEnvelopes).
 */
export function toEnvelope(seq: string, fields: string[]): Envelope | null {
  const type = fields[1];
  const raw = fields[3];
  if (!type || !raw) return null;
  if (type === 'smc') {
    // An SMC detection: the message type and the entity in its API form (SmcEventMessage).
    const m = JSON.parse(raw) as Partial<SmcEventMessage>;
    if (typeof m.instrumentId !== 'string' || typeof m.type !== 'string') return null;
    return { ch: `smc:${m.instrumentId}`, seq, ts: Number(seq.split('-')[0]), type: m.type, data: m.data };
  }
  const data = JSON.parse(raw) as { instrumentId?: unknown; tf?: unknown };
  if (typeof data.instrumentId !== 'string') return null;
  const ch =
    type === 'trade.large'
      ? `trades:${data.instrumentId}`
      : MARKET_TYPES.has(type)
        ? `market:${data.instrumentId}`
        : type === 'indicators.closed' && typeof data.tf === 'string'
          ? `indicators:${data.instrumentId}:${data.tf}`
          : null;
  return ch ? { ch, seq, ts: Number(seq.split('-')[0]), type, data } : null;
}

/**
 * An entry of a per-user stream (`type`, `user`, `data`) as the envelope of its user's channel:
 * `alerts` (`alert.fired`, `notification.read`; ADR 020) or `practice` (`practice.order`,
 * `practice.fill`, `practice.account`; ADR 021; `practice.automatic`, ADR 022). Null for a type the
 * channel does not carry.
 */
export function toUserEnvelope(
  ch: UserChannel,
  seq: string,
  fields: string[],
): { user: string; envelope: Envelope } | null {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
  const { type, user, data } = f;
  if (!type || !(USER_CHANNELS[ch].types as readonly string[]).includes(type) || !user || !data) return null;
  const parsed = safeJson(data);
  if (parsed === null) return null;
  return { user, envelope: { ch, seq, ts: Number(seq.split('-')[0]), type, data: parsed } };
}

/** Orders Redis stream ids ("ms-seq"). */
export function compareSeq(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number) as [number, number];
  const [bm, bs] = b.split('-').map(Number) as [number, number];
  return am !== bm ? am - bm : as - bs;
}
