import { type Kysely, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from './client.js';
import { migrateToLatest } from './migrator.js';
import { verifyAuditChain } from './audit.js';
import type { Database } from './types.js';

const ownerUrl = inject('dbOwnerUrl');
const roleUrls = inject('dbRoleUrls');

let owner: Kysely<Database>;
let api: Kysely<Database>;

beforeAll(() => {
  owner = createDb({ connectionString: ownerUrl, max: 2 });
  api = createDb({ connectionString: roleUrls.svc_api, max: 12 });
});

afterAll(async () => {
  await owner.destroy();
  await api.destroy();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

function appendAudit(db: Kysely<Database>, action: string, details: Record<string, unknown> = {}) {
  return db
    .insertInto('app.audit_log')
    .values({ actor_type: 'system', action, details, ip: '203.0.113.7', user_agent: 'vitest' })
    .returning(['chain_seq'])
    .executeTakeFirstOrThrow();
}

describe('migrations', () => {
  it('are all applied and re-running them is a no-op', async () => {
    const { rows } = await sql<{
      name: string;
    }>`SELECT name FROM ops.schema_migrations ORDER BY name`.execute(owner);
    expect(rows.map((r) => r.name)).toEqual([
      '0001_extensions_and_schemas',
      '0002_app_users_and_tokens',
      '0003_audit_log',
      '0004_service_roles_and_grants',
    ]);
    const again = await migrateToLatest(owner);
    expect(again.error).toBeUndefined();
    expect(again.applied).toEqual([]);
  });

  it('installs TimescaleDB 2.31 on PostgreSQL 18', async () => {
    const { rows } = await sql<{ extname: string; extversion: string }>`
      SELECT extname, extversion FROM pg_extension WHERE extname IN ('timescaledb', 'citext') ORDER BY extname
    `.execute(owner);
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'timescaledb']);
    expect(rows.find((r) => r.extname === 'timescaledb')?.extversion).toBe('2.31.0');
    const { rows: v } = await sql<{ server_version_num: string }>`SHOW server_version_num`.execute(owner);
    expect(Number(v[0]!.server_version_num)).toBeGreaterThanOrEqual(180000);
  });

  it('match the Kysely table types', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'app'
    `.execute(owner);
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);
    const { TABLE_COLUMNS } = await import('./columns.js');
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      expect(actual[table.replace('app.', '')]?.sort(), table).toEqual([...columns].sort());
    }
  });
});

describe('audit log', () => {
  it('chains every row and verifies', async () => {
    const first = await appendAudit(api, 'test.chain.first');
    const second = await appendAudit(api, 'test.chain.second', { n: 2 });
    expect(Number(second.chain_seq)).toBe(Number(first.chain_seq) + 1);
    const row = await owner
      .selectFrom('app.audit_log')
      .select(['prev_hash', 'hash'])
      .where('chain_seq', '=', second.chain_seq)
      .executeTakeFirstOrThrow();
    const prev = await owner
      .selectFrom('app.audit_log')
      .select(['hash'])
      .where('chain_seq', '=', first.chain_seq)
      .executeTakeFirstOrThrow();
    expect(row.prev_hash.equals(prev.hash)).toBe(true);
    expect(await verifyAuditChain(owner)).toMatchObject({ ok: true, firstBrokenSeq: null });
  });

  it('stays a single unbroken chain under concurrent writers', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => appendAudit(api, 'test.concurrent', { i })));
    const result = await verifyAuditChain(owner);
    expect(result.ok).toBe(true);
    const { rows } = await sql<{ n: string; max: string }>`
      SELECT count(*) AS n, max(chain_seq) AS max FROM app.audit_log
    `.execute(owner);
    expect(rows[0]!.n).toBe(rows[0]!.max); // contiguous 1..n
  });

  it('refuses UPDATE, DELETE and TRUNCATE for the api role (no privilege)', async () => {
    expect(await sqlState(sql`UPDATE app.audit_log SET action = 'x'`.execute(api))).toBe('42501');
    expect(await sqlState(sql`DELETE FROM app.audit_log`.execute(api))).toBe('42501');
    expect(await sqlState(sql`TRUNCATE app.audit_log`.execute(api))).toBe('42501');
  });

  it('refuses UPDATE and DELETE even for the owner (append-only trigger)', async () => {
    expect(await sqlState(sql`UPDATE app.audit_log SET action = 'x'`.execute(owner))).toBe('42501');
    expect(await sqlState(sql`DELETE FROM app.audit_log`.execute(owner))).toBe('42501');
    expect(await sqlState(sql`TRUNCATE app.audit_log`.execute(owner))).toBe('42501');
  });

  it('detects tampering by someone able to bypass the triggers', async () => {
    const victim = await appendAudit(api, 'test.tamper.victim');
    await appendAudit(api, 'test.tamper.after');
    // Simulate a privileged attacker: drop to replica mode so the append-only trigger does not fire.
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query('UPDATE app.audit_log SET details = \'{"edited": true}\' WHERE chain_seq = $1', [
        victim.chain_seq,
      ]);
      await client.query('COMMIT');
      const result = await verifyAuditChain(owner);
      expect(result).toMatchObject({ ok: false, firstBrokenSeq: Number(victim.chain_seq) });
    } finally {
      // Restore the row so later tests see a valid chain again.
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query("UPDATE app.audit_log SET details = '{}' WHERE chain_seq = $1", [victim.chain_seq]);
      await client.query('COMMIT');
      await client.end();
    }
    expect((await verifyAuditChain(owner)).ok).toBe(true);
  });
});

describe('service roles', () => {
  it('cannot create objects or touch tables outside their grants', async () => {
    expect(await sqlState(sql`CREATE TABLE app.sneaky (id int)`.execute(api))).toBe('42501');
    const ingestor = createDb({ connectionString: roleUrls.svc_ingestor, max: 1 });
    try {
      expect(await sqlState(sql`SELECT 1 FROM app.users`.execute(ingestor))).toBe('42501');
      expect(
        await sqlState(
          sql`INSERT INTO app.audit_log (actor_type, action) VALUES ('system', 'x')`.execute(ingestor),
        ),
      ).toBe('42501');
    } finally {
      await ingestor.destroy();
    }
  });
});
