#!/usr/bin/env node
// Nightly live smoke test (criterion 2.11): against a running stack streaming the real venues, every
// enabled instrument must stream (depth, ticker and kline feeds connected; trades not disconnected),
// serve a live ticker, and have written a 1m candle in the last 3 minutes. Public data only.
//
//   node scripts/live-smoke.mjs [baseUrl]      (default http://localhost:3000; DEV_SEED_PASSWORD as for seed-dev)

const base = (process.argv[2] ?? process.env.CIP_API_URL ?? 'http://localhost:3000') + '/api/v1';
const password = process.env.DEV_SEED_PASSWORD ?? 'local-dev-password';
const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 5 * 60_000);

async function call(path, token, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-client': 'desktop',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function problems(instruments, feeds, tickers, candles, now) {
  const out = [];
  for (const i of instruments) {
    for (const f of feeds.filter((x) => x.instrumentId === i.id)) {
      const ok = f.stream === 'trades' ? f.state !== 'disconnected' : f.state === 'connected';
      if (!ok) out.push(`${i.displayName}: ${f.stream} ${f.state} (${f.detail})`);
    }
    if (tickers.get(i.id) !== 200) out.push(`${i.displayName}: no live ticker (${tickers.get(i.id)})`);
    const last = candles.get(i.id);
    if (last === undefined || now - last > 3 * 60_000)
      out.push(`${i.displayName}: last 1m candle ${last ? new Date(last).toISOString() : 'none'}`);
  }
  return out;
}

const login = await call('/auth/login', null, { email: 'viewer@cip.test', password });
if (login.status !== 200) {
  console.error(`sign-in failed: ${login.status} ${JSON.stringify(login.body)}`);
  process.exit(1);
}
const token = login.body.accessToken;
let remaining = ['not checked yet'];
while (Date.now() < deadline) {
  const instruments = (await call('/instruments', token)).body.filter((i) => i.venue !== 'replay');
  const feeds = (await call('/system/feeds', token)).body;
  const tickers = new Map();
  const candles = new Map();
  for (const i of instruments) {
    tickers.set(i.id, (await call(`/market/${i.id}/ticker`, token)).status);
    const c = (await call(`/market/${i.id}/candles?tf=1m&limit=1`, token)).body;
    if (Array.isArray(c) && c.length) candles.set(i.id, c[0].t);
  }
  remaining = problems(instruments, feeds, tickers, candles, Date.now());
  if (instruments.length > 0 && remaining.length === 0) {
    console.log(`live smoke test passed: ${instruments.length} instruments streaming, ${feeds.length} feeds`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.error(`live smoke test failed:\n- ${remaining.join('\n- ')}`);
process.exit(1);
