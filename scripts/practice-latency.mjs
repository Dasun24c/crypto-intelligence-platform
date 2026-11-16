#!/usr/bin/env node
// NFR-16 / criterion 14.11: how soon practice fills are published (ADR 021); and NFR-17 / criterion
// 16.8: how soon automatic practice orders are placed (ADR 022).
//
//   - A market order's fill: from its `place` command on `practice:commands` (the api appends it
//     once the order is stored) to the broker's `practice.fill` entry on `practice:events`.
//   - A waiting order's fill (a resting limit, a target, a triggered stop): from the live trade that
//     filled it (its `md:trades:{id}` entry, recorded in the fill's basis) to the `practice.fill` entry.
//
//   - An automatic order (NFR-17): from its setup's confirmed transition on `an:events` to the buy's
//     first `practice.order` entry on `practice:events`.
//
// Both ends are Redis stream ids, so one clock (the Redis server's) measures both. Targets: p95 ≤ 1 s
// for fills, p95 ≤ 2 s for automatic orders.
//
//   node scripts/practice-latency.mjs [minutes=30]                 measure what was published in the window
//   node scripts/practice-latency.mjs --drive [orders=40] [minutes]  place practice orders first, then measure
//   node scripts/practice-latency.mjs --auto [setups=30] [minutes]   drive automatic trading first, then measure
//
// --drive signs in as the tests' viewer (e2e-viewer@cip.test, seed-dev) through the api at API_URL (default
// http://localhost:8080) and places, on Binance BTC/USDT: market buys and sells of the smallest
// quantity worth the venue minimum, and limit buys and sells one price step inside the best prices,
// which fill when a trade goes through them. Practice orders only: nothing reaches an exchange.
// The seed password comes from DEV_SEED_PASSWORD, or the development default in apps/api/src/cli.ts.
//
// --auto signs in as the tests' viewer, starts their Binance practice account again, sets their
// automatic trading to Binance BTC/USDT and switches it on; then appends, one at a time, confirmed
// bullish setup transitions to `an:events` in the analyzer's message shape (an entry at half the price,
// so the buy rests), waits for the broker's decision, and ends each setup (invalidated) so its buy is
// cancelled before the next. It switches automatic trading off at the end. Synthetic setups: the
// analysis finds a few real ones a day. Practice orders only: nothing reaches an exchange. Those
// confirmed setups reach every account's automatic trading, so --auto first asks the audit log (as the
// tests' admin, e2e/.auth/e2e-admin-totp.txt) and refuses while another account has it switched on.

import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);
const drive = args[0] === '--drive';
const auto = args[0] === '--auto';
const rest = drive || auto ? args.slice(1) : args;
const orders = drive ? Number(rest[0] ?? 40) : 0;
const setups = auto ? Number(rest[0] ?? 30) : 0;
const minutes = Number((drive || auto ? rest[1] : rest[0]) ?? 30);
const AUTO_TARGET_MS = 2000;
const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:16379');
const API = process.env.API_URL ?? 'http://localhost:8080';
const TARGET_MS = 1000;

// ---------------------------------------------------------------- a minimal RESP2 client

function encode(list) {
  return `*${list.length}\r\n${list.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('')}`;
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
    command: (...list) =>
      new Promise((resolve, reject) => {
        queue.push({ resolve, reject });
        socket.write(encode(list));
      }),
    close: () => socket.end(),
  };
}

// ---------------------------------------------------------------- helpers

const fieldsOf = (list) =>
  Object.fromEntries(list.flatMap((v, i) => (i % 2 === 0 ? [[v, list[i + 1]]] : [])));
