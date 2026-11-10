import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiEnvSchema, loadApiConfig } from './config.js';

describe('api configuration', () => {
  it('lists every setting in scripts/server-env-names.json, so the artefact scan can look for it', () => {
    const listed = JSON.parse(
      readFileSync(new URL('../../../scripts/server-env-names.json', import.meta.url), 'utf8'),
    ) as string[];
    expect(listed).toEqual(expect.arrayContaining(Object.keys(ApiEnvSchema.shape)));
  });

  it('fails fast, naming each missing secret without echoing values', () => {
    expect(() => loadApiConfig({ MFA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(
      /DATABASE_URL[\s\S]*AUTH_JWT_PRIVATE_KEY[\s\S]*MFA_ENCRYPTION_KEY/,
    );
  });
});
