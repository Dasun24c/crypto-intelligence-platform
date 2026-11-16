import { Component, lazy, type ReactNode, Suspense, useMemo, useRef, useState } from 'react';
import { Button, Card, CardContent, Label, Select, Spinner } from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { BrainFallback } from '../components/brain/brain-fallback.js';
import type { Telemetry } from '../components/brain/brain-scene.js';
import { BrainStatus } from '../components/brain/brain-status.js';
import {
  hasWebGL2,
  useOffscreen,
  usePageHidden,
  usePrefersReducedMotion,
  useStoredChoice,
} from '../components/brain/browser.js';
import { useActivityFeed } from '../live/activity-hooks.js';
import { frameloopFor, QUALITY_CHOICES, type QualityChoice, TIER } from '../lib/brain/quality.js';
import { type BrainInput, brainState, REGION_COLOUR, REGION_LABEL, REGIONS } from '../lib/brain/state.js';
import { VENUE_LABEL } from '../lib/market.js';
import { useDisplayTimeZone, useNow } from '../session.js';

/** three.js and React Three Fiber load with the scene, after the page and its text status. */
const BrainScene = lazy(() => import('../components/brain/brain-scene.js'));

const VIEWS = ['3d', '2d'] as const;
type View = (typeof VIEWS)[number];
const QUALITY_LABEL: Record<QualityChoice, string> = {
  auto: 'Automatic',
  high: TIER.high.label,
  medium: TIER.medium.label,
  low: TIER.low.label,
};

/** A canvas that fails (a lost or refused WebGL context) gives way to the 2D view. */
class SceneBoundary extends Component<
  { onError: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * System Brain (Phase 10, REQUIREMENTS §5, ADR 024): a live view of what the platform is doing,
 * driven only by the services' activity reports and the events behind the pulses. The text status
 * beside it tells the same story in words.
 */
export function SystemBrainPage() {
  const { feed, ref, live } = useActivityFeed();
  const now = useNow(500);
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const reducedMotion = usePrefersReducedMotion();
  const hidden = usePageHidden();
  const stage = useRef<HTMLDivElement>(null);
  const offscreen = useOffscreen(stage);
  const [paused, setPaused] = useState(false);
  const [view, setView] = useStoredChoice<View>('cip.brain.view', VIEWS, '3d');
  const [quality, setQuality] = useStoredChoice<QualityChoice>('cip.brain.quality', QUALITY_CHOICES, 'auto');
  const webgl2 = useMemo(() => hasWebGL2(), []);
  const [failed, setFailed] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  const input: BrainInput = { snapshot: feed.snapshot, receivedAt: feed.receivedAt, live, now };
  const state = brainState(input);
  const show3d = view === '3d' && webgl2 && failed === null;
  const frameloop = frameloopFor({ hidden, offscreen, paused, reducedMotion });
  const names = useMemo(
    () =>
      new Map((instruments.data ?? []).map((i) => [i.id, `${VENUE_LABEL[i.venue]} ${i.base}/${i.quote}`])),
    [instruments.data],
  );
  const why =
    view === '2d'
      ? null
      : !webgl2
        ? 'This browser cannot draw the 3D view (WebGL2 is not available), so this is the 2D view.'
        : failed !== null
          ? `The 3D view stopped (${failed}), so this is the 2D view.`
          : null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-fg">System Brain</h1>
        <p className="text-sm text-fg-muted">
          A live view of what the platform is doing: venue messages arriving, analysis, AI calls and alerts.
          It moves only when they happen, and the status beside it says the same in words.
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card aria-label="Activity view" className="overflow-hidden">
          <div
            ref={stage}
            className="relative h-[26rem] bg-[radial-gradient(ellipse_at_center,_var(--color-surface-2),_var(--color-surface))] lg:h-[34rem]"
          >
            {show3d ? (
              <SceneBoundary onError={setFailed}>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center">
                      <Spinner label="Loading the 3D view" />
                    </div>
                  }
                >
                  <BrainScene
                    key={quality}
                    feed={ref}
                    live={live}
                    quality={quality}
                    frameloop={frameloop}
                    reducedMotion={reducedMotion}
                    revision={feed.receivedAt ?? 0}
                    onTelemetry={setTelemetry}
                  />
                </Suspense>
              </SceneBoundary>
            ) : (
              <BrainFallback state={state} snapshot={feed.snapshot} why={why} />
            )}
          </div>
          <CardContent className="space-y-3 border-t border-border">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Regions">
              {REGIONS.map((r) => (
                <li key={r} className="flex items-center gap-1.5">
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: REGION_COLOUR[r] }}
                    aria-hidden
                  />
                  {REGION_LABEL[r]}
                </li>
              ))}
              <li>A red, pulsing region: a component there reports a problem.</li>
            </ul>
            <div className="flex flex-wrap items-end gap-3">
              <Button
                size="sm"
                variant="secondary"
                aria-pressed={paused}
                disabled={!show3d}
                onClick={() => setPaused(!paused)}
              >
                {paused ? 'Resume animation' : 'Pause animation'}
              </Button>
              <div className="space-y-1">
                <Label htmlFor="brain-quality">Quality</Label>
                <Select
                  id="brain-quality"
                  value={quality}
                  disabled={!show3d}
                  onChange={(e) => setQuality(e.target.value as QualityChoice)}
                >
                  {QUALITY_CHOICES.map((q) => (
                    <option key={q} value={q}>
                      {QUALITY_LABEL[q]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="brain-view">View</Label>
                <Select id="brain-view" value={view} onChange={(e) => setView(e.target.value as View)}>
                  <option value="3d">3D</option>
                  <option value="2d">2D</option>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
        <BrainStatus
          state={state}
          input={input}
          pulses={feed.pulses}
          instrumentName={(id) => names.get(id) ?? null}
          now={now}
          timeZone={timeZone}
          rendering={{
            view: show3d ? '3d' : '2d',
            paused,
            reducedMotion,
            hidden: hidden || offscreen,
            fps: telemetry?.fps ?? null,
            tier: telemetry?.tier ?? (quality === 'auto' ? 'high' : quality),
            auto: quality === 'auto',
          }}
        />
      </div>
    </div>
  );
}
