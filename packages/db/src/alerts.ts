import { type Kysely, sql } from 'kysely';
import type { AlertEventRow, AlertRuleRow, Database } from './types.js';

/**
 * Alert queries shared by the analyzer (evaluation), the jobs service (delivery) and the API
 * (ADR 020). Rows become contract objects in `@cip/alerts` (`ruleFromRow`, `eventFromRow`).
 */

/** The rules the analyzer evaluates: enabled and not removed. */
export function activeAlertRules(db: Kysely<Database>): Promise<AlertRuleRow[]> {
  return db
    .selectFrom('alerts.rules')
    .selectAll()
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .execute();
}

/** Changes whenever a rule is added, edited, enabled, disabled or removed: the analyzer reloads on change. */
export async function alertRulesFingerprint(db: Kysely<Database>): Promise<string> {
  const row = await db
    .selectFrom('alerts.rules')
    .select((eb) => [
      eb.fn.countAll<string>().as('n'),
      sql<string | null>`max(updated_at)::text`.as('latest'),
      sql<string>`coalesce(sum(version), 0)::text`.as('versions'),
    ])
    .executeTakeFirstOrThrow();
  return `${row.n}:${row.latest ?? '-'}:${row.versions}`;
}

export interface NewAlertEvent {
  id: string;
  ruleId: string;
  firedAt: number;
  dedupeKey: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  sourceRefs: Record<string, unknown>;
  late: boolean;
}

/** Records a fired occurrence; null when the rule already fired it (`UNIQUE (rule_id, dedupe_key)`). */
export async function insertAlertEvent(db: Kysely<Database>, e: NewAlertEvent): Promise<string | null> {
  const row = await db
    .insertInto('alerts.events')
    .values({
      id: e.id,
      rule_id: e.ruleId,
      fired_at: new Date(e.firedAt),
      dedupe_key: e.dedupeKey,
      severity: e.severity,
      title: e.title,
      body: e.body,
      source_refs: e.sourceRefs,
      late: e.late,
    })
    .onConflict((oc) => oc.columns(['rule_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** An event with its rule (owner, name, channels, quiet hours): what delivery needs. */
export async function alertEventForDelivery(
  db: Kysely<Database>,
  eventId: string,
): Promise<{ event: AlertEventRow; rule: AlertRuleRow } | null> {
  const event = await db.selectFrom('alerts.events').selectAll().where('id', '=', eventId).executeTakeFirst();
  if (!event) return null;
  const rule = await db
    .selectFrom('alerts.rules')
    .selectAll()
    .where('id', '=', event.rule_id)
    .executeTakeFirstOrThrow();
  return { event, rule };
}
