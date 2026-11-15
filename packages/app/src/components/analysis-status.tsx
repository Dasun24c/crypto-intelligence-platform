import type { RunStatus } from '@cip/contracts';
import { Badge, StatusBadge, type StatusTone } from '@cip/ui';

const RUN_STATUS: Record<RunStatus, [StatusTone | null, string]> = {
  running: ['ok', 'Live'],
  warming_up: ['info', 'Warming up'],
  completed: [null, 'Ended'],
  failed: ['crit', 'Failed'],
  superseded: ['warn', 'Replaced by a newer run'],
};

/** An analysis run's state in words; "Not analysed" when the instrument has no run. */
export function RunStatusBadge({ status }: { status: RunStatus | null }) {
  if (status === null) return <Badge>Not analysed</Badge>;
  const [tone, label] = RUN_STATUS[status];
  return tone === null ? <Badge>{label}</Badge> : <StatusBadge tone={tone} label={label} />;
}
