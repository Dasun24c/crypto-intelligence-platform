#!/usr/bin/env node
// Criteria 3.5 and 4.6 / NFR-02: how soon indicator values (≤ 1 s p95) and SMC detections
// (≤ 2 s p95) are published after a candle closes.
//
// For every `indicators.closed` and `smc` entry on `an:events` in the window, it measures:
//   - wake-up → published: from the ingestor's `md:candles:{id}` entry announcing the final candle
//     to the analyzer's `an:events` entry. Both are Redis stream ids (Redis server clock, ms).
//   - boundary → published: from the candle's close boundary (venue time) to the `an:events` entry,
//     with the Redis clock corrected against Binance server time (public /api/v3/time).
// Points published by a backfill or a restart (no matching live wake-up) are counted, not timed.
//
//   node scripts/analysis-latency.mjs [redis://localhost:16379] [minutes=30]

import net from 'node:net';

const url = new URL(process.argv[2] ?? process.env.REDIS_URL ?? 'redis://localhost:16379');
const minutes = Number(process.argv[3] ?? 30);
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

// ---------------------------------------------------------------- a minimal RESP2 client

function encode(args) {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('')}`;
}

function parse(buf, i) {
  if (i >= buf.length) return null;
  const nl = buf.indexOf('\r\n', i);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString('utf8', i + 1, nl);
  if (type === '+') return { value: line, end: nl + 2 };
  if (type === '-') return { value: new Error(line), end: nl + 2 };
  if (type === ':') return { value: Number(line), end: nl + 2 };
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return { value: null, end: nl + 2 };
    if (buf.length < nl + 2 + n + 2) return null;
    return { value: buf.toString('utf8', nl + 2, nl + 2 + n), end: nl + 2 + n + 2 };
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return { value: null, end: nl + 2 };
    const out = [];
    let pos = nl + 2;
    for (let k = 0; k < n; k++) {
      const r = parse(buf, pos);
      if (!r) return null;
      out.push(r.value);
      pos = r.end;
    }
    return { value: out, end: pos };
  }
  throw new Error(`unexpected RESP type ${type}`);
}

function connect() {
  const socket = net.connect(Number(url.port || 6379), url.hostname);
  let buffer = Buffer.alloc(0);
  const queue = [];
  socket.on('data', (d) => {
    buffer = Buffer.concat([buffer, d]);
    for (;;) {
      if (queue.length === 0) return;
      const r = parse(buffer, 0);
      if (!r) return;
      buffer = buffer.subarray(r.end);
      const q = queue.shift();
      if (r.value instanceof Error) q.reject(r.value);
      else q.resolve(r.value);
    }
  });
  return {
    command: (...args) =>
      new Promise((resolve, reject) => {
        queue.push({ resolve, reject });
        socket.write(encode(args));
      }),
    close: () => socket.end(),
  };
}

// ---------------------------------------------------------------- measurement

const fields = (list) => Object.fromEntries(list.flatMap((v, i) => (i % 2 === 0 ? [[v, list[i + 1]]] : [])));
const idMs = (id) => Number(id.split('-')[0]);

function stats(values) {
  if (values.length === 0) return 'no samples';
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return `n=${s.length} p50=${q(0.5)} ms p95=${q(0.95)} ms max=${s.at(-1)} ms`;
}

async function redisClockOffset(redis) {
  // Redis server time minus venue (Binance) time, from the sample with the shortest round trip.
  let best = null;
  for (let k = 0; k < 5; k++) {
    const started = Date.now();
    const res = await fetch('https://data-api.binance.vision/api/v3/time');
    const { serverTime } = await res.json();
    const [sec, usec] = await redis.command('TIME');
    const rtt = Date.now() - started;
    const redisMs = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    const offset = redisMs - (serverTime + rtt / 2);
    if (!best || rtt < best.rtt) best = { offset, rtt };
  }
  return best;
}

const redis = connect();
const [sec] = await redis.command('TIME');
const now = Number(sec) * 1000;
const start = now - minutes * 60_000;
const clock = await redisClockOffset(redis);

const published = (await redis.command('XRANGE', 'an:events', String(start), '+')).map(([id, f]) => {
  const { type, data } = fields(f);
  return { ...JSON.parse(data), id, stream: type };
});
const wakeups = new Map(); // instrumentId → Map(boundary → { ms, tfs })
for (const instrumentId of new Set(published.map((p) => p.instrumentId))) {
  const map = new Map();
  for (const [id, f] of await redis.command(
    'XRANGE',
    `md:candles:${instrumentId}`,
    String(start - 86_400_000),
    '+',
  )) {
    const { boundary, tfs } = fields(f);
    if (tfs !== 'backfill') map.set(Number(boundary), { ms: idMs(id), tfs: tfs.split(',') });
  }
  wakeups.set(instrumentId, map);
}

const wake = [];
const boundary = [];
const byTf = {};
const byInstrument = {};
const smcWake = [];
const smcBoundary = [];
let untimed = 0;
for (const p of published) {
  const smc = p.stream === 'smc';
  if (p.stream !== 'indicators.closed' && !smc) continue;
  // An SMC detection is decided at a boundary (`time`); any timeframe's wake-up for it counts.
  const close = smc ? p.time : p.point.t + TF_MS[p.tf];
  const w = wakeups.get(p.instrumentId)?.get(close);
  if (!w || (!smc && !w.tfs.includes(p.tf))) {
    untimed++;
    continue;
  }
  const a = idMs(p.id) - w.ms;
  const b = Math.round(idMs(p.id) - clock.offset - close);
  if (smc) {
    smcWake.push(a);
    smcBoundary.push(b);
    continue;
  }
  wake.push(a);
  boundary.push(b);
  (byTf[p.tf] ??= []).push(a);
  (byInstrument[p.instrumentId] ??= []).push(b);
}
redis.close();

console.log(
  `window: last ${minutes} min; ${published.length} an:events entries; ${untimed} not timed (backfill or restart)`,
);
console.log(`Redis clock − Binance time: ${Math.round(clock.offset)} ms (round trip ${clock.rtt} ms)`);
console.log(`wake-up → published:  ${stats(wake)}`);
for (const [tf, v] of Object.entries(byTf)) console.log(`  ${tf.padEnd(3)} ${stats(v)}`);
console.log(`boundary → published: ${stats(boundary)}`);
// Per instrument: Coinbase candles close 2 s after the boundary (late-trade grace), Binance ones at once.
for (const [id, v] of Object.entries(byInstrument)) console.log(`  ${id} ${stats(v)}`);
console.log(`SMC wake-up → published:  ${stats(smcWake)}`);
console.log(`SMC boundary → published: ${stats(smcBoundary)}`);
const p95 = (v) => [...v].sort((x, y) => x - y)[Math.ceil(0.95 * v.length) - 1];
process.exitCode =
  wake.length > 0 && p95(wake) <= 1000 && (smcWake.length === 0 || p95(smcWake) <= 2000) ? 0 : 1;
