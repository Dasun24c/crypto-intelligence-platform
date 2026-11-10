import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, SqlFileMigrationProvider } from './migrator.js';

describe('SqlFileMigrationProvider', () => {
  it('loads the repository migrations in name order', async () => {
    const names = Object.keys(await new SqlFileMigrationProvider(MIGRATIONS_DIR).getMigrations());
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe('0001_extensions_and_schemas');
  });

  it('rejects badly named files instead of silently reordering them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cip-mig-'));
    writeFileSync(join(dir, '0001_ok.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'Add Users.sql'), 'SELECT 1;');
    await expect(new SqlFileMigrationProvider(dir).getMigrations()).rejects.toThrow(/0001_snake_case/);
  });
});
