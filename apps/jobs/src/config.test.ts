import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JobsEnvSchema, loadJobsConfig } from './config.js';

describe('jobs configuration', () => {
  it('lists every setting in scripts/server-env-names.json, so the artefact scan can look for it', () => {
    const listed = JSON.parse(
      readFileSync(new URL('../../../scripts/server-env-names.json', import.meta.url), 'utf8'),
    ) as string[];
    expect(listed).toEqual(expect.arrayContaining(Object.keys(JobsEnvSchema.shape)));
  });

  it('refuses prune intervals under a minute and bad queue prefixes', () => {
    const base = { DATABASE_URL: 'postgres://u:p@db:5432/cip', REDIS_URL: 'redis://valkey:6379' };
    expect(() => loadJobsConfig({ ...base, PRUNE_REFRESH_TOKENS_EVERY_MS: '1000' })).toThrow(
      /PRUNE_REFRESH_TOKENS_EVERY_MS/,
    );
    expect(() => loadJobsConfig({ ...base, QUEUE_PREFIX: 'Bad Prefix' })).toThrow(/QUEUE_PREFIX/);
    expect(loadJobsConfig(base).QUEUE_PREFIX).toBe('cip');
  });
});
