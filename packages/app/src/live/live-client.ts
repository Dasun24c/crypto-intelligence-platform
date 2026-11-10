import { io } from 'socket.io-client';
import { type Envelope, isDurableChannel, type SubscribeAck, WS_NAMESPACE, WS_PATH } from '@cip/contracts';
import { compareSeq, isSeq, maxSeq } from './seq.js';

/**
 * The live connection (architecture §10–11, API contracts §5): one Socket.IO connection per signed-in
 * session, shared by every widget. Channels are reference-counted: the first listener subscribes on
 * the server, the last one to leave unsubscribes. After a reconnect every channel is subscribed again,
 * durable ones with `since` so the server replays what was missed (or sends a snapshot that replaces
 * local state); durable messages are de-duplicated by `seq`.
 */

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Client time at which this state began. */
  readonly since: number;
  /** Why the connection is not live, in words; null while live or idle. */
  readonly detail: string | null;
}

export type ChannelError = NonNullable<SubscribeAck['results'][string]['error']> | 'TIMEOUT' | 'REFUSED';

export interface ChannelStatus {
  /** pending: not (yet) subscribed on the current connection; error: the server refused it. */
  readonly state: 'pending' | 'live' | 'error';
  readonly error: ChannelError | null;
}

export interface ChannelHandlers {
  /** Every message on the channel; durable channels never repeat a `seq`. */
  onMessage?: (message: Envelope) => void;
  /**
   * Non-durable channels: the latest value when the channel is (re)subscribed, null if there is none.
   * Durable channels: the current state after a resync that could not be replayed; it replaces
   * whatever the listener has accumulated.
   */
  onSnapshot?: (snapshot: unknown) => void;
  onStatus?: (status: ChannelStatus) => void;
}

/** What a non-durable channel currently holds, for a listener that joins an existing subscription. */
export interface ChannelValue {
  readonly data: unknown;
  readonly lastMessageAt: number | null;
  readonly status: ChannelStatus;
}

/** The part of a Socket.IO client socket the live client uses (a fake one in tests). */
export interface LiveSocket {
  readonly connected: boolean;
  /** False once the server refused or closed the connection: Socket.IO then does not retry by itself. */
  readonly active: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown): void;
  emitWithAck(event: string, payload: unknown, timeoutMs: number): Promise<unknown>;
}

export interface LiveSocketOptions {
  path: string;
  transports: string[];
  /** Called before every connection attempt, so a reconnect presents the current access token. */
  auth: (cb: (data: { token: string }) => void) => void;
}

export type SocketFactory = (url: string, options: LiveSocketOptions) => LiveSocket;

export interface LiveClientOptions {
  /** The server origin ('' for the page's own origin), as for REST. */
  getServerUrl: () => Promise<string | null>;
  getToken: () => string | null;
  /** Gets a new access token: false when the session is over; throws when the server is unreachable. */
  refreshToken: () => Promise<boolean>;
  /** The refresh was refused: the user has to sign in again. */
  onSessionEnded?: () => void;
  createSocket?: SocketFactory;
  now?: () => number;
  ackTimeoutMs?: number;
}

/** The real transport: Socket.IO over WebSocket only (ADR 007). */
export const socketIoFactory: SocketFactory = (url, options) => {
  // forceNew: a new session never reuses a previous session's cached socket or its handlers.
  const socket = io(url, { ...options, autoConnect: false, forceNew: true });
  return {
    get connected() {
      return socket.connected;
    },
    get active() {
      return socket.active;
    },
    connect: () => void socket.connect(),
    disconnect: () => void socket.disconnect(),
    on: (event, listener) => void socket.on(event, listener),
    emit: (event, payload) => void socket.emit(event, payload),
    emitWithAck: (event, payload, timeoutMs) =>
      socket.timeout(timeoutMs).emitWithAck(event, payload) as Promise<unknown>,
  };
};

const PENDING: ChannelStatus = { state: 'pending', error: null };
const LIVE: ChannelStatus = { state: 'live', error: null };
/** SubscribeRequestSchema accepts at most 100 channels per request. */
const MAX_CHANNELS_PER_REQUEST = 100;
/** Seqs remembered per durable channel to drop copies delivered both live and by a replay. */
const SEEN_LIMIT = 1_000;
const RETRY_MS = 5_000;
const RETRYABLE: ReadonlySet<ChannelError> = new Set(['TIMEOUT', 'REFUSED', 'RATE_LIMITED']);

