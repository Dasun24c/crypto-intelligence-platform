#!/usr/bin/env node
// Records raw public market-data messages to JSON Lines, for adapter contract tests and the replay
// venue (architecture §4 tools/recorder, §19). Public, read-only endpoints only: no API keys.
//
//   node tools/recorder/record.mjs --venue binance --symbols BTCUSDT,PAXGUSDT --seconds 15 --out file.jsonl
//   node tools/recorder/record.mjs --venue coinbase --symbols PAXG-USD,USDT-USD --seconds 15 --out file.jsonl
//
// Each line: {"t": <received epoch ms>, "venue": ..., "kind": "ws" | "rest", "path"?: ..., "data": <message>}.
// For Binance, a REST depth snapshot is taken a few seconds in, so the snapshot-plus-diff procedure can
// be replayed exactly as it happened.
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    venue: { type: 'string' },
    symbols: { type: 'string' },
    seconds: { type: 'string', default: '15' },
    out: { type: 'string' },
    channels: { type: 'string' },
    'max-lines': { type: 'string', default: '4000' },
  },
});
if (!values.venue || !values.symbols || !values.out) {
  console.error('usage: record.mjs --venue binance|coinbase --symbols A,B --seconds 15 --out file.jsonl');
  process.exit(64);
}

const symbols = values.symbols
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const seconds = Number(values.seconds);
const maxLines = Number(values['max-lines']);
const out = createWriteStream(values.out, { encoding: 'utf8' });
let lines = 0;
const write = (entry) => {
  if (lines >= maxLines) return;
  lines++;
  out.write(`${JSON.stringify({ t: Date.now(), venue: values.venue, ...entry })}\n`);
};

let ws;
if (values.venue === 'binance') {
  const channels = (values.channels ?? 'aggTrade,kline_1m,depth@100ms,ticker').split(',');
  const streams = symbols.flatMap((s) => channels.map((c) => `${s.toLowerCase()}@${c}`));
  ws = new WebSocket(`wss://data-stream.binance.vision/stream?streams=${streams.join('/')}`);
  ws.onmessage = (e) => write({ kind: 'ws', data: JSON.parse(e.data) });
  setTimeout(async () => {
    for (const s of symbols) {
      const path = `/api/v3/depth?symbol=${s}&limit=100`;
      const res = await fetch(`https://data-api.binance.vision${path}`);
      write({ kind: 'rest', path, data: await res.json() });
    }
  }, 3000);
} else if (values.venue === 'coinbase') {
  const channels = (values.channels ?? 'matches,heartbeat,ticker,level2_batch').split(',');
  ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: symbols, channels }));
  ws.onmessage = (e) => write({ kind: 'ws', data: JSON.parse(e.data) });
} else {
  console.error(`unknown venue ${values.venue}`);
  process.exit(64);
}
ws.onerror = (e) => console.error('websocket error', e.message ?? e);

setTimeout(() => {
  ws.close();
  out.end(() => {
    console.log(
      `recorded ${lines} lines from ${values.venue} (${symbols.join(', ')}) in ${seconds} s -> ${values.out}`,
    );
    process.exit(0);
  });
}, seconds * 1000);
