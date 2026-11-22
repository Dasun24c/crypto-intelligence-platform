import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository root, where `docker compose` finds the stack (and CI's COMPOSE_FILE applies). */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Runs one read-only query in the running stack's database (`docker compose exec db psql`), for
 * checks that must not go through the API, such as criterion 12.1's reconciliation. The session is
 * read-only (`default_transaction_read_only`); rows come back as objects (`json_agg`).
 */
export function dbQuery<T>(query: string): T[] {
  const out = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      'PGOPTIONS=-c default_transaction_read_only=on',
      'db',
      'psql',
      '-U',
      'cip_owner',
      '-d',
      'cip',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SELECT coalesce(json_agg(q), '[]'::json) FROM (${query}) q`,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.trim()) as T[];
}

/** A value for SQL text: digits only (epoch milliseconds) or a UUID, never free text. */
export function sqlLiteral(value: number | string): string {
  const s = String(value);
  if (/^\d{1,16}$/.test(s)) return s;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return `'${s}'`;
  throw new Error(`not a safe SQL literal: ${s}`);
}
