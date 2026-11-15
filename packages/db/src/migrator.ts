import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, type MigrationResultSet, Migrator } from 'kysely/migration';

/** `packages/db/migrations`, both from sources (src/) and from the build (dist/). */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Plain SQL files, applied in name order, each in its own transaction (ADR 006). There are no down
 * migrations: schema changes follow expand/contract, so a deployment never needs to roll back DDL.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string = MIGRATIONS_DIR) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      if (!MIGRATION_FILE.test(file)) {
        throw new Error(`Migration file name must look like 0001_snake_case.sql: ${file}`);
      }
      const text = await readFile(join(this.dir, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

export interface MigrationOutcome {
  applied: string[];
  error?: unknown;
}

export async function migrateToLatest<DB>(db: Kysely<DB>, dir?: string): Promise<MigrationOutcome> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(dir),
    migrationTableSchema: 'ops',
    migrationTableName: 'schema_migrations',
    migrationLockTableName: 'schema_migrations_lock',
  });
  const { error, results }: MigrationResultSet = await migrator.migrateToLatest();
  const applied = (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  return error === undefined ? { applied } : { applied, error };
}
