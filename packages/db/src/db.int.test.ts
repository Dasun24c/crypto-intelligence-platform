import { type Kysely, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from './client.js';
import { migrateToLatest } from './migrator.js';
import { LAUNCH_PROFILE_IDS, launchProfileFor } from './profiles.js';
import { verifyAuditChain } from './audit.js';
import type { Database } from './types.js';
import { CRYPTO_MAJORS_SMC_PARAMS, GOLD_SMC_PARAMS } from '@cip/smc-engine';

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
      '0005_market_schema',
      '0006_analysis_indicators',
      '0007_analysis_smc',
      '0008_analysis_poi',
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
    const { rows } = await sql<{ table_schema: string; table_name: string; column_name: string }>`
      SELECT table_schema, table_name, column_name FROM information_schema.columns
      WHERE table_schema IN ('app', 'market', 'analysis')
    `.execute(owner);
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[`${r.table_schema}.${r.table_name}`] ??= []).push(r.column_name);
    const { TABLE_COLUMNS } = await import('./columns.js');
    expect(Object.keys(actual).sort()).toEqual(Object.keys(TABLE_COLUMNS).sort());
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      expect(actual[table]?.sort(), table).toEqual([...columns].sort());
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

describe('market schema (migration 0005)', () => {
  it('stores time series in hypertables with columnstore and retention policies (data model §8)', async () => {
    const { rows: hypertables } = await sql<{ name: string }>`
      SELECT hypertable_schema || '.' || hypertable_name AS name FROM timescaledb_information.hypertables ORDER BY 1
    `.execute(owner);
    expect(hypertables.map((h) => h.name)).toEqual([
      'analysis.detection_events',
      'analysis.indicator_values',
      'market.candles',
      'market.cross_venue_spreads',
      'market.feed_events',
      'market.orderbook_metrics',
      'market.orderbook_snapshots',
      'market.trades',
    ]);
    const { rows: jobs } = await sql<{ proc: string; name: string; config: Record<string, string> }>`
      SELECT proc_name AS proc, hypertable_schema || '.' || hypertable_name AS name, config
      FROM timescaledb_information.jobs WHERE hypertable_schema IN ('market', 'analysis')
    `.execute(owner);
    const retention = Object.fromEntries(
      jobs.filter((j) => j.proc === 'policy_retention').map((j) => [j.name, j.config['drop_after']]),
    );
    expect(retention).toEqual({
      'market.trades': '14 days',
      'market.orderbook_metrics': '90 days',
      'market.orderbook_snapshots': '14 days',
      'market.feed_events': '365 days',
    });
    const compressed = jobs
      .filter((j) => j.proc !== 'policy_retention')
      .map((j) => j.name)
      .sort();
    expect(compressed).toEqual(hypertables.map((h) => h.name));
  });

  it('seeds the nine launch pairs, with PAXG on the gold calendar and Binance as primary', async () => {
    const rows = await owner
      .selectFrom('market.instruments')
      .select([
        'venue_id',
        'venue_symbol',
        'asset_class',
        'role',
        'underlying_calendar_id',
        'is_primary_venue',
      ])
      .orderBy('venue_id')
      .orderBy('venue_symbol')
      .execute();
    expect(rows.map((r) => `${r.venue_id}:${r.venue_symbol}`)).toEqual([
      'binance:BTCUSDT',
      'binance:ETHUSDT',
      'binance:PAXGUSDT',
      'binance:SOLUSDT',
      'coinbase:BTC-USD',
      'coinbase:ETH-USD',
      'coinbase:PAXG-USD',
      'coinbase:SOL-USD',
      'coinbase:USDT-USD',
    ]);
    const paxg = rows.filter((r) => r.asset_class === 'tokenised_gold');
    expect(paxg.every((r) => r.underlying_calendar_id === 'gold')).toBe(true);
    expect(paxg.map((r) => r.is_primary_venue)).toEqual([true, false]);
    expect(rows.find((r) => r.venue_symbol === 'USDT-USD')?.role).toBe('reference');
  });

  it('gives each service only the market rights it needs (data model §9)', async () => {
    const candle = {
      instrument_id: '019a6f00-0000-7000-8000-000000000001',
      timeframe: '1m' as const,
      open_time: new Date(Date.UTC(2026, 10, 10, 12, 0)),
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      volume: '0',
      quote_volume: '0',
      source: 'exchange_kline' as const,
      quality: 'complete' as const,
      finalized_at: new Date(),
    };
    const ingestor = createDb({ connectionString: roleUrls.svc_ingestor, max: 1 });
    const jobs = createDb({ connectionString: roleUrls.svc_jobs, max: 1 });
    try {
      await ingestor.insertInto('market.candles').values(candle).execute();
      expect(
        await sqlState(
          api
            .insertInto('market.candles')
            .values({ ...candle, timeframe: '5m' })
            .execute(),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          ingestor
            .updateTable('market.instruments')
            .set({ enabled: false })
            .where('venue_symbol', '=', 'BTCUSDT')
            .execute(),
        ),
      ).toBe('42501');
      await jobs
        .updateTable('market.instruments')
        .set({ venue_status: 'trading' })
        .where('venue_symbol', '=', 'BTCUSDT')
        .execute();
      expect(
        await sqlState(
          jobs
            .updateTable('market.instruments')
            .set({ enabled: false })
            .where('venue_symbol', '=', 'BTCUSDT')
            .execute(),
        ),
      ).toBe('42501');
      await api
        .updateTable('market.instruments')
        .set({ enabled: true })
        .where('venue_symbol', '=', 'BTCUSDT')
        .execute();
    } finally {
      await ingestor.destroy();
      await jobs.destroy();
    }
  });
});

