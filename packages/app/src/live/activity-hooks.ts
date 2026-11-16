import { useRef, useState } from 'react';
import {
  type ActivityPulse,
  ActivityPulseSchema,
  type ActivitySnapshot,
  ActivitySnapshotSchema,
  channels,
} from '@cip/contracts';
import type { ShownPulse } from '../lib/brain/mapping.js';
import { useChannel, useLiveConnection } from './hooks.js';

/** Pulses kept for the text status and the scene (the scene shows the newest eight). */
export const KEPT_PULSES = 50;

/** The 3D brain's feed (ADR 024): the latest snapshot, when it arrived, and the pulses since. */
export interface ActivityFeed {
  readonly snapshot: ActivitySnapshot | null;
  /** Client time the latest snapshot arrived. */
  readonly receivedAt: number | null;
  readonly pulses: readonly ShownPulse[];
}

const EMPTY: ActivityFeed = { snapshot: null, receivedAt: null, pulses: [] };

/**
 * Follows `system:activity`: `activity.snapshot` about twice a second and `activity.pulse` as things
 * happen. React renders on each; the scene reads `ref` every frame without rendering. A message that
 * does not match the contract is ignored.
 */
export function useActivityFeed(): {
  feed: ActivityFeed;
  ref: { readonly current: ActivityFeed };
  live: boolean;
} {
  const [feed, setFeed] = useState<ActivityFeed>(EMPTY);
  const ref = useRef<ActivityFeed>(EMPTY);
  const connection = useLiveConnection();
  const apply = (change: (f: ActivityFeed) => ActivityFeed) => {
    ref.current = change(ref.current);
    setFeed(ref.current);
  };
  const snapshot = (data: unknown) => {
    const parsed = ActivitySnapshotSchema.safeParse(data);
    if (parsed.success) apply((f) => ({ ...f, snapshot: parsed.data, receivedAt: Date.now() }));
  };
  const pulse = (data: unknown) => {
    const parsed = ActivityPulseSchema.safeParse(data);
    if (!parsed.success) return;
    const p: ActivityPulse = parsed.data;
    apply((f) => ({ ...f, pulses: [...f.pulses, { pulse: p, at: Date.now() }].slice(-KEPT_PULSES) }));
  };
  useChannel(channels.systemActivity, {
    onSnapshot: snapshot,
    onMessage: (m) => {
      if (m.type === 'activity.snapshot') snapshot(m.data);
      else if (m.type === 'activity.pulse') pulse(m.data);
    },
  });
  return { feed, ref, live: connection.state === 'live' };
}
