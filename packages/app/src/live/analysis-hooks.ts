import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer } from 'react';
import { type Candle, channels, type IndicatorSeries, type Tf } from '@cip/contracts';
import {
  CHART_CANDLES,
  type ChartCandle,
  closedEvent,
  liveCandlesReducer,
  livePointsReducer,
  mergeCandles,
  mergeSeries,
  NO_LIVE_CANDLES,
  NO_LIVE_POINTS,
  snapshotSeries,
  wireCandle,
} from '../lib/analysis.js';
import { useSession } from '../session.js';
import { useChannel, useLiveConnection } from './hooks.js';

/** While the live connection is down, REST is polled this often instead (as for the ticker and book). */
export const POLL_MS = 5_000;

export const indicatorsKey = (instrumentId: string, tf: Tf) =>
  ['analysis', instrumentId, 'indicators', tf] as const;
export const candlesKey = (instrumentId: string, tf: Tf) => ['market', instrumentId, 'candles', tf] as const;

/** True while the live connection is down: pages then poll REST. */
export function useLiveFallback(): boolean {
  const connection = useLiveConnection();
  return connection.state === 'reconnecting' || connection.state === 'disconnected';
}

export interface IndicatorSeriesView {
  /** The series with the live points merged in; undefined until it first loads. */
  readonly series: IndicatorSeries | undefined;
  readonly pending: boolean;
  /** The last load failed; a series loaded earlier is still returned. */
  readonly error: Error | null;
  /** REST is being polled because the live connection is down. */
  readonly polling: boolean;
}

/**
 * One instrument's indicator series on one timeframe: loaded over REST, then kept current from
 * `indicators:{id}:{tf}` (one point per closed candle, merged by open time). A resync snapshot
 * replaces the series. A point from another run (the run was replaced after a profile change), or a
 * different run reported by System Health (`currentRunId`), reloads it. While the live connection
 * is down, REST is polled instead.
 */
export function useIndicatorSeries(
  instrumentId: string,
  tf: Tf,
  currentRunId: string | null,
): IndicatorSeriesView {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const polling = useLiveFallback();
  const key = useMemo(() => indicatorsKey(instrumentId, tf), [instrumentId, tf]);
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      client.request<IndicatorSeries>(
        'GET',
        `/api/v1/indicators/${instrumentId}?tf=${tf}&limit=${CHART_CANDLES}`,
      ),
    refetchInterval: polling ? POLL_MS : false,
  });
  const [live, dispatch] = useReducer(livePointsReducer, NO_LIVE_POINTS);
  useChannel(channels.indicators(instrumentId, tf), {
    onMessage: (m) => {
      if (m.type !== 'indicators.closed') return;
      const event = closedEvent(m.data);
      if (event?.instrumentId === instrumentId && event.tf === tf) dispatch({ type: 'closed', event });
    },
    onSnapshot: (snapshot) => {
      const series = snapshotSeries(snapshot);
      if (series?.instrumentId !== instrumentId || series.tf !== tf) return;
      // The snapshot holds everything up to its position: it replaces what was loaded and received.
      dispatch({ type: 'reset' });
      queryClient.setQueryData(key, series);
    },
  });

  const loaded = query.data;
  const loadedRun = loaded === undefined ? undefined : (loaded.run?.id ?? null);
  const otherRun =
    loadedRun === undefined
      ? null
      : ([live.runId, currentRunId].find((id) => id !== null && id !== loadedRun) ?? null);
  useEffect(() => {
    // Asked once per run named: the reload brings the series of the run now in force.
    if (otherRun !== null) void queryClient.invalidateQueries({ queryKey: key });
  }, [otherRun, queryClient, key]);

  const series = useMemo(() => (loaded ? mergeSeries(loaded, live) : undefined), [loaded, live]);
  return { series, pending: query.isPending, error: query.error, polling };
}

export interface CandleSeriesView {
  /** Stored candles and live ones, oldest first; the newest may be in progress. */
  readonly candles: ChartCandle[];
  readonly pending: boolean;
  readonly error: Error | null;
}

/**
 * One instrument's candles on one timeframe: the stored (closed) ones over REST, and from
 * `candles:{id}:{tf}` the candle in progress (`candle.update`, about once a second) and each one
 * that closes. Candles that closed while the channel was not subscribed are reloaded over REST
 * whenever it is (re)subscribed (API contracts §5.4); REST is polled while the connection is down.
 */
export function useCandleSeries(instrumentId: string, tf: Tf): CandleSeriesView {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const polling = useLiveFallback();
  const key = useMemo(() => candlesKey(instrumentId, tf), [instrumentId, tf]);
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      client.request<Candle[]>(
        'GET',
        `/api/v1/market/${instrumentId}/candles?tf=${tf}&limit=${CHART_CANDLES}`,
      ),
    refetchInterval: polling ? POLL_MS : false,
  });
  const [live, dispatch] = useReducer(liveCandlesReducer, NO_LIVE_CANDLES);
  useChannel(channels.candles(instrumentId, tf), {
    onMessage: (m) => {
      if (m.type !== 'candle.update' && m.type !== 'candle.closed') return;
      const candle = wireCandle(m.data);
      if (candle) dispatch({ type: m.type === 'candle.closed' ? 'closed' : 'update', candle });
    },
    onSnapshot: (snapshot) => {
      // The channel's last message: shown as in progress until REST has it as a stored candle.
      const candle = wireCandle(snapshot);
      if (candle) dispatch({ type: 'update', candle });
      void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    },
  });
  const candles = useMemo(() => mergeCandles(query.data ?? [], live), [query.data, live]);
  return { candles, pending: query.isPending, error: query.error };
}