const idMs = (id) => Number(id.split('-')[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(values) {
  if (values.length === 0) return { text: 'no samples', p95: null };
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { text: `n=${s.length} p50=${q(0.5)} ms p95=${q(0.95)} ms max=${s.at(-1)} ms`, p95: q(0.95) };
}

/** Exact decimal steps without floats: how many steps of `step` fit in `value`, rounded down or up. */
function steps(value, step, up) {
  const places = Math.max((value.split('.')[1] ?? '').length, (step.split('.')[1] ?? '').length);
  const scale = (v) => BigInt(v.replace('.', '') + '0'.repeat(places - (v.split('.')[1] ?? '').length));
  const v = scale(value);
  const s = scale(step);
  return up ? (v + s - 1n) / s : v / s;
}
function times(n, step) {
  const places = (step.split('.')[1] ?? '').length;
  const digits = (n * BigInt(step.replace('.', ''))).toString().padStart(places + 1, '0');
  const out = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out;
}

// ---------------------------------------------------------------- driving orders through the api

function seedPassword() {
  if (process.env.DEV_SEED_PASSWORD) return process.env.DEV_SEED_PASSWORD;
  const source = readFileSync(new URL('../apps/api/src/cli.ts', import.meta.url), 'utf8');
  const m = /DEV_SEED_PASSWORD:\s*z\.string\(\)\.default\('([^']+)'\)/.exec(source);
  if (!m) throw new Error('set DEV_SEED_PASSWORD: the development default was not found');
  return m[1];
}

async function call(token, method, path, body) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : undefined,
    retryAfter: Number(res.headers.get('retry-after')),
  };
}

// The tests' own accounts (seed-dev), never the ones people use: this resets practice balances and
// switches automatic trading.
const TEST_VIEWER = 'e2e-viewer@cip.test';
const TEST_ADMIN = 'e2e-admin@cip.test';

/** `POST /auth/login`, waiting out the login limit (5 a minute per address and per account). */
async function login(email) {
  for (let attempt = 0; ; attempt++) {
    const res = await call(null, 'POST', '/auth/login', { email, password: seedPassword() });
    if (res.status !== 429 || attempt >= 10) return res;
    await sleep((res.retryAfter > 0 ? res.retryAfter * 1000 : 12_000) + 250);
  }
}

async function signInViewer() {
  const res = await login(TEST_VIEWER);
  if (res.status !== 200 || !res.body.accessToken) throw new Error(`sign-in failed (${res.status})`);
  return res.body.accessToken;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), for the tests' admin. */
