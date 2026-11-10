import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnalyzerEnvSchema, loadAnalyzerConfig } from './config.js';

describe('analyzer configuration', () => {
  it('lists every setting in scripts/server-env-names.json, so the artefact scan can look for it', () => {
    const listed = JSON.parse(
      readFileSync(new URL('../../../scripts/server-env-names.json', import.meta.url), 'utf8'),
    ) as string[];
    expect(listed).toEqual(expect.arrayContaining(Object.keys(AnalyzerEnvSchema.shape)));
  });

  it('fails fast without a database or Redis', () => {
    expect(() => loadAnalyzerConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('applies defaults', () => {
    const c = loadAnalyzerConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/cip',
      REDIS_URL: 'redis://valkey:6379',
    });
    expect(c.OPS_PORT).toBe(9466);
    expect(c.LOG_PRETTY).toBe(false);
  });
});