interface Channel {
  readonly name: string;
  readonly durable: boolean;
  readonly listeners: Set<ChannelHandlers>;
  status: ChannelStatus;
  /** Non-durable: the latest snapshot or message data. */
  latest: unknown;
  lastMessageAt: number | null;
  /** Durable: the newest seq handled, sent as `since` on the next subscribe. */
  lastSeq: string | null;
  /** Durable: messages at or before this seq were already handled (or are part of a snapshot). */
  floor: string | null;
  readonly seen: Set<string>;
  /** A subscribe request is in flight. */
  joining: boolean;
  /** Durable messages that arrived while joining, ordered and de-duplicated once the ack is in. */
  buffer: Envelope[];
  messagesWhileJoining: number;
}

type Membership = 'joining' | 'joined' | 'failed';
type AckResult = SubscribeAck['results'][string];

function newChannel(name: string): Channel {
  return {
    name,
    durable: isDurableChannel(name),
    listeners: new Set(),
    status: PENDING,
    latest: null,
    lastMessageAt: null,
    lastSeq: null,
    floor: null,
    seen: new Set(),
    joining: false,
    buffer: [],
    messagesWhileJoining: 0,
  };
}

function toEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Partial<Envelope>;
  if (typeof m.ch !== 'string' || typeof m.type !== 'string' || typeof m.ts !== 'number') return null;
  return m as Envelope;
}

function toAck(raw: unknown): SubscribeAck | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Partial<SubscribeAck>;
  if (typeof a.ok !== 'boolean' || typeof a.results !== 'object' || a.results === null) return null;
  return a as SubscribeAck;
}

/** The problem code of a refused connection (`error.data.code`, also the message). */
function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const data = (err as { data?: { code?: unknown } }).data;
    if (typeof data?.code === 'string') return data.code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'UNKNOWN';
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_CHANNELS_PER_REQUEST)
    out.push(items.slice(i, i + MAX_CHANNELS_PER_REQUEST));
  return out;
}

export class LiveClient {
  private readonly channels = new Map<string, Channel>();
  /** What the server knows on the current connection. */
  private readonly membership = new Map<string, Membership>();
  private readonly connectionListeners = new Set<() => void>();
  private connection: ConnectionStatus;
  private socket: LiveSocket | null = null;
  private starting = false;
  /** Bumped by stop(): work started for an earlier session is dropped. */
  private generation = 0;
  /** Bumped on every connect and disconnect: an ack from an earlier connection is ignored. */
  private epoch = 0;
  private flushQueued = false;
  private everConnected = false;
  private failures = 0;
  private authAttempts = 0;
  private renewing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly createSocket: SocketFactory;
  private readonly ackTimeoutMs: number;

  constructor(private readonly options: LiveClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.createSocket = options.createSocket ?? socketIoFactory;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.connection = { state: 'idle', since: this.now(), detail: null };
  }