function totp(secretBase32, nowMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secretBase32.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The tests' admin's access token: the password, then a code from their authenticator's secret. */
async function signInTestAdmin() {
  const file = new URL('../e2e/.auth/e2e-admin-totp.txt', import.meta.url);
  if (!existsSync(file))
    throw new Error(
      "the tests' admin has not enrolled yet: run the admin end-to-end spec once (pnpm e2e admin.spec)",
    );
  const secret = readFileSync(file, 'utf8').trim();
  const res = await login(TEST_ADMIN);
  if (res.status !== 200 || !res.body.mfaToken)
    throw new Error(`the test admin's sign-in failed (${res.status})`);
  let used;
  for (let attempt = 0; attempt < 3;) {
    let code = totp(secret);
    while (code === used) {
      await sleep(1_000);
      code = totp(secret);
    }
    const mfa = await call(null, 'POST', '/auth/mfa', { mfaToken: res.body.mfaToken, code });
    if (mfa.status === 200 && mfa.body.accessToken) return mfa.body.accessToken;
    if (mfa.status === 429) {
      await sleep((mfa.retryAfter > 0 ? mfa.retryAfter * 1000 : 12_000) + 250);
      continue;
    }
    // A code from a time step already used is refused: the next step's is not.
    used = code;
    attempt++;
  }
  throw new Error("the test admin's second factor failed");
}

/**
 * Accounts other than `ownUserId` whose automatic practice trading is on: each account's latest
 * switch in the audit log, newest first.
 */
async function othersTradingAutomatically(ownUserId) {
  const admin = await signInTestAdmin();
  const switches = new Set([
    'practice_auto.switched_on',
    'practice_auto.switched_off',
    'practice_auto.stopped',
  ]);
  const latest = new Map();
  let cursor = null;
  do {
    const page = await call(
      admin,
      'GET',
      `/admin/audit?action=practice_auto.&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (page.status !== 200) throw new Error(`reading the audit log failed (${page.status})`);
    for (const e of page.body.items)
      if (e.actorUserId && switches.has(e.action) && !latest.has(e.actorUserId))
        latest.set(e.actorUserId, e.action);
    cursor = page.body.nextCursor;
  } while (cursor);
  return [...latest]
    .filter(([id, a]) => id !== ownUserId && a === 'practice_auto.switched_on')
    .map(([id]) => id);
}

async function driveOrders(redis) {
  const token = await signInViewer();
  const instruments = (await call(token, 'GET', '/instruments')).body;
  const btc = instruments.find((i) => i.venue === 'binance' && i.base === 'BTC' && i.quote === 'USDT');
  if (!btc) throw new Error('no Binance BTC/USDT instrument');
  const quote = async () => JSON.parse((await redis.command('GET', `ticker:${btc.id}`)) ?? 'null');
  const t = await quote();
  if (!t) throw new Error('no live BTC/USDT ticker: is the ingestor streaming?');
  // The smallest quantity worth the venue minimum (and at least 1 USDT), at the ask.
  const minimum = Number(btc.minNotional) > 0 ? btc.minNotional : '1';
  const qty = times(
    steps(((Number(minimum) * 1.2) / Number(t.ask)).toFixed(12), btc.qtyStep, true),
    btc.qtyStep,
  );
  console.log(
    `driving ${orders} practice orders of ${qty} BTC on Binance BTC/USDT (simulated, practice balances)`,
  );
  // Start from the starting balances, so sells have something to sell.
  await call(token, 'POST', '/practice/account/reset', { venue: 'binance' });
  let placed = 0;
  let refused = 0;
  // First a market buy of ten times the quantity, so the sells have something to sell; then, in
  // turn, a market buy, a market sell, a limit buy and a limit sell.
  const plan = [
    { side: 'buy', market: true, quantity: times(steps(qty, btc.qtyStep, false) * 10n, btc.qtyStep) },
  ];
  for (let k = 1; k < orders; k++)
    plan.push({
      side: k % 4 === 1 || k % 4 === 3 ? 'buy' : 'sell',
      market: k % 4 === 1 || k % 4 === 2,
      quantity: qty,
    });
  for (const [k, step] of plan.entries()) {
    const now = await quote();
    const { side, market, quantity } = step;
    const body = { clientOrderId: `latency-${Date.now()}-${k}`, instrumentId: btc.id, side, quantity };
    if (market) Object.assign(body, { type: 'market' });
    else {
      // One step inside the touch: it rests, and fills when a trade goes through it.
      const tick = btc.priceTick;
      const price =
        side === 'buy'
          ? times(steps(now.bid, tick, false) - 1n, tick)
          : times(steps(now.ask, tick, true) + 1n, tick);
      Object.assign(body, { type: 'limit', limitPrice: price });
    }
    const res = await call(token, 'POST', '/practice/orders', body);
    if (res.status === 201) placed++;
    else {
      refused++;
      console.log(`  order ${k + 1}: ${res.status} ${res.body?.reason ?? res.body?.code ?? ''}`);
    }
    await sleep(400); // under the 5-per-second limit
  }
  console.log(`placed ${placed}, refused ${refused}; waiting 60 s for resting orders to meet trades`);
  await sleep(60_000);
}

// ---------------------------------------------------------------- driving automatic trading

/** The newest entry of a stream, to read only what comes after it. */
async function lastEntry(redis, stream) {
  const [entry] = await redis.command('XREVRANGE', stream, '+', '-', 'COUNT', 1);
  return entry?.[0] ?? '0-0';
}

/** Waits for the broker's decision on a setup (a `practice.automatic` entry after `after`). */
async function decisionFor(redis, after, setupId, outcomes, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const [, list] of await redis.command('XRANGE', 'practice:events', `(${after}`, '+')) {
      const f = fieldsOf(list);
      if (f.type !== 'practice.automatic') continue;
      const m = JSON.parse(f.data);
      if (m.event === 'decision' && m.decision.setupId === setupId && outcomes.includes(m.decision.outcome))
        return m.decision;
    }
    await sleep(50);
  }
  return null;
}

async function driveAutomatic(redis) {
  const token = await signInViewer();
  const instruments = (await call(token, 'GET', '/instruments')).body;
  const btc = instruments.find((i) => i.venue === 'binance' && i.base === 'BTC' && i.quote === 'USDT');
  if (!btc) throw new Error('no Binance BTC/USDT instrument');
  const t = JSON.parse((await redis.command('GET', `ticker:${btc.id}`)) ?? 'null');
  if (!t) throw new Error('no live BTC/USDT ticker: is the ingestor streaming?');
  const price = (v) => times(steps(v.toFixed(8), btc.priceTick, false), btc.priceTick);
  const half = Number(t.ask) / 2;
  const levels = { entry: price(half), invalidation: price(half * 0.98), target1: price(half * 1.1) };

  // Its confirmed setups reach every account's automatic trading: not while another account has it on.
  const me = (await call(token, 'GET', '/me')).body;
  const others = await othersTradingAutomatically(me.id);
  if (others.length > 0)
    throw new Error(
      `automatic trading is on for ${others.length} other account(s): these confirmed setups would trade for them`,
    );

  // From the starting balances, its rules for BTC/USDT, switched on.
  const current = (await call(token, 'GET', '/practice/automatic')).body;
  if (current.enabled) await call(token, 'POST', '/practice/automatic/stop');
  await call(token, 'POST', '/practice/account/reset', { venue: 'binance' });
  const read = (await call(token, 'GET', '/practice/automatic')).body;
  const saved = await call(token, 'PUT', '/practice/automatic', {
    version: read.version,
    rules: {
      ...read.rules,
      venue: 'binance',
      instrumentIds: [btc.id],
      minScore: 70,
      minReward: 2,
      riskPct: 1,
      maxOpenTrades: 3,
      maxOrdersPerDay: 50,
    },
  });
  if (saved.status !== 200) throw new Error(`saving the rules failed (${saved.status})`);
  const on = await call(token, 'POST', '/practice/automatic/on', { version: saved.body.version });
  if (on.status !== 200) throw new Error(`switching on failed (${on.status})`);
  console.log(
    `driving ${setups} confirmed setups for the tests' viewer's automatic practice trading (simulated)`,
  );

  const runId = randomUUID();
  const message = (id, to) => {
    const now = Date.now();
    return {
      id,
      instrumentId: btc.id,
      runId,
      pattern: 'htf_order_block',
      variant: null,
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '15m',
      state: to,
      resolution: to === 'resolved' ? 'invalidated' : null,
      displayLabel: to === 'resolved' ? 'Resolved' : 'Confirmed',
      levels: { ...levels, target2: null, rr: 5 },
      score: 85,
      mandatoryPassed: true,
      qualityFlags: [],
      flags: [],
      createdAt: now - 3_600_000,
      updatedAt: now,
      resolvedAt: to === 'resolved' ? now : null,
      disclaimer: 'Educational analysis — not financial advice',
      transition: {
        from: to === 'resolved' ? 'confirmed' : 'triggered',
        to,
        reason: 'latency measurement',
        candleTime: now - 900_000,
        decidedAt: now - 500,
        processedAt: now,
        late: false,
        evidence: {},
      },
    };
  };
  const outcomes = {};
  try {
    for (let k = 0; k < setups; k++) {
      const id = randomUUID();
      let after = await lastEntry(redis, 'practice:events');
      await redis.command(
        'XADD',
        'an:events',
        '*',
        'type',
        'setup',
        'data',
        JSON.stringify(message(id, 'confirmed')),
      );
      const d = await decisionFor(redis, after, id, ['placed', 'skipped', 'refused']);
      const key = d ? `${d.outcome}${d.reason ? ` (${d.reason})` : ''}` : 'no decision in 10 s';
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (d?.outcome !== 'placed') continue;
      // End it, so the next setup on the pair is not held back by this one.
      after = await lastEntry(redis, 'practice:events');
      await redis.command(
        'XADD',
        'an:events',
        '*',
        'type',
        'setup',
        'data',
        JSON.stringify(message(id, 'resolved')),
      );
      await decisionFor(redis, after, id, ['cancelled']);
      await sleep(200);
    }
  } finally {
    await call(token, 'POST', '/practice/automatic/stop');
  }
  console.log(`decisions: ${JSON.stringify(outcomes)}; automatic trading switched off`);
}

// ---------------------------------------------------------------- measurement

const redis = connect();
if (drive) await driveOrders(redis);
if (auto) await driveAutomatic(redis);
const [sec] = await redis.command('TIME');
const from = (Number(sec) - minutes * 60) * 1000;

const commands = new Map();
for (const [id, list] of await redis.command('XRANGE', 'practice:commands', String(from - 60_000), '+')) {
  const f = fieldsOf(list);
  if (f.type === 'place' && f.orderId) commands.set(f.orderId, idMs(id));
}

// The confirmed setup transitions the automatic orders came from (NFR-17).
const confirmedAt = new Map();
for (const [id, list] of await redis.command('XRANGE', 'an:events', String(from - 60_000), '+')) {
  const f = fieldsOf(list);
  if (f.type !== 'setup') continue;
  try {
    const m = JSON.parse(f.data);
    if (m.transition?.to === 'confirmed' && !confirmedAt.has(m.id)) confirmedAt.set(m.id, idMs(id));
  } catch {
    // not a setup message: not timed
  }
}

const market = [];
const waiting = [];
const firstOrderEntry = new Map();
const placedSetup = new Map();
let unmatched = 0;
for (const [id, list] of await redis.command('XRANGE', 'practice:events', String(from), '+')) {
  const f = fieldsOf(list);
  if (f.type === 'practice.order') {
    const { order } = JSON.parse(f.data);
    if (order.source === 'auto' && order.parentId === null && !firstOrderEntry.has(order.id))
      firstOrderEntry.set(order.id, idMs(id));
    continue;
  }
  if (f.type === 'practice.automatic') {
    const m = JSON.parse(f.data);
    if (m.event === 'decision' && m.decision.outcome === 'placed')
      placedSetup.set(m.decision.orderId, m.decision.setupId);
    continue;
  }
  if (f.type !== 'practice.fill') continue;
  const { fill } = JSON.parse(f.data);
  const published = idMs(id);
  const trade = fill.basis?.trade;
  if (trade?.streamId) waiting.push(published - idMs(trade.streamId));
  else if (commands.has(fill.orderId)) market.push(published - commands.get(fill.orderId));
  else unmatched++;
}
redis.close();

const automatic = [];
for (const [orderId, setupId] of placedSetup) {
  const placedAt = firstOrderEntry.get(orderId);
  const confirmed = confirmedAt.get(setupId);
  if (placedAt !== undefined && confirmed !== undefined) automatic.push(placedAt - confirmed);
}

const m = stats(market);
const w = stats(waiting);
const a = stats(automatic);
console.log(`practice orders published in the last ${minutes} min (Redis clock):`);
console.log(`  market orders, submitted → fill published:      ${m.text}`);
console.log(`  waiting orders, filling trade → fill published: ${w.text}`);
console.log(`  automatic orders, setup confirmed → order published: ${a.text}`);
if (unmatched) console.log(`  ${unmatched} fill(s) without their command in the window, not timed`);
const met = (s, target = TARGET_MS) => (s.p95 === null ? 'no samples' : s.p95 <= target ? 'met' : 'NOT met');
console.log(`NFR-16 (p95 ≤ ${TARGET_MS} ms): market ${met(m)}, waiting ${met(w)}`);
console.log(`NFR-17 (p95 ≤ ${AUTO_TARGET_MS} ms): automatic ${met(a, AUTO_TARGET_MS)}`);
