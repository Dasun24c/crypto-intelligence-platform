import { useEffect, useEffectEvent, useMemo, useSyncExternalStore } from 'react';
import type { Envelope } from '@cip/contracts';
import { useSession } from '../session.js';
import type { ChannelStatus, ConnectionStatus, LiveClient } from './live-client.js';

export function useLiveClient(): LiveClient {
  return useSession().live;
}

/** The shared live connection's state, for status badges and data-age hints. */
export function useLiveConnection(): ConnectionStatus {
  const live = useLiveClient();
  return useSyncExternalStore(live.subscribeConnection, live.getConnection);
}

export interface LiveValue<T> {
  /** The latest value; null until one arrives, or when the server has none (feed not streaming). */
  readonly data: T | null;
  /** Client time of the last message (not of a subscribe snapshot), null if none arrived yet. */
  readonly lastMessageAt: number | null;
  readonly status: ChannelStatus;
}

const PENDING: ChannelStatus = { state: 'pending', error: null };
const EMPTY: LiveValue<never> = { data: null, lastMessageAt: null, status: PENDING };

/**
 * Holds the latest value of one channel and tells React at most once per `minIntervalMs`: a 10 Hz
 * book renders at most 4 times a second. The first change after a quiet period is shown at once.
 */
class LatestStore<T> {
  private value: LiveValue<T> = EMPTY;
  private pending: LiveValue<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmit = -Infinity;
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | null = null;

  constructor(
    private readonly live: LiveClient,
    private readonly channel: string | null,
    /** Only messages of this type count (e.g. 'spread' on a market channel); snapshots are ignored. */
    private readonly type: string | undefined,
    private readonly minIntervalMs: number,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.channel !== null) this.attach(this.channel);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.release?.();
      this.release = null;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    };
  };

  readonly getSnapshot = (): LiveValue<T> => this.value;

  private attach(channel: string): void {
    const current = this.live.peek(channel);
    if (current && this.type === undefined)
      this.value = {
        data: current.data as T | null,
        lastMessageAt: current.lastMessageAt,
        status: current.status,
      };
    else if (current) this.value = { ...this.value, status: current.status };
    this.release = this.live.subscribe(channel, {
      onSnapshot: (data) => {
        if (this.type === undefined) this.update({ data: (data ?? null) as T | null });
      },
      onMessage: (message) => {
        if (this.type === undefined || message.type === this.type)
          this.update({ data: message.data as T, lastMessageAt: Date.now() });
      },
      onStatus: (status) => this.update({ status }),
    });
  }

  private update(patch: Partial<LiveValue<T>>): void {
    this.pending = { ...(this.pending ?? this.value), ...patch };
    if (this.timer !== null) return;
    // Only data is rate-limited; a status change (subscribed, refused) shows at once.
    const wait = 'data' in patch ? this.lastEmit + this.minIntervalMs - Date.now() : 0;
    if (wait <= 0) this.emit();
    else
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit();
      }, wait);
  }

  private emit(): void {
    const next = this.pending;
    if (!next) return;
    if (next.data !== this.value.data) this.lastEmit = Date.now();
    this.value = next;
    this.pending = null;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface LatestOptions {
  /** Only messages of this type update the value (snapshots are then ignored). */
  type?: string;
  /** Minimum time between renders; default 250 ms (≤ 4 renders per second). */
  minIntervalMs?: number;
}

/**
 * The latest value on a channel: the subscribe snapshot of a non-durable channel, then each message.
 * Pass null to subscribe to nothing.
 */
export function useLatest<T>(channel: string | null, options: LatestOptions = {}): LiveValue<T> {
  const live = useLiveClient();
  const { type, minIntervalMs = 250 } = options;
  const store = useMemo(
    () => new LatestStore<T>(live, channel, type, minIntervalMs),
    [live, channel, type, minIntervalMs],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export interface ChannelEvents {
  onMessage?: (message: Envelope) => void;
  /** A durable channel's resync snapshot (it replaces local state), with the channel it belongs to. */
  onSnapshot?: (snapshot: unknown, channel: string) => void;
}

/**
 * Listens to several channels for as long as the component is mounted. The handlers always see the
 * component's latest state; changing them does not resubscribe.
 */
export function useChannels(names: readonly string[], events: ChannelEvents): void {
  const live = useLiveClient();
  const key = names.join(' ');
  const onMessage = useEffectEvent((message: Envelope) => events.onMessage?.(message));
  const onSnapshot = useEffectEvent((snapshot: unknown, channel: string) =>
    events.onSnapshot?.(snapshot, channel),
  );
  useEffect(() => {
    if (key === '') return undefined;
    const releases = key.split(' ').map((name) =>
      live.subscribe(name, {
        onMessage: (message) => onMessage(message),
        onSnapshot: (snapshot) => onSnapshot(snapshot, name),
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [live, key]);
}

/** {@link useChannels} for one channel (or none). */
export function useChannel(name: string | null, events: ChannelEvents): void {
  useChannels(name === null ? [] : [name], events);
}
