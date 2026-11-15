#!/usr/bin/env node
/**
 * HTTPS for the local stack (optional): the desktop app's release builds accept only https://
 * servers, and the local stack serves plain HTTP on :8080. This writes to .secrets/tls (gitignored):
 *
 * - cip-local-ca.crt: a certificate authority that can sign only for `localhost` and `127.0.0.1`
 *   (name constraints). Its private key is deleted as soon as it has signed the certificate below,
 *   so it can never sign anything else, on this machine or any other.
 * - localhost.crt and localhost.key: the certificate Caddy serves on https://localhost:8443.
 * - https.caddy: the site Caddy imports (no file, no HTTPS site).
 *
 * Then trust cip-local-ca.crt for your Windows user (README, "HTTPS for the desktop app") and
 * restart the web service. Needs openssl 1.1.1 or later (Git for Windows includes it). `--force`
 * makes a new authority and certificate, which must be trusted again.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '.secrets', 'tls');
const openssl = process.env.OPENSSL ?? 'openssl';
const file = (name) => join(dir, name);

if (existsSync(file('localhost.crt')) && !process.argv.includes('--force')) {
  console.log(`${file('localhost.crt')} exists; --force makes a new authority and certificate.`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });

function run(args) {
  const r = spawnSync(openssl, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.error?.message}`);
}

const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
try {
  run([
    'req',
    '-x509',
    ...ec,
    '-days',
    '825',
    '-subj',
    '/CN=CIP local development CA (localhost only)',
    '-keyout',
    file('ca.key'),
    '-out',
    file('cip-local-ca.crt'),
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255',
  ]);
  run([
    'req',
    ...ec,
    '-subj',
    '/CN=localhost',
    '-keyout',
    file('localhost.key'),
    '-out',
    file('localhost.csr'),
  ]);
  writeFileSync(
    file('leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
  );
  run([
    'x509',
    '-req',
    '-in',
    file('localhost.csr'),
    '-CA',
    file('cip-local-ca.crt'),
    '-CAkey',
    file('ca.key'),
    '-set_serial',
    `0x${randomBytes(8).toString('hex')}`,
    '-days',
    '397',
    '-extfile',
    file('leaf.ext'),
    '-out',
    file('localhost.crt'),
  ]);
} finally {
  // Nobody can sign with the authority again: its key is gone.
  for (const name of ['ca.key', 'localhost.csr', 'leaf.ext']) rmSync(file(name), { force: true });
}

writeFileSync(
  file('https.caddy'),
  [
    '# Written by scripts/dev-tls.mjs: the local stack on https://localhost:8443 (desktop release builds).',
    // By name only: a client that connects to 127.0.0.1 sends no server name to choose a certificate by.
    'https://localhost:8443 {',
    '\ttls /secrets/tls/localhost.crt /secrets/tls/localhost.key',
    '\timport cip_site',
    '}',
    '',
  ].join('\n'),
);

const ca = new X509Certificate(readFileSync(file('cip-local-ca.crt')));
const leaf = new X509Certificate(readFileSync(file('localhost.crt')));
console.log(
  `Authority: ${ca.subject.replace(/\n/g, ', ')} (SHA-256 ${ca.fingerprint256}), until ${ca.validTo}`,
);
console.log(
  `Certificate: ${leaf.subjectAltName}, until ${leaf.validTo}; signed by the authority: ${leaf.verify(ca.publicKey)}`,
);
console.log(`Trust ${file('cip-local-ca.crt')} for your user, then: docker compose up -d --build web`);
