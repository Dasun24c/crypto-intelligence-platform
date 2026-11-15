/**
 * A WebSocket that stays connected (architecture §5.1): exponential backoff with jitter from 1 s to
 * 8 s, a watchdog that reconnects a silent connection, and a proactive reconnect before the venue's
 * maximum connection lifetime. Status changes are reported so they can become feed events.
 */
export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface SocketHooks {
  /** Called on every (re)connection; send the subscription here. */
  onOpen(send: (data: string) => void): void;
  onMessage(data: string, receivedAt: number): void;
  onStatus(status: SocketStatus, detail: string): void;
}

export interface SocketOptions {
  /** Reconnect when no message arrives for this long. */
  idleTimeoutMs: number;
  /** Reconnect before the venue closes the connection itself (Binance: 24 h). */
  maxLifetimeMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  /** Injected in tests; the platform's WebSocket otherwise. */
  WebSocketImpl?: new (url: string) => MinimalWebSocket;
}

export interface MinimalWebSocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;
const MAX_BACKOFF_MS = 8_000;

export class ReconnectingSocket {
  private ws: MinimalWebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private openedAt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly url: () => string,
    private readonly hooks: SocketHooks,
    private readonly opts: SocketOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.check(), Math.min(5_000, this.opts.idleTimeoutMs / 2));
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'stopped');
  }

  /** Reconnects now, for example after the subscription list changed. */
  restart(reason: string): void {
    if (this.stopped) return;
    this.hooks.onStatus('closed', reason);
    this.ws?.close(1000, reason);
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** Sends on the open connection; false when not connected (the next open resubscribes anyway). */
  send(data: string): boolean {
    if (this.ws?.readyState !== OPEN) return false;
    this.ws.send(data);
    return true;
  }

  /**
   * Delay before reconnect attempt `n` (0-based): 1 s, 2 s, 4 s, then 8 s, each × [0.5, 1) for jitter.
   * The cap keeps a reconnect within 10 s of the network returning, however long the outage
   * (criterion 2.4), at about 40 attempts per 5 minutes, far below the venues' connection limits.
   */
  static backoff(n: number, initial = 1_000, max = MAX_BACKOFF_MS, random = Math.random): number {
    return Math.round(Math.min(max, initial * 2 ** n) * (0.5 + random() * 0.5));
  }

  private connect(): void {
    if (this.stopped) return;
    const Impl =
      this.opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => MinimalWebSocket);
    this.hooks.onStatus(
      'connecting',
      this.attempt === 0 ? 'connecting' : `reconnect attempt ${this.attempt}`,
    );
    const ws = new Impl(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = this.now();
      this.lastMessageAt = this.openedAt;
      this.hooks.onStatus('open', 'connected');
      this.hooks.onOpen((data) => ws.send(data));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = this.now();
      this.attempt = 0;
      this.hooks.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data), this.lastMessageAt);
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // an old socket closing after a restart
      this.ws = null;
      if (this.stopped) return;
      this.hooks.onStatus(
        'closed',
        `closed${ev.code ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : ''}`,
      );
      const delay = ReconnectingSocket.backoff(
        this.attempt++,
        this.opts.initialBackoffMs,
        this.opts.maxBackoffMs,
        this.opts.random,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    };
  }

  private check(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    const now = this.now();
    if (now - this.lastMessageAt > this.opts.idleTimeoutMs) {
      this.hooks.onStatus('closed', `silent for ${now - this.lastMessageAt} ms`);
      ws.close(4000, 'idle');
    } else if (this.opts.maxLifetimeMs !== undefined && now - this.openedAt > this.opts.maxLifetimeMs) {
      ws.close(4001, 'lifetime');
    }
  }
}
