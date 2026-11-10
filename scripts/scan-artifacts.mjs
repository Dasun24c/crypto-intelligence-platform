#!/usr/bin/env node
// Criterion 1.6: built client artefacts (web bundle, desktop bundle) must contain no secrets and no
// server environment-variable names. Usage: node scripts/scan-artifacts.mjs <dir-or-file>...
// Every file is scanned as text (binaries as latin1, so embedded strings are still found).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const targets = process.argv.slice(2).filter((a) => a !== '--');
if (targets.length === 0) {
  console.error('usage: scan-artifacts <dir-or-file>...');
  process.exit(64);
}

// Generic names that libraries legitimately mention are allowed; every other server setting is not.
const GENERIC = new Set(['NODE_ENV']);
const envNames = JSON.parse(readFileSync(new URL('./server-env-names.json', import.meta.url), 'utf8')).filter(
  (n) => !GENERIC.has(n),
);

const RULES = [
  ...envNames.map((name) => ({
    label: `server setting ${name}`,
    pattern: new RegExp(`\\b${name}(_FILE)?\\b`),
  })),
  { label: 'private key (PEM)', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    label: 'connection string with credentials',
    pattern: /\b(postgres(ql)?|redis|rediss|amqp|mongodb):\/\/[^\s:/@'"]+:[^\s@'"]+@/,
  },
  { label: 'xAI API key', pattern: /\bxai-[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];

function* walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path)) yield* walk(join(path, name));
}

const findings = [];
let files = 0;
let bytes = 0;
for (const target of targets) {
  for (const file of walk(target)) {
    files++;
    const buf = readFileSync(file);
    bytes += buf.length;
    const text = buf.toString('latin1');
    for (const rule of RULES) {
      const m = rule.pattern.exec(text);
      if (m) {
        const at = text.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ');
        findings.push(`${relative(process.cwd(), file)}: ${rule.label} … ${at} …`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Artefact scan FAILED: ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `Artefact scan passed: ${files} files, ${(bytes / 1024).toFixed(0)} KiB, ${RULES.length} rules (${envNames.length} server setting names).`,
);
