import type { ActivitySnapshot } from '@cip/contracts';
import { Card, CardContent, CardHeader, CardTitle, cn, StatusBadge, type StatusTone } from '@cip/ui';
import type { ShownPulse } from '../../lib/brain/mapping.js';
import { type QualityTier, TIER } from '../../lib/brain/quality.js';
import {
  type BrainInput,
  type BrainState,
  describeError,
  describePulse,
  formatRate,
  stateReason,
  STATE_LABEL,
} from '../../lib/brain/state.js';
import { formatAge, formatInstant, formatTime } from '../../lib/format.js';
import { VENUE_LABEL } from '../../lib/market.js';

const STATE_TONE: Record<BrainState, StatusTone> = {
  disconnected: 'warn',
  error: 'crit',
  analysing: 'info',
  receiving: 'ok',
  idle: 'info',
};

const LAST_RESULT = { accepted: 'accepted', rejected: 'rejected by the checks', failed: 'failed' } as const;
const INGEST_STATE = {
  ok: 'every venue connected',
  degraded: 'a venue is not connected',
  down: 'not reporting',
};

/** How the 3D view is drawing, for the text status. */
export interface Rendering {
  view: '3d' | '2d';
  paused: boolean;
  reducedMotion: boolean;
  hidden: boolean;
  fps: number | null;
  tier: QualityTier | null;
  auto: boolean;
}

function renderingText(r: Rendering): string {
  if (r.view === '2d') return '2D view: no animation.';
  if (r.paused) return 'Animation paused.';
  if (r.hidden) return 'Paused while this tab is hidden.';
  if (r.reducedMotion) return 'Still image: your system asks for reduced motion.';
  const quality = r.tier ? `${TIER[r.tier].label} quality${r.auto ? ' (automatic)' : ''}` : '';
  return r.fps === null ? `Starting… ${quality}` : `${Math.round(r.fps)} frames a second, ${quality}.`;
}

function venues(s: ActivitySnapshot): string {
  const parts = Object.entries(s.ingest.perVenue).map(
    ([v, n]) => `${VENUE_LABEL[v as keyof typeof VENUE_LABEL] ?? v} ${formatRate(n)}`,
  );
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * The brain's text status (NFR-10): always next to the canvas, and the whole story without it. The
 * state is announced politely when it changes; the numbers are not announced.
 */
export function BrainStatus({
  state,
  input,
  pulses,
  instrumentName,
  rendering,
  now,
  timeZone,
}: {
  state: BrainState;
  input: BrainInput;
  pulses: readonly ShownPulse[];
  instrumentName: (id: string) => string | null;
  rendering: Rendering;
  now: number;
  timeZone: string;
}) {
  const s = input.snapshot;
  const latest = [...pulses].reverse().slice(0, 6);
  return (
    <Card aria-labelledby="brain-status-title" className="h-fit">
      <CardHeader>
        <CardTitle id="brain-status-title">Status</CardTitle>
        <StatusBadge tone={STATE_TONE[state]} label={STATE_LABEL[state]} />
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p data-brain-state={state} className="text-fg">
          {stateReason(state, input)}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {`System brain: ${STATE_LABEL[state]}`}
        </p>
        {s ? (
          <dl className="space-y-1.5">
            <div>
              <dt className="font-medium text-fg">Ingestion</dt>
              <dd className="text-fg-muted" data-brain-ingest="">
                {formatRate(s.ingest.msgsPerSec)} venue messages a second{venues(s)};{' '}
                {INGEST_STATE[s.ingest.state]}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-fg">Analysis</dt>
              <dd className="text-fg-muted">
                {formatRate(s.analysis.candlesPerSec)} candles a second; {s.analysis.activeJobs} analysing,{' '}
                {s.analysis.backlog} waiting, {s.analysis.paused} held back
              </dd>
            </div>
            <div>
              <dt className="font-medium text-fg">AI</dt>
              <dd className="text-fg-muted">
                {s.ai.inflight > 0 ? 'a call in progress' : 'no call in progress'}
                {s.ai.queued > 0 ? `, ${s.ai.queued} waiting` : ''}
                {s.ai.lastResult && s.ai.lastCompletedAt !== null
                  ? `; the last ${LAST_RESULT[s.ai.lastResult]} ${formatAge(now - s.ai.lastCompletedAt)} ago`
                  : '; none yet'}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-fg">Alerts</dt>
              <dd className="text-fg-muted">{s.alerts.firedLastMin} fired in the last minute</dd>
            </div>
            <div>
              <dt className="font-medium text-fg">Problems</dt>
              <dd className={cn(s.errors.length ? 'text-fg' : 'text-fg-muted')}>
                {s.errors.length ? (
                  <ul className="list-disc pl-4">
                    {s.errors.map((e) => (
                      <li key={`${e.component}:${e.severity}`}>{describeError(e)}</li>
                    ))}
                  </ul>
                ) : (
                  'None'
                )}
              </dd>
            </div>
          </dl>
        ) : null}
        <div>
          <h3 className="font-medium text-fg">Latest events</h3>
          {latest.length ? (
            <ol className="mt-1 space-y-0.5 text-fg-muted" data-brain-pulses="">
              {latest.map((p) => (
                <li key={`${p.pulse.kind}:${p.pulse.refId}:${p.at}`}>
                  <span className="font-mono tabular-nums" title={formatInstant(p.at, timeZone)}>
                    {formatTime(p.at, timeZone)}
                  </span>{' '}
                  {describePulse(p.pulse, instrumentName)}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-fg-muted">
              None since you opened this page. Setup changes, sweeps, market structure shifts, AI analyses and
              alerts appear here as they happen.
            </p>
          )}
        </div>
        <p className="text-xs text-fg-muted" data-brain-rendering="">
          {renderingText(rendering)}
        </p>
      </CardContent>
    </Card>
  );
}
