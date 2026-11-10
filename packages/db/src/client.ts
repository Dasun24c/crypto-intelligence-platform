import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export interface DbOptions {
  connectionString: string;
  /** Pool size per process. Small: four services share one PostgreSQL. */
  max?: number;
  applicationName?: string;
}

export function createPool(opts: DbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'cip',
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(opts: DbOptions | { pool: pg.Pool }): Kysely<Database> {
  const pool = 'pool' in opts ? opts.pool : createPool(opts);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Round-trip check used by readiness probes; returns the latency in milliseconds. */
export async function pingDb(pool: pg.Pool): Promise<number> {
  const started = performance.now();
  await pool.query('SELECT 1');
  return Math.round(performance.now() - started);
}
