# Replay recordings

Public market data recorded with `tools/recorder` on 2026-11-10 (about 08:35–08:37 UTC), for the replay venue
([ADR 015](../../../../docs/adr/015-replay-venue.md)): end-to-end tests in CI, demos and local development without
network access. Public, read-only endpoints only; no keys.

| File | Venue | Symbols | Channels |
|---|---|---|---|
| `binance-demo.jsonl.gz` | Binance (`data-stream.binance.vision`) | BTCUSDT, PAXGUSDT | aggTrade, kline_1m, depth@1000ms, ticker, plus a REST depth snapshot |
| `coinbase-demo.jsonl.gz` | Coinbase Exchange (`ws-feed.exchange.coinbase.com`) | PAXG-USD, USDT-USD, BTC-USD | matches, heartbeat, ticker, level2_batch |

Each window spans two whole minutes after its book snapshot, so the replay loops every two minutes with one final
kline per minute. PAXG-USD did not trade during the recording, so its replayed candles are flat: that is what the
venue showed. To record new ones (the window needs at least one whole minute after the snapshot):

```bash
node tools/recorder/record.mjs --venue binance --symbols BTCUSDT,PAXGUSDT --channels aggTrade,kline_1m,depth@1000ms,ticker --seconds 130 --max-lines 30000 --out binance-demo.jsonl
node tools/recorder/record.mjs --venue coinbase --symbols PAXG-USD,USDT-USD,BTC-USD --channels matches,heartbeat,ticker,level2_batch --seconds 130 --max-lines 30000 --out coinbase-demo.jsonl
gzip -9 binance-demo.jsonl coinbase-demo.jsonl
```
