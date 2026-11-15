import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  activeAlertRules,
  alertEventForDelivery,
  alertRulesFingerprint,
  insertAlertEvent,
} from './alerts.js';
import { createDb } from './client.js';
import type { Database } from './types.js';

let owner: Kysely<Database>;
let api: Kysely<Database>;
let analyzer: Kysely<Database>;
let jobs: Kysely<Database>;
const userId = randomUUID();

beforeAll(async () => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  api = createDb({ connectionString: inject('dbRoleUrls').svc_api, max: 2 });
  analyzer = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'Alerts',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
});

afterAll(async () => {
  for (const db of [owner, api, analyzer, jobs]) await db.destroy();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const newRule = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  owner_id: userId,
  name: 'Halts',
  condition: { kind: 'feed_health', events: ['halted'] },
  severity: 'warning' as const,
  ...extra,
});

describe('alert rules and events (migration 0011)', () => {
  it('evaluates enabled rules that are not removed, and notices any change through the fingerprint', async () => {
    const before = await alertRulesFingerprint(analyzer);
    const live = newRule();
    const paused = newRule({ enabled: false });
    const removed = newRule({ deleted_at: new Date() });
    await api.insertInto('alerts.rules').values([live, paused, removed]).execute();
    const ids = (await activeAlertRules(analyzer)).map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(paused.id);
    expect(ids).not.toContain(removed.id);
    const added = await alertRulesFingerprint(analyzer);
    expect(added).not.toBe(before);
    // An edit that keeps the count changes it too.
    await api
      .updateTable('alerts.rules')
      .set({ version: 2, updated_at: new Date(Date.now() + 1000) })
      .where('id', '=', live.id)
      .execute();
    expect(await alertRulesFingerprint(analyzer)).not.toBe(added);
  });

  it('records an occurrence once per rule, and finds an event with its rule for delivery', async () => {
    const rule = newRule();
    await api.insertInto('alerts.rules').values(rule).execute();
    const event = {
      id: randomUUID(),
      ruleId: rule.id,
      firedAt: Date.UTC(2026, 10, 12, 10),
      dedupeKey: 'feed:halted:x',
      severity: 'warning' as const,
      title: 'Feed halted',
      body: 'detail',
      sourceRefs: { instrumentId: 'x' },
      late: true,
    };
    expect(await insertAlertEvent(analyzer, event)).toBe(event.id);
    expect(await insertAlertEvent(analyzer, { ...event, id: randomUUID() })).toBeNull();
    const found = await alertEventForDelivery(jobs, event.id);
    expect(found?.event).toMatchObject({ id: event.id, dedupe_key: 'feed:halted:x', late: true });
    expect(found?.rule).toMatchObject({
      id: rule.id,
      owner_id: userId,
      channels: ['in_app'],
      cooldown_sec: 300,
    });
    expect(await alertEventForDelivery(jobs, randomUUID())).toBeNull();
  });

  it('lets each service write only its part (data model §9)', async () => {
    const rule = newRule();
    await api.insertInto('alerts.rules').values(rule).execute();
    const eventId = randomUUID();
    await analyzer
      .insertInto('alerts.events')
      .values({
        id: eventId,
        rule_id: rule.id,
        fired_at: new Date(),
        dedupe_key: 'k',
        severity: 'info',
        title: 't',
        body: 'b',
      })
      .execute();
    const notificationId = randomUUID();
    await jobs
      .insertInto('alerts.notifications')
      .values({ id: notificationId, event_id: eventId, user_id: userId, channel: 'in_app', status: 'sent' })
      .execute();
    // The API marks items read, and nothing else about them.
    await api
      .updateTable('alerts.notifications')
      .set({ read_at: new Date() })
      .where('id', '=', notificationId)
      .execute();
    expect(
      await sqlState(
        api
          .updateTable('alerts.notifications')
          .set({ status: 'failed' })
          .where('id', '=', notificationId)
          .execute(),
      ),
    ).toBe('42501');
    // The analyzer fires events but writes no rules; the API writes no events.
    expect(await sqlState(analyzer.insertInto('alerts.rules').values(newRule()).execute())).toBe('42501');
    expect(
      await sqlState(
        api
          .insertInto('alerts.events')
          .values({
            id: randomUUID(),
            rule_id: rule.id,
            fired_at: new Date(),
            dedupe_key: 'k2',
            severity: 'info',
            title: 't',
            body: 'b',
          })
          .execute(),
      ),
    ).toBe('42501');
    // Rules always deliver to the inbox, and a cooldown stays within a day.
    expect(
      await sqlState(
        api
          .insertInto('alerts.rules')
          .values(newRule({ channels: ['desktop'] }))
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        api
          .insertInto('alerts.rules')
          .values(newRule({ cooldown_sec: 90_000 }))
          .execute(),
      ),
    ).toBe('23514');
  });
});