describe('analysis schema (migration 0006)', () => {
  it('seeds the two launch profiles, hashed over their settings, and assigns one to every instrument', async () => {
    const profiles = await owner
      .selectFrom('market.instrument_profiles')
      .select(['id', 'name', 'version', 'params', 'params_hash'])
      .orderBy('name')
      .orderBy('version')
      .execute();
    // Version 1 (0006) holds the indicators, version 2 (0007) adds the SMC settings, version 3 (0008)
    // the zone settings, and is current.
    expect(profiles.map((p) => [p.id, p.name, p.version])).toEqual([
      ['019a6f00-0000-7000-8000-000000000201', 'crypto-majors', 1],
      ['019a6f00-0000-7000-8000-000000000203', 'crypto-majors', 2],
      [LAUNCH_PROFILE_IDS['crypto-majors'], 'crypto-majors', 3],
      ['019a6f00-0000-7000-8000-000000000202', 'gold', 1],
      ['019a6f00-0000-7000-8000-000000000204', 'gold', 2],
      [LAUNCH_PROFILE_IDS.gold, 'gold', 3],
    ]);
    // The SMC settings are exactly the engine's launch defaults (rulebook §10).
    const smc = (id: string) => (profiles.find((p) => p.id === id)!.params as { smc: unknown }).smc;
    expect(smc(LAUNCH_PROFILE_IDS['crypto-majors'])).toEqual(CRYPTO_MAJORS_SMC_PARAMS);
    expect(smc(LAUNCH_PROFILE_IDS.gold)).toEqual(GOLD_SMC_PARAMS);
    for (const p of profiles) {
      const { rows } = await sql<{ hash: string }>`
        SELECT encode(sha256(convert_to(params::text, 'UTF8')), 'hex') AS hash
        FROM market.instrument_profiles WHERE id = ${p.id}
      `.execute(owner);
      expect(p.params_hash).toBe(rows[0]!.hash);
      expect((p.params as { indicators: { rsi: { period: number } } }).indicators.rsi.period).toBe(14);
    }
    const instruments = await owner
      .selectFrom('market.instruments')
      .select(['asset_class', 'profile_id'])
      .where('venue_id', '!=', 'replay')
      .execute();
    expect(instruments).toHaveLength(9);
    for (const i of instruments) expect(i.profile_id).toBe(launchProfileFor(i.asset_class));
  });

  it('keeps one open live run per instrument and lets only the analyzer and jobs write runs', async () => {
    const analyzer = createDb({ connectionString: roleUrls.svc_analyzer, max: 1 });
    const instrumentId = '019a6f00-0000-7000-8000-000000000003';
    const run = (id: string) => ({
      id,
      mode: 'live' as const,
      instrument_id: instrumentId,
      profile_id: LAUNCH_PROFILE_IDS['crypto-majors'],
      ruleset_version: 'test',
      params_hash: 'x',
      from_time: new Date(Date.UTC(2026, 10, 10)),
      status: 'running' as const,
    });
    try {
      await analyzer
        .insertInto('analysis.detection_runs')
        .values(run('019a6f00-0000-7000-8000-00000000f001'))
        .execute();
      expect(
        await sqlState(
          analyzer
            .insertInto('analysis.detection_runs')
            .values(run('019a6f00-0000-7000-8000-00000000f002'))
            .execute(),
        ),
      ).toBe('23505');
      await analyzer
        .insertInto('analysis.indicator_values')
        .values({
          instrument_id: instrumentId,
          timeframe: '1h',
          open_time: new Date(Date.UTC(2026, 10, 10, 12)),
          run_id: '019a6f00-0000-7000-8000-00000000f001',
          rsi: 55.5,
          macd: -2.5e-17,
          macd_signal: null,
          macd_hist: null,
          ema_fast: 1.0000000000000002,
          ema_mid: null,
          ema_slow: null,
          vwap: null,
          atr: null,
          volume_z: null,
          volume_anomaly: null,
          trend: null,
          trend_strength: null,
        })
        .execute();
      // Doubles come back exactly as written. (node-postgres sends -0 as "0"; the indicators never produce -0.)
      const value = await api
        .selectFrom('analysis.indicator_values')
        .select(['rsi', 'macd', 'ema_fast'])
        .where('run_id', '=', '019a6f00-0000-7000-8000-00000000f001')
        .executeTakeFirstOrThrow();
      expect(value.rsi).toBe(55.5);
      expect(value.macd).toBe(-2.5e-17);
      expect(value.ema_fast).toBe(1.0000000000000002);
      expect(
        await sqlState(
          api
            .insertInto('analysis.detection_runs')
            .values(run('019a6f00-0000-7000-8000-00000000f003'))
            .execute(),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          analyzer
            .deleteFrom('analysis.indicator_values')
            .where('instrument_id', '=', instrumentId)
            .execute(),
        ),
      ).toBe('42501');
      await analyzer
        .updateTable('analysis.detection_runs')
        .set({ status: 'superseded', finished_at: new Date() })
        .where('id', '=', '019a6f00-0000-7000-8000-00000000f001')
        .execute();
      // Once the first run is closed, a new live run may open.
      await analyzer
        .insertInto('analysis.detection_runs')
        .values(run('019a6f00-0000-7000-8000-00000000f002'))
        .execute();
    } finally {
      await owner.deleteFrom('analysis.indicator_values').where('instrument_id', '=', instrumentId).execute();
      await owner.deleteFrom('analysis.detection_runs').where('instrument_id', '=', instrumentId).execute();
      await analyzer.destroy();
    }
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