  /** Listens to a channel until the returned function is called. Connects on first use. */
  subscribe(name: string, handlers: ChannelHandlers): () => void {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = newChannel(name);
      this.channels.set(name, channel);
    }
    const ch = channel;
    const entry: ChannelHandlers = { ...handlers };
    ch.listeners.add(entry);
    this.queueFlush();
    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      ch.listeners.delete(entry);
      // Left for the next flush, so an immediate re-subscribe (React StrictMode) keeps the channel.
      if (ch.listeners.size === 0) this.queueFlush();
    };
  }

  /** The current value of a subscribed channel, or null when nobody listens to it. */
  peek(name: string): ChannelValue | null {
    const ch = this.channels.get(name);
    return ch ? { data: ch.latest, lastMessageAt: ch.lastMessageAt, status: ch.status } : null;
  }

  readonly getConnection = (): ConnectionStatus => this.connection;

  readonly subscribeConnection = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  };

  /** After sleep or a network change: reconnect now and resync every channel. */
  reconnect(): void {
    const socket = this.socket;
    if (!socket) {
      this.queueFlush();
      return;
    }
    this.clearReconnectTimer();
    this.failures = 0;
    socket.disconnect();
    this.setConnection('reconnecting', 'Resynchronising after a network change.');
    socket.connect();
  }

  /** Sign-out: closes the connection and forgets every position and value. */
  stop(): void {
    this.generation++;
    this.starting = false;
    this.clearReconnectTimer();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.epoch++;
    this.membership.clear();
    this.everConnected = false;
    this.failures = 0;
    this.authAttempts = 0;
    for (const ch of this.channels.values()) {
      ch.latest = null;
      ch.lastMessageAt = null;
      ch.lastSeq = null;
      ch.floor = null;
      ch.seen.clear();
      ch.joining = false;
      ch.buffer = [];
      this.setStatus(ch, PENDING);
    }
    socket?.disconnect();
    this.setConnection('idle', null);
  }

  // ---------------------------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------------------------

  private start(): void {
    if (this.socket || this.starting || this.channels.size === 0) return;
    if (this.options.getToken() === null) return; // signed out: nothing to connect with
    const generation = this.generation;
    this.starting = true;
    this.setConnection(this.everConnected ? 'reconnecting' : 'connecting', null);
    this.options.getServerUrl().then(
      (origin) => {
        if (generation !== this.generation) return;
        this.starting = false;
        const socket = this.createSocket(`${(origin ?? '').replace(/\/+$/, '')}${WS_NAMESPACE}`, {
          path: WS_PATH,
          transports: ['websocket'],
          auth: (cb) => cb({ token: this.options.getToken() ?? '' }),
        });
        this.socket = socket;
        this.listen(socket);
        socket.connect();
      },
      () => {
        if (generation !== this.generation) return;
        this.starting = false;
        this.setConnection('disconnected', 'The server address is not configured.');
      },
    );
  }

  private listen(socket: LiveSocket): void {
    socket.on('connect', () => {
      if (socket === this.socket) this.onConnect();
    });
    socket.on('disconnect', (reason) => {
      if (socket === this.socket) this.onDisconnect(socket, String(reason));
    });
    socket.on('connect_error', (err) => {
      if (socket === this.socket) void this.onConnectError(socket, err);
    });
    socket.on('message', (message) => {
      if (socket === this.socket) this.onEnvelope(message);
    });
    socket.on('auth:expired', () => {
      if (socket === this.socket) void this.renew(socket);
    });
  }

  private onConnect(): void {
    this.epoch++;
    this.membership.clear();
    this.everConnected = true;
    this.failures = 0;
    this.authAttempts = 0;
    this.clearReconnectTimer();
    this.setConnection('live', null);
    this.flush();
  }

  private onDisconnect(socket: LiveSocket, reason: string): void {
    this.epoch++;
    this.membership.clear();
    for (const ch of this.channels.values()) {
      // A partial replay is requested again from the same position.
      ch.joining = false;
      ch.buffer = [];
      this.setStatus(ch, PENDING);
    }
    if (reason === 'io client disconnect') return; // stop() or reconnect()
    if (socket.active) {
      this.setConnection('reconnecting', 'Connection lost. Reconnecting.');
      return;
    }
    // Closed by the server (expired token, failed renewal, too slow): Socket.IO leaves this to us.
    this.setConnection('reconnecting', 'The server closed the live connection. Reconnecting.');
    this.scheduleReconnect(socket);
  }

  private async onConnectError(socket: LiveSocket, err: unknown): Promise<void> {
    if (socket.active) {
      // The server could not be reached: Socket.IO retries with backoff by itself.
      this.setConnection('reconnecting', 'Cannot reach the server. Retrying.');
      return;
    }
    const code = errorCode(err);
    if (code === 'FORBIDDEN') {
      this.setConnection('disconnected', 'Your role may not receive live data.');
      return;
    }
    if (code === 'AUTH_EXPIRED' || code === 'AUTH_REQUIRED') {
      // A token refused right after a refresh points at the server, not the token: back off.
      if (code === 'AUTH_REQUIRED' && this.authAttempts > 0) {
        this.setConnection('reconnecting', 'The server refused the live connection. Retrying.');
        this.scheduleReconnect(socket);
        return;
      }
      this.authAttempts++;
      this.setConnection('reconnecting', 'Renewing the session.');
      let ok: boolean;
      try {
        ok = await this.options.refreshToken();
      } catch {
        if (socket !== this.socket) return;
        this.setConnection('reconnecting', 'Cannot reach the server. Retrying.');
        this.scheduleReconnect(socket);
        return;
      }
      if (socket !== this.socket) return;
      if (!ok) {
        this.endSession();
        return;
      }
      if (this.authAttempts === 1) socket.connect();
      else this.scheduleReconnect(socket);
      return;
    }
    this.setConnection('reconnecting', `The server refused the live connection (${code}). Retrying.`);
    this.scheduleReconnect(socket);
  }

  /** `auth:expired` arrives about a minute before the token expires: renew without reconnecting. */
  private async renew(socket: LiveSocket): Promise<void> {
    if (this.renewing) return;
    this.renewing = true;
    try {
      const ok = await this.options.refreshToken();
      if (socket !== this.socket) return;
      if (!ok) {
        this.endSession();
        return;
      }
      // A refused renewal is followed by a disconnect; the reconnect then presents the new token.
      await socket.emitWithAck('auth:renew', { token: this.options.getToken() }, this.ackTimeoutMs);
    } catch {
      // Unreachable server: it disconnects after its grace period and the reconnect path renews.
    } finally {
      this.renewing = false;
    }
  }

  private endSession(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect();
    this.setConnection('disconnected', 'Your session ended. Sign in again.');
    this.options.onSessionEnded?.();
  }

  private scheduleReconnect(socket: LiveSocket): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.failures);
    this.failures++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (socket === this.socket && !socket.connected && !socket.active) socket.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setConnection(state: ConnectionState, detail: string | null): void {
    const current = this.connection;
    if (current.state === state && current.detail === detail) return;
    this.connection = { state, since: current.state === state ? current.since : this.now(), detail };
    for (const listener of [...this.connectionListeners]) listener();
  }

  // ---------------------------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------------------------

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Brings the server's subscriptions in line with the channels that have listeners. */
  private flush(): void {
    for (const [name, ch] of this.channels) if (ch.listeners.size === 0) this.channels.delete(name);
    const socket = this.socket;
    if (!socket) {
      this.start();
      return;
    }
    if (!socket.connected) return; // 'connect' flushes again
    const leave: string[] = [];
    for (const [name, state] of this.membership) {
      if (this.channels.has(name) || state === 'joining') continue;
      this.membership.delete(name);
      if (state === 'joined') leave.push(name);
    }
    for (const chunk of chunks(leave)) socket.emit('unsubscribe', { channels: chunk });
    const join = [...this.channels.values()].filter((ch) => !this.membership.has(ch.name));
    for (const chunk of chunks(join)) void this.join(socket, chunk);
  }

  private async join(socket: LiveSocket, chs: Channel[]): Promise<void> {
    const epoch = this.epoch;
    const names = chs.map((ch) => ch.name);
    const since: Record<string, string> = {};
    for (const ch of chs) {
      this.membership.set(ch.name, 'joining');
      ch.joining = true;
      ch.buffer = [];
      ch.messagesWhileJoining = 0;
      if (ch.durable && ch.lastSeq !== null) {
        since[ch.name] = ch.lastSeq;
        ch.floor = ch.lastSeq;
      }
    }
    const request = Object.keys(since).length > 0 ? { channels: names, since } : { channels: names };
    let ack: SubscribeAck | null = null;
    let timedOut = false;
    try {
      ack = toAck(await socket.emitWithAck('subscribe', request, this.ackTimeoutMs));
    } catch {
      timedOut = true;
    }
    if (epoch !== this.epoch || socket !== this.socket) return; // a new connection subscribes again
    for (const name of names) {
      const result = ack?.ok ? ack.results[name] : undefined;
      const error: ChannelError | null = result ? (result.error ?? null) : timedOut ? 'TIMEOUT' : 'REFUSED';
      this.settle(name, result, error);
    }
    this.queueFlush();
  }

  private settle(name: string, result: AckResult | undefined, error: ChannelError | null): void {
    const ch = this.channels.get(name);
    const buffered = ch?.buffer ?? [];
    if (ch) {
      ch.joining = false;
      ch.buffer = [];
    }
    if (error !== null || !result) {
      const reason = error ?? 'REFUSED';
      this.membership.set(name, 'failed');
      if (ch) {
        this.setStatus(ch, { state: 'error', error: reason });
        // The server may have subscribed after all; what it sent is real.
        if (reason === 'TIMEOUT') this.deliverInOrder(ch, buffered);
      }
      if (RETRYABLE.has(reason)) this.scheduleRetry();
      return;
    }
    this.membership.set(name, 'joined');
    if (!ch) return; // dropped while joining: the next flush unsubscribes
    this.setStatus(ch, LIVE);
    if (!ch.durable) {
      // A message that arrived once the server had subscribed is at least as new as the snapshot.
      if (ch.messagesWhileJoining === 0) {
        ch.latest = result.snapshot ?? null;
        for (const listener of [...ch.listeners]) listener.onSnapshot?.(ch.latest);
      }
      return;
    }
    const seq = isSeq(result.seq) ? result.seq : null;
    if (result.mode === 'snapshot') {
      // The missed messages are no longer in the stream: the snapshot replaces local state and
      // already contains everything up to its position.
      ch.seen.clear();
      ch.floor = seq;
      for (const listener of [...ch.listeners]) listener.onSnapshot?.(result.snapshot ?? null);
    }
    this.deliverInOrder(ch, buffered);
    ch.lastSeq = maxSeq(ch.lastSeq, seq);
    // Replayed: everything up to this position was just re-sent, so a later copy is a duplicate.
    if (result.mode !== 'live') ch.floor = maxSeq(ch.floor, seq);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      for (const [name, state] of this.membership) {
        const error = this.channels.get(name)?.status.error ?? null;
        if (state === 'failed' && (error === null || RETRYABLE.has(error))) this.membership.delete(name);
      }
      this.flush();
    }, RETRY_MS);
  }

  private setStatus(ch: Channel, status: ChannelStatus): void {
    if (ch.status.state === status.state && ch.status.error === status.error) return;
    ch.status = status;
    for (const listener of [...ch.listeners]) listener.onStatus?.(status);
  }

  private onEnvelope(raw: unknown): void {
    const message = toEnvelope(raw);
    if (!message) return;
    const ch = this.channels.get(message.ch);
    if (!ch) return; // a late message for a channel nobody listens to any more
    // Durable channels also carry non-durable messages (the PAXG spread): those have no seq.
    const seq = ch.durable && isSeq(message.seq) ? message.seq : null;
    if (seq !== null && ch.joining) {
      ch.buffer.push(message);
      return;
    }
    if (!ch.durable) {
      if (ch.joining) ch.messagesWhileJoining++;
      ch.latest = message.data;
      ch.lastMessageAt = this.now();
    }
    this.deliver(ch, message, seq);
  }

  private deliverInOrder(ch: Channel, messages: Envelope[]): void {
    const ordered = [...messages].sort((a, b) => compareSeq(a.seq ?? '0-0', b.seq ?? '0-0'));
    for (const message of ordered) this.deliver(ch, message, message.seq ?? null);
  }

  private deliver(ch: Channel, message: Envelope, seq: string | null): void {
    if (seq !== null && !this.accept(ch, seq)) return;
    for (const listener of [...ch.listeners]) listener.onMessage?.(message);
  }

  /** Durable de-duplication: drop what was handled before the resubscribe, or seen already. */
  private accept(ch: Channel, seq: string): boolean {
    if (ch.floor !== null && compareSeq(seq, ch.floor) <= 0) return false;
    if (ch.seen.has(seq)) return false;
    ch.seen.add(seq);
    if (ch.seen.size > SEEN_LIMIT) {
      const oldest = ch.seen.values().next();
      if (!oldest.done) ch.seen.delete(oldest.value);
    }
    ch.lastSeq = maxSeq(ch.lastSeq, seq);
    return true;
  }
}
