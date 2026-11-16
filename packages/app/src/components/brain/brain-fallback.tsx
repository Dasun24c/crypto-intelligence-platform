import type { ActivitySnapshot } from '@cip/contracts';
import { targetParams } from '../../lib/brain/mapping.js';
import { type BrainState, REGION_COLOUR, REGION_LABEL, REGIONS } from '../../lib/brain/state.js';

const ALARM_TEXT = { 0.5: 'warning', 1: 'problem' } as const;

/**
 * The 2D view (architecture §11): the same state as the 3D brain, a meter per region, no canvas. Shown
 * when WebGL2 is missing, when the canvas fails, or when the user picks it.
 */
export function BrainFallback({
  state,
  snapshot,
  why,
}: {
  state: BrainState;
  snapshot: ActivitySnapshot | null;
  why: string | null;
}) {
  const p = targetParams(state, snapshot);
  return (
    <div className="flex h-full flex-col justify-center gap-4 p-6" data-brain-view="2d">
      {why ? <p className="text-sm text-fg-muted">{why}</p> : null}
      <ul className="space-y-3">
        {REGIONS.map((r) => {
          // The glow runs from 0.15 (at rest) to 1: shown as 0–100.
          const level = Math.round(Math.max(0, Math.min(1, (p.glow[r] - 0.15) / 0.85)) * 100);
          const alarm = p.alarm[r] >= 1 ? 1 : p.alarm[r] >= 0.5 ? 0.5 : 0;
          return (
            <li key={r} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <span className="flex items-center gap-2 text-fg">
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: REGION_COLOUR[r] }}
                    aria-hidden
                  />
                  {REGION_LABEL[r]}
                </span>
                <span className="text-fg-muted">
                  {level} %{alarm ? `, ${ALARM_TEXT[alarm]}` : ''}
                </span>
              </div>
              <div
                role="meter"
                aria-label={`${REGION_LABEL[r]} activity`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={level}
                className="h-2 overflow-hidden rounded-full bg-surface-3"
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${level}%`,
                    backgroundColor: alarm === 1 ? 'var(--color-crit)' : REGION_COLOUR[r],
                    opacity: state === 'disconnected' ? 0.35 : 1,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
