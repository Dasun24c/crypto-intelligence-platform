import { useQuery } from '@tanstack/react-query';
import type { Closure, Instrument } from '@cip/contracts';
import { useSession } from '../session.js';
import { ApiError } from './client.js';

export const QUERY_KEYS = {
  instruments: ['instruments'],
  adminInstruments: ['admin', 'instruments'],
  health: ['system', 'health'],
  feeds: ['system', 'feeds'],
  goldClosures: ['market', 'closures', 'gold'],
} as const;

/** Enabled instruments (`GET /instruments`). */
export function useInstruments() {
  const { client } = useSession();
  return useQuery({
    queryKey: QUERY_KEYS.instruments,
    queryFn: () => client.request<Instrument[]>('GET', '/api/v1/instruments'),
    staleTime: 60_000,
  });
}

/** The gold-market closure calendar around now (the API's default window: −7 d to +56 d). */
export function useGoldClosures() {
  const { client } = useSession();
  return useQuery({
    queryKey: QUERY_KEYS.goldClosures,
    queryFn: () => client.request<Closure[]>('GET', '/api/v1/market/closures?calendar=gold'),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}

/** True for the 503 the ticker and book endpoints answer while a feed is not streaming. */
export function isNoLiveData(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}
