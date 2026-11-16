/**
 * Frame-time telemetry and adaptive quality for the 3D brain (NFR-12, ADR 024): High, Medium or Low,
 * chosen by the user or, with Auto, lowered when the frame rate falls below 45 fps and raised again
 * after a while above 57 fps. Pure state: the scene feeds it each frame's time.
 */

export const QUALITY_TIERS = ['high', 'medium', 'low'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
export const QUALITY_CHOICES = ['auto', ...QUALITY_TIERS] as const;
export type QualityChoice = (typeof QUALITY_CHOICES)[number];

export const TIER: Readonly<Record<QualityTier, { particles: number; maxDpr: number; label: string }>> = {
  high: { particles: 20_000, maxDpr: 2, label: 'High' },
  medium: { particles: 8_000, maxDpr: 1.5, label: 'Medium' },
  low: { particles: 3_000, maxDpr: 1, label: 'Low' },
};

/** Auto lowers the quality when the frame rate over this window is below DROP_BELOW_FPS. */
export const WINDOW_MS = 2_000;
export const DROP_BELOW_FPS = 45;
/** …and raises it after RAISE_AFTER_MS above RAISE_ABOVE_FPS. */
export const RAISE_ABOVE_FPS = 57;
export const RAISE_AFTER_MS = 10_000;
/** A frame longer than this is a pause (a hidden tab, a stopped loop), not slowness: it is not counted. */
export const PAUSE_MS = 250;

export class QualityController {
  tier: QualityTier;
  /** Frames a second over the last window; null until a window is full. */
  fps: number | null = null;
  /** Frames drawn since it started. */
  frames = 0;
  private window: { at: number; dt: number }[] = [];
  private windowStart: number | null = null;
  private goodSince: number | null = null;

  constructor(readonly choice: QualityChoice) {
    this.tier = choice === 'auto' ? 'high' : choice;
  }

  /** A frame that took `dtMs` ended at `now`; returns the tier to draw at, which Auto may change. */
  frame(dtMs: number, now: number): QualityTier {
    this.frames++;
    if (dtMs > PAUSE_MS || dtMs <= 0) {
      this.reset();
      return this.tier;
    }
    this.windowStart ??= now - dtMs;
    this.window.push({ at: now, dt: dtMs });
    while (this.window.length > 0 && now - this.window[0]!.at > WINDOW_MS) this.window.shift();
    if (now - this.windowStart < WINDOW_MS) return this.tier;
    const total = this.window.reduce((a, f) => a + f.dt, 0);
    this.fps = total > 0 ? (this.window.length * 1000) / total : null;
    if (this.choice !== 'auto' || this.fps === null) return this.tier;

    if (this.fps < DROP_BELOW_FPS) {
      const lower = QUALITY_TIERS[QUALITY_TIERS.indexOf(this.tier) + 1];
      if (lower) {
        this.tier = lower;
        this.reset();
      }
      this.goodSince = null;
      return this.tier;
    }
    if (this.fps > RAISE_ABOVE_FPS) {
      this.goodSince ??= now;
      const higher = QUALITY_TIERS[QUALITY_TIERS.indexOf(this.tier) - 1];
      if (higher && now - this.goodSince >= RAISE_AFTER_MS) {
        this.tier = higher;
        this.reset();
        this.goodSince = null;
      }
    } else this.goodSince = null;
    return this.tier;
  }

  /** Starts a new window: after a change of tier, or a pause. */
  private reset(): void {
    this.window = [];
    this.windowStart = null;
  }
}

/**
 * Whether the scene draws: never while the tab is hidden, the canvas is off screen or the user paused
 * it; on demand (a still frame per change) with reduced motion; otherwise every frame.
 */
export function frameloopFor(o: {
  hidden: boolean;
  offscreen: boolean;
  paused: boolean;
  reducedMotion: boolean;
}): 'never' | 'demand' | 'always' {
  if (o.hidden || o.offscreen || o.paused) return 'never';
  return o.reducedMotion ? 'demand' : 'always';
}
