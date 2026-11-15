#!/usr/bin/env node
// Criterion 9.5: the Grok key lives only in the jobs service. Two checks:
//   node scripts/scan-images.mjs <image>...   every file of every layer of each image (via `docker save`)
//                                             holds no xAI key, and not the key in .secrets-jobs/grok-api-key
//   node scripts/scan-images.mjs --containers [project]
//                                             of the compose project's containers (default `cip`), only jobs
//                                             mounts .secrets-jobs or is told where the key is
// The key itself is never printed: a finding names the file and the rule, not the value.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args.length === 0) {
  console.error('usage: scan-images <image>... | --containers [project]');
  process.exit(64);
}

if (args[0] === '--containers') {
  checkContainers(args[1] ?? 'cip');
  process.exit(0);
}

const KEY_FILE = new URL('../.secrets-jobs/grok-api-key', import.meta.url);
const key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '';
const RULES = [{ label: 'xAI API key', pattern: /\bxai-[A-Za-z0-9]{20,}/ }];
const findings = [];
const totals = [];

for (const image of args) {
  const tar = await save(image);
  const seen = { layers: 0, files: 0, bytes: 0 };
  scanTar(tar, image, seen, 0);
  totals.push(
    `${image}: ${seen.layers} layers, ${seen.files} files, ${(seen.bytes / 1048576).toFixed(0)} MiB`,
  );
}

if (findings.length > 0) {
  console.error(`Image scan FAILED: ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `Image scan passed (${key ? 'the configured key and ' : ''}the xAI key pattern): ${totals.join('; ')}.`,
);

/** `docker save` of one image, as one buffer. */
function save(image) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`docker save ${image}: ${err.trim()}`)),
    );
  });
}

/** A NUL-terminated header field. A function declaration: the scan runs before this point in the file. */
function str(b) {
  return b.toString('utf8').replace(/\0.*$/s, '');
}

/** A tar entry's size: octal, or base-256 for large files. */
function sizeOf(header) {
  const field = header.subarray(124, 136);
  if (field[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  return parseInt(str(field).trim() || '0', 8);
}

/** Every file in a tar (and in tars inside it: the layers), scanned as text. */
function scanTar(buf, where, seen, depth) {
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = sizeOf(header);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(header.subarray(345, 500));
    const name =
      paxPath ?? (prefix ? `${prefix}/${str(header.subarray(0, 100))}` : str(header.subarray(0, 100)));
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    paxPath = null;
    if (type !== '0' && type !== '7') continue; // regular files only
    let body = data;
    if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
    if (depth === 0 && isTar(body)) {
      seen.layers++;
      scanTar(body, `${where}:${name}`, seen, depth + 1);
      continue;
    }
    seen.files++;
    seen.bytes += body.length;
    const text = body.toString('latin1');
    for (const rule of RULES) if (rule.pattern.test(text)) findings.push(`${where}:${name}: ${rule.label}`);
    if (key && body.indexOf(key) !== -1) findings.push(`${where}:${name}: the configured Grok key`);
  }
}

function isTar(b) {
  return b.length >= 512 && b.subarray(257, 262).toString('latin1') === 'ustar';
}

/** Only the jobs container may see the key: its folder mounted, or a variable naming it. */
function checkContainers(project) {
  const ids = execFileSync(
    'docker',
    ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) {
    console.error(`no containers in compose project ${project}`);
    process.exit(1);
  }
  const rows = JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' }));
  const problems = [];
  const report = [];
  for (const c of rows) {
    const service = c.Config.Labels['com.docker.compose.service'];
    const mounts = (c.Mounts ?? []).filter((m) => /[\\/]\.secrets-jobs$/.test(m.Source ?? ''));
    const env = (c.Config.Env ?? []).filter((e) => /^(GROK_API_KEY|XAI_API_KEY)(_FILE)?=/.test(e));
    // The one-off `secrets` service creates the empty key file and exits; it never reads it.
    const allowed = service === 'jobs' || (service === 'secrets' && env.length === 0);
    const sees = mounts.length > 0 || env.length > 0;
    report.push(`${service}: ${sees ? 'sees the key folder' : 'no key'}`);
    if (sees && !allowed) problems.push(`${service} can reach the Grok key`);
    if (service === 'jobs' && mounts.some((m) => m.RW)) problems.push('jobs mounts the key folder writable');
  }
  if (problems.length) {
    console.error(`Container check FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log(`Container check passed (${project}): ${report.sort().join('; ')}.`);
}
