import {
  type AlertEvent,
  type AlertRule,
  AlertConditionSchema,
  AlertScopeSchema,
  NotificationChannelSchema,
  QuietHoursSchema,
} from '@cip/contracts';

/** The columns of `alerts.rules` (structural: this package does not depend on `@cip/db`). */
export interface AlertRuleRowLike {
  id: string;
  owner_id: string;
  name: string;
  enabled: boolean;
  scope: unknown;
  condition: unknown;
  severity: 'info' | 'warning' | 'critical';
  cooldown_sec: number;
  channels: string[];
  quiet_hours: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * A stored rule as the contracts describe it, or null when its JSON no longer validates (a rule
 * written by an older version): such a rule is never evaluated.
 */
export function ruleFromRow(row: AlertRuleRowLike): AlertRule | null {
  const condition = AlertConditionSchema.safeParse(row.condition);
  const scope = AlertScopeSchema.safeParse(row.scope ?? {});
  const quiet = row.quiet_hours === null ? null : QuietHoursSchema.safeParse(row.quiet_hours);
  const channels = row.channels.filter((c) => NotificationChannelSchema.safeParse(c).success);
  if (!condition.success || !scope.success || (quiet !== null && !quiet.success)) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    enabled: row.enabled,
    scope: scope.data,
    condition: condition.data,
    severity: row.severity,
    cooldownSec: row.cooldown_sec,
    channels: channels as AlertRule['channels'],
    quietHours: quiet === null ? null : quiet.data,
    version: row.version,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

/** The columns of `alerts.events`. */
export interface AlertEventRowLike {
  id: string;
  rule_id: string;
  fired_at: Date;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  source_refs: Record<string, unknown>;
  late: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function eventFromRow(row: AlertEventRowLike, ruleName: string): AlertEvent {
  const instrumentId = row.source_refs['instrumentId'];
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName,
    firedAt: row.fired_at.getTime(),
    severity: row.severity,
    title: row.title,
    body: row.body,
    instrumentId: typeof instrumentId === 'string' && UUID.test(instrumentId) ? instrumentId : null,
    sourceRefs: row.source_refs,
    late: row.late,
  };
}
