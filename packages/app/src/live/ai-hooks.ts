import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiStatus,
  type AiTrigger,
  type AiUsage,
  channels,
  type Page,
  type SetupSummary,
} from '@cip/contracts';
import type { InFlight } from '../lib/ai.js';
import { OPEN_STATES } from '../lib/setups.js';
import { useSession } from '../session.js';
import { POLL_MS, useLiveFallback } from './analysis-hooks.js';
import { useChannel } from './hooks.js';
import { setupsPath } from './smc-hooks.js';

export const AI_KEYS = {
  all: ['ai'],
  list: ['ai', 'list'],
  detail: (id: string) => ['ai', 'detail', id] as const,
  usage: ['ai', 'usage'],
} as const;

export interface AiFilters {
  instrumentId?: string;
  status?: AiStatus[];
}

export function aiAnalysesPath(f: AiFilters, limit: number): string {
  const q = new URLSearchParams();
  if (f.instrumentId) q.set('instrumentId', f.instrumentId);
  if (f.status?.length) q.set('status', f.status.join(','));
  q.set('limit', String(limit));
  return `/api/v1/ai/analyses?${q}`;
}

/** `GET /ai/analyses`, newest first; an analysis finishing on the `ai` channel reloads it. */
export function useAiAnalyses(filters: AiFilters, limit: number) {
  const { client } = useSession();
  const polling = useLiveFallback();
  const path = useMemo(() => aiAnalysesPath(filters, limit), [filters, limit]);
  return useQuery({
    queryKey: [...AI_KEYS.list, path],
    queryFn: () => client.request<Page<AiAnalysisSummary>>('GET', path),
    refetchInterval: polling ? POLL_MS : false,
    placeholderData: (previous) => previous,
  });
}

/** `GET /ai/analyses/{id}`: what was sent and received, what the checks found, what it cost. */
export function useAiAnalysis(id: string | null) {
  const { client } = useSession();
  return useQuery({
    queryKey: AI_KEYS.detail(id ?? ''),
    queryFn: () => client.request<AiAnalysisDetail>('GET', `/api/v1/ai/analyses/${id}`),
    enabled: id !== null,
    // A stored analysis never changes.
    staleTime: Infinity,
  });
}

/** `GET /ai/usage`: the last 30 days and the budget now; the `ai` channel reloads it. */
export function useAiUsage() {
  const { client } = useSession();
  const polling = useLiveFallback();
  return useQuery({
    queryKey: AI_KEYS.usage,
    queryFn: () => client.request<AiUsage>('GET', '/api/v1/ai/usage'),
    refetchInterval: polling ? POLL_MS : 60_000,
  });
}

/** A pair's open setups, for a setup review; nothing is read until a pair is chosen. */
export function useOpenSetups(instrumentId: string | null) {
  const { client } = useSession();
  const path = instrumentId ? setupsPath({ instrumentId, state: [...OPEN_STATES] }, 50) : null;
  return useQuery({
    queryKey: ['setups', 'list', path ?? 'none'],
    queryFn: () => client.request<Page<SetupSummary>>('GET', path!),
    enabled: path !== null,
  });
}

interface LifecycleData {
  analysisId?: unknown;
  instrumentId?: unknown;
  trigger?: unknown;
  analysis?: { id?: unknown };
}

/**
 * The `ai` channel (API contracts §5.3): tracks analyses on their way (queued, then running) and
 * reloads the history and the budget when one finishes or the budget changes. `onDone` hears each
 * finished analysis's id.
 */
export function useAiLive(onDone?: (analysisId: string) => void): { inFlight: InFlight[] } {
  const queryClient = useQueryClient();
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, InFlight>>(new Map());
  const reload = () => void queryClient.invalidateQueries({ queryKey: AI_KEYS.list });
  const reloadUsage = () => void queryClient.invalidateQueries({ queryKey: AI_KEYS.usage });
  useChannel(channels.ai, {
    onMessage: (m) => {
      const d = (m.data ?? {}) as LifecycleData;
      if (m.type === 'ai.queued' || m.type === 'ai.started') {
        if (typeof d.analysisId !== 'string' || typeof d.instrumentId !== 'string') return;
        const id = d.analysisId;
        const entry: InFlight = {
          analysisId: id,
          instrumentId: d.instrumentId,
          trigger: d.trigger as AiTrigger,
          state: m.type === 'ai.queued' ? 'queued' : 'running',
          since: m.ts,
        };
        setInFlight((prev) => {
          // A late `queued` never turns a running analysis back.
          if (prev.get(id)?.state === 'running' && entry.state === 'queued') return prev;
          return new Map(prev).set(id, entry);
        });
        return;
      }
      if (m.type === 'ai.completed' || m.type === 'ai.rejected' || m.type === 'ai.failed') {
        const id = typeof d.analysis?.id === 'string' ? d.analysis.id : null;
        if (id) {
          setInFlight((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          onDone?.(id);
        }
        reload();
        reloadUsage();
        return;
      }
      if (m.type === 'ai.budget') reloadUsage();
    },
    // Missed messages: the lists are read again; what was on its way is no longer known.
    onSnapshot: () => {
      setInFlight(new Map());
      reload();
      reloadUsage();
    },
    onResynced: () => {
      reload();
      reloadUsage();
    },
  });
  return { inFlight: [...inFlight.values()].sort((a, b) => a.since - b.since) };
}
