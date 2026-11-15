import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type CalendarStatus,
  type Candle,
  type ChartOverlay,
  channels,
  type EconomicEvent,
  type Impact,
  type Page,
  type SetupDetail,
  type SetupSummary,
  type Tf,
} from '@cip/contracts';
import { TF_MS } from '@cip/domain';
import { useSession } from '../session.js';
import { POLL_MS, useLiveFallback } from './analysis-hooks.js';
import { useChannel } from './hooks.js';

/** The Liquidity Map's window: the latest closed candles of its timeframe (the overlay's default too). */
export const MAP_CANDLES = 300;

export const mapCandlesKey = (instrumentId: string, tf: Tf) => ['map', instrumentId, tf, 'candles'] as const;
export const overlayKey = (instrumentId: string, tf: Tf, from: number, to: number) =>
  ['map', instrumentId, tf, 'overlay', from, to] as const;

export interface LiquidityWindowView {
  readonly candles: readonly Candle[];
  /** The overlay; while a new window's loads, the previous one (not `ready`). */
  readonly overlay: ChartOverlay | null;
  /** The overlay is the one for exactly the candles' window. */
  readonly ready: boolean;
  readonly pending: boolean;
  readonly error: Error | null;
}

/**
 * The candles of the Liquidity Map's window and the SMC overlay of exactly that window (from the
 * first candle's open to the last one's close), so the chart and `GET /smc/{id}/overlay` describe
 * the same period (criterion 7.1). A closed candle reloads both; a detection reloads the overlay.
 */
export function useLiquidityWindow(instrumentId: string | null, tf: Tf): LiquidityWindowView {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const polling = useLiveFallback();
  const candles = useQuery({
    queryKey: mapCandlesKey(instrumentId ?? '', tf),
    queryFn: () =>
      client.request<Candle[]>('GET', `/api/v1/market/${instrumentId}/candles?tf=${tf}&limit=${MAP_CANDLES}`),
    enabled: instrumentId !== null,
    refetchInterval: polling ? POLL_MS : false,
  });
  const list = candles.data ?? [];
  const from = list[0]?.t ?? null;
  const to = list.length ? list.at(-1)!.t + TF_MS[tf] : null;
  const overlay = useQuery({
    queryKey: overlayKey(instrumentId ?? '', tf, from ?? 0, to ?? 0),
    queryFn: () =>
      client.request<ChartOverlay>(
        'GET',
        `/api/v1/smc/${instrumentId}/overlay?tf=${tf}&from=${from}&to=${to}`,
      ),
    enabled: instrumentId !== null && from !== null && to !== null,
    placeholderData: (previous) => previous,
  });
  useChannel(instrumentId ? channels.candles(instrumentId, tf) : null, {
    onMessage: (m) => {
      if (m.type === 'candle.closed')
        void queryClient.invalidateQueries({ queryKey: mapCandlesKey(instrumentId!, tf) });
    },
  });
  useChannel(instrumentId ? channels.smc(instrumentId) : null, {
    onMessage: () => void queryClient.invalidateQueries({ queryKey: ['map', instrumentId, tf, 'overlay'] }),
  });
  return {
    candles: list,
    overlay: overlay.data ?? null,
    ready: overlay.data !== undefined && !overlay.isPlaceholderData,
    pending: candles.isPending || (from !== null && overlay.isPending),
    error: candles.error ?? overlay.error,
  };
}

// ---------------------------------------------------------------- setups

export interface SetupFilters {
  instrumentId?: string;
  pattern?: string[];
  direction?: 'bullish' | 'bearish';
  state?: string[];
  minScore?: number;
}

export function setupsPath(f: SetupFilters, limit: number): string {
  const q = new URLSearchParams();
  if (f.instrumentId) q.set('instrumentId', f.instrumentId);
  if (f.pattern?.length) q.set('pattern', f.pattern.join(','));
  if (f.direction) q.set('direction', f.direction);
  if (f.state?.length) q.set('state', f.state.join(','));
  if (f.minScore !== undefined && f.minScore > 0) q.set('minScore', String(f.minScore));
  q.set('limit', String(limit));
  return `/api/v1/setups?${q}`;
}

/** `GET /setups` with filters (newest change first); every transition on `setups` reloads it. */
export function useSetupList(filters: SetupFilters, limit: number) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const polling = useLiveFallback();
  const path = useMemo(() => setupsPath(filters, limit), [filters, limit]);
  const query = useQuery({
    queryKey: ['setups', 'list', path],
    queryFn: () => client.request<Page<SetupSummary>>('GET', path),
    refetchInterval: polling ? POLL_MS : false,
    placeholderData: (previous) => previous,
  });
  useChannel(channels.setups(), {
    onMessage: (m) => {
      if (m.type === 'setup.transition') void queryClient.invalidateQueries({ queryKey: ['setups', 'list'] });
    },
  });
  return query;
}

/** `GET /setups/{id}`; a transition of this setup reloads it. */
export function useSetupDetail(id: string, instrumentId: string | null) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['setups', 'detail', id],
    queryFn: () => client.request<SetupDetail>('GET', `/api/v1/setups/${id}`),
  });
  useChannel(instrumentId ? channels.setups(instrumentId) : null, {
    onMessage: (m) => {
      if (m.type === 'setup.transition' && (m.data as { id?: string } | null)?.id === id)
        void queryClient.invalidateQueries({ queryKey: ['setups', 'detail', id] });
    },
  });
  return query;
}

// ---------------------------------------------------------------- calendar

export const CALENDAR_KEYS = { events: ['calendar', 'events'], status: ['calendar', 'status'] } as const;

/** `GET /calendar/events` (by default the last day and the next 60); `calendar.updated` reloads it. */
export function useCalendarEvents(window: { from?: number; to?: number; minImpact?: Impact } = {}) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const q = new URLSearchParams();
  if (window.from !== undefined) q.set('from', String(window.from));
  if (window.to !== undefined) q.set('to', String(window.to));
  if (window.minImpact) q.set('minImpact', window.minImpact);
  const path = `/api/v1/calendar/events${q.size ? `?${q}` : ''}`;
  const query = useQuery({
    queryKey: [...CALENDAR_KEYS.events, path],
    queryFn: () => client.request<EconomicEvent[]>('GET', path),
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
  });
  useChannel(channels.calendar, {
    onMessage: (m) => {
      if (m.type === 'calendar.updated') void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
  return query;
}

export function useCalendarStatus() {
  const { client } = useSession();
  return useQuery({
    queryKey: CALENDAR_KEYS.status,
    queryFn: () => client.request<CalendarStatus>('GET', '/api/v1/calendar/status'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
