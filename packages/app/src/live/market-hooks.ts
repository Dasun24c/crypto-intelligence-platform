import { useQuery } from '@tanstack/react-query';
import { useMemo, useReducer } from 'react';
import { type BookSnapshot, channels, type SystemHealth, type Ticker } from '@cip/contracts';
import { isNoLiveData, QUERY_KEYS } from '../api/queries.js';
import { applyFeedEvents, type FeedEvent, feedKey } from '../lib/market.js';
import { useSession } from '../session.js';
import { type LiveValue, useChannels, useLatest, useLiveConnection } from './hooks.js';

export interface MarketValue<T> extends LiveValue<T> {
  /** live: from the channel; rest: polled because the live connection is down. */
  readonly source: 'live' | 'rest';
}

/**
 * A live value with a REST fallback: while the live connection is reconnecting or down, the REST
 * endpoint is polled instead. Its 503 (feed not streaming) means "no live data", not an error.
 */
function useWithFallback<T>(live: LiveValue<T>, key: readonly unknown[], path: string): MarketValue<T> {
  const { client } = useSession();
  const connection = useLiveConnection();
  const fallback = connection.state === 'reconnecting' || connection.state === 'disconnected';
  const rest = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await client.request<T>('GET', path);
      } catch (err) {
        if (isNoLiveData(err)) return null;
        throw err;
      }
    },
    enabled: fallback,
    refetchInterval: fallback ? 5_000 : false,
    retry: false,
  });
  if (fallback && rest.isSuccess) return { ...live, data: rest.data, source: 'rest' };
  return { ...live, source: 'live' };
}

/** The instrument's ticker (`ticker:{id}`, 4 Hz). */
export function useTicker(instrumentId: string): MarketValue<Ticker> {
  const live = useLatest<Ticker>(channels.ticker(instrumentId));
  return useWithFallback(live, ['market', instrumentId, 'ticker'], `/api/v1/market/${instrumentId}/ticker`);
}

/** The instrument's top-50 book (`book:{id}`, 10 Hz, rendered at most 4 times a second). */
export function useBook(instrumentId: string): MarketValue<BookSnapshot> {
  const live = useLatest<BookSnapshot>(channels.book(instrumentId));
  return useWithFallback(
    live,
    ['market', instrumentId, 'book'],
    `/api/v1/market/${instrumentId}/book?depth=10`,
  );
}

export interface SystemHealthView {
  data: SystemHealth | undefined;
  /** True while `system:health` delivers; otherwise the REST endpoint is polled every 5 s. */
  live: boolean;
  pending: boolean;
  error: Error | null;
}

/** System health: pushed over `system:health`, polled over REST while that channel is not live. */
export function useSystemHealth(): SystemHealthView {
  const { client } = useSession();
  const pushed = useLatest<SystemHealth>(channels.systemHealth, { minIntervalMs: 1_000 });
  const connection = useLiveConnection();
  const live = connection.state === 'live' && pushed.status.state === 'live' && pushed.data !== null;
  const rest = useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: () => client.request<SystemHealth>('GET', '/api/v1/system/health'),
    refetchInterval: live ? false : 5_000,
  });
  const a = pushed.data;
  const b = rest.data;
  const data = !a ? b : !b ? a : a.checkedAt >= b.checkedAt ? a : b;
  return { data, live, pending: data === undefined && rest.isPending, error: rest.error };
}

type FeedEvents = ReadonlyMap<string, { event: FeedEvent; ts: number }>;

function recordFeedEvent(state: FeedEvents, action: { event: FeedEvent; ts: number }): FeedEvents {
  const key = feedKey(action.event);
  const previous = state.get(key);
  if (previous && previous.ts > action.ts) return state;
  return new Map(state).set(key, action);
}

/**
 * Feed status per instrument and stream: System Health's list, with the `feed.status` transitions
 * from each instrument's `market:{id}` channel applied as soon as they happen.
 */
export function useFeedStatuses(instrumentIds: readonly string[]) {
  const health = useSystemHealth();
  const [events, record] = useReducer(recordFeedEvent, new Map() as FeedEvents);
  const marketChannels = useMemo(() => instrumentIds.map((id) => channels.market(id)), [instrumentIds]);
  useChannels(marketChannels, {
    onMessage: (m) => {
      if (m.type === 'feed.status') record({ event: m.data as FeedEvent, ts: m.ts });
    },
  });
  const feeds = useMemo(
    () => (health.data ? applyFeedEvents(health.data.feeds, health.data.checkedAt, events) : null),
    [health.data, events],
  );
  return { feeds, health };
}
