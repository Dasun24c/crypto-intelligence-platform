import { type Envelope, isDurableChannel, type SubscribeAck, type SubscribeRequest } from '@cip/contracts';
import type { LiveSocket, LiveSocketOptions } from '../live/live-client.js';

export interface PendingAck {
  event: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * A stand-in for a Socket.IO client socket: no network, the test plays the server. The `active`
 * flag follows Socket.IO: false after the server refused or closed the connection.
 */
export class FakeSocket implements LiveSocket {
  connected = false;
  active = false;
  connectCalls = 0;
  readonly emitted: { event: string; payload: unknown }[] = [];
  readonly pending: PendingAck[] = [];
  /** When set, acknowledged emits are answered at once (a server that is always ready). */
  respond: ((event: string, payload: unknown) => unknown) | null = null;
  /** When true, connect() opens the connection on the next microtask. */
  autoOpen = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly url: string,
    readonly options: LiveSocketOptions,
  ) {}

  connect(): void {
    this.connectCalls++;
    this.active = true;
    if (this.autoOpen)
      queueMicrotask(() => {
        if (this.active && !this.connected) this.open();
      });
  }

  disconnect(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.active = false;
    if (wasConnected) this.fire('disconnect', 'io client disconnect');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push({ event, payload });
    if (this.respond) return Promise.resolve(this.respond(event, payload));
    return new Promise((resolve, reject) => this.pending.push({ event, payload, resolve, reject }));
  }

  // --- the server's side -----------------------------------------------------------------------

  /** The access token the client presents on its next connection attempt. */
  token(): string {
    let token = '';
    this.options.auth((data) => {
      token = data.token;
    });
    return token;
  }

  open(): void {
    this.connected = true;
    this.active = true;
    this.fire('connect');
  }

  /** The connection drops; Socket.IO retries by itself unless the server closed it. */
  drop(reason = 'transport close'): void {
    this.connected = false;
    this.active = reason !== 'io server disconnect';
    this.fire('disconnect', reason);
  }

  /** The handshake middleware refuses the connection (no automatic retry). */
  refuse(code: string): void {
    this.connected = false;
    this.active = false;
    this.fire('connect_error', Object.assign(new Error(code), { data: { code } }));
  }

  /** A network-level failure: Socket.IO keeps retrying. */
  unreachable(): void {
    this.fire('connect_error', new Error('websocket error'));
  }

  send(message: Envelope): void {
    this.fire('message', message);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  /** Takes the oldest unanswered acknowledged emit of `event`. */
  next(event = 'subscribe'): PendingAck {
    const i = this.pending.findIndex((p) => p.event === event);
    if (i < 0) throw new Error(`no pending ${event}`);
    return this.pending.splice(i, 1)[0]!;
  }

  /** Every subscribe request sent so far. */
  subscribeRequests(): SubscribeRequest[] {
    return this.emitted.filter((e) => e.event === 'subscribe').map((e) => e.payload as SubscribeRequest);
  }

  unsubscribed(): string[] {
    return this.emitted
      .filter((e) => e.event === 'unsubscribe')
      .flatMap((e) => (e.payload as { channels: string[] }).channels);
  }
}

/** A gateway's answer: the given snapshot for non-durable channels, 'live' for durable ones. */
export function ackAll(
  channels: readonly string[],
  snapshots: Readonly<Record<string, unknown>> = {},
  seq = '1000-0',
): SubscribeAck {
  const results: SubscribeAck['results'] = {};
  for (const ch of channels)
    results[ch] = isDurableChannel(ch)
      ? { mode: 'live', seq }
      : { mode: 'snapshot', snapshot: snapshots[ch] ?? null };
  return { ok: true, results };
}

/** A FakeSocket factory that remembers every socket it made. */
export function fakeSockets() {
  const made: FakeSocket[] = [];
  return {
    made,
    create: (url: string, options: LiveSocketOptions) => {
      const socket = new FakeSocket(url, options);
      made.push(socket);
      return socket;
    },
    get last(): FakeSocket {
      const socket = made.at(-1);
      if (!socket) throw new Error('no socket created yet');
      return socket;
    },
  };
}
