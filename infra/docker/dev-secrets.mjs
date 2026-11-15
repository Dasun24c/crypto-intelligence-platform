// Generates the local stack's secrets on first start (never committed, never reused across clones):
// the JWT signing key, the MFA encryption key and one database password per role, plus ready-made
// connection strings for containers (host "db") and for tools on the host ("localhost").
// Existing files are kept, so restarting the stack does not invalidate sessions or data.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '/secrets';
mkdirSync(dir, { recursive: true });

function ensure(name, create) {
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, create(), { mode: 0o444 });
  return readFileSync(path, 'utf8').trim();
}

ensure('jwt-ed25519.pem', () =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
);
ensure('mfa-key', () => randomBytes(32).toString('base64'));

const roles = {
  cip_owner: 'owner',
  svc_api: 'svc_api',
  svc_ingestor: 'svc_ingestor',
  svc_analyzer: 'svc_analyzer',
  svc_jobs: 'svc_jobs',
};
for (const [user, name] of Object.entries(roles)) {
  const password = ensure(`db-password-${name}`, () => randomBytes(18).toString('base64url'));
  ensure(`db-url-${name}`, () => `postgres://${user}:${password}@db:5432/cip`);
  ensure(
    `db-url-host-${name}`,
    () => `postgres://${user}:${password}@localhost:${process.env.CIP_DB_PORT ?? 15432}/cip`,
  );
}
console.log(`secrets ready in ${dir}`);
