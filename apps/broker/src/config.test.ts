import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrokerEnvSchema, loadBrokerConfig } from './config.js';

describe('broker configuration', () => {
  it('lists every setting in scripts/server-env-names.json, so the artefact scan can look for it', () => {
    const listed = JSON.parse(
      readFileSync(new URL('../../../scripts/server-env-names.json', import.meta.url), 'utf8'),
    ) as string[];
    expect(listed).toEqual(expect.arrayContaining(Object.keys(BrokerEnvSchema.shape)));
  });

  it('fails fast without a database or Redis', () => {
    expect(() => loadBrokerConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('applies defaults', () => {
    const c = loadBrokerConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/cip',
      REDIS_URL: 'redis://valkey:6379',
    });
    expect(c.OPS_PORT).toBe(9468);
    expect(c.LOG_PRETTY).toBe(false);
  });
});
