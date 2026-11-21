import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ONCHAIN_QUEUE, ONCHAIN_STATUS_KEY, type OnchainStatus } from '@cip/contracts';
import { createDb } from '@cip/db';
import type { MinimalWebSocket } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import type { EsploraTx, EthBlock, EthLog, SolanaTx } from '../src/onchain/detect.ts';
import { EsploraClient, type Fetch } from '../src/onchain/http.ts';
import { ETH_BLOCK_TIMES_KEY, type OnchainJob, solCallsKey } from '../src/onchain/jobs.ts';
import { OnchainPrices } from '../src/onchain/prices.ts';
import { OnchainProcessor } from '../src/onchain/processor.ts';
import { ONCHAIN_LEASE, OnchainWatcher } from '../src/onchain/watcher.ts';

/**
 * The Whale Tracker's on-chain path (ADR 025, criterion 11.2) on recorded chain data: what a provider
 * pushes becomes one job per block or transaction, and each job stores its events once. Nothing here
 * connects out: the providers are a fake `fetch` and an in-memory WebSocket, behind `.invalid` hosts.
 */

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/onchain/${name}`, import.meta.url), 'utf8')) as T;
}
interface RecordedReceipt {
  block: { number: number; hash: string; timestamp: number };
  receipt: { logs: EthLog[] };
}
const btc = fixture<{ block: { height: number; hash: string; timestamp: number }; txs: EsploraTx[] }>(
  'btc-block-976172.json',
);
const eth = fixture<{ block: EthBlock }>('eth-block-26429557.json');
const mint = fixture<RecordedReceipt>('paxg-mint-26429062.json');
const burn = fixture<RecordedReceipt>('paxg-burn-26429307.json');
const paxgLogs = (r: RecordedReceipt) =>
  r.receipt.logs.filter((l) => l.address.toLowerCase() === '0x45804880de22913dafe09f4980848ece6ecbaf78');
const hex = (n: number) => `0x${n.toString(16)}`;

// The seeded instruments (migration 0005): Coinbase's BTC, ETH and SOL against USD, and PAXG through
// Binance's PAXG/USDT and USDT/USD. PAXG/USD and Binance's other pairs have no ticker here.
const TICKERS: Record<string, string> = {
  '019a6f00-0000-7000-8000-000000000005': '65000', // BTC-USD
  '019a6f00-0000-7000-8000-000000000006': '3200', // ETH-USD
  '019a6f00-0000-7000-8000-000000000007': '200', // SOL-USD
  '019a6f00-0000-7000-8000-000000000004': '4000', // PAXGUSDT
  '019a6f00-0000-7000-8000-000000000009': '1', // USDT-USD
};
/** Every seeded pair's ticker key, including those another suite may have left behind. */
const ALL_TICKERS = Array.from({ length: 9 }, (_, i) => `ticker:019a6f00-0000-7000-8000-00000000000${i + 1}`);
const EXCHANGE_SOL = 'ExchangeWa11et1111111111111111111111111111';
const WHALE_SOL = 'Wha1e111111111111111111111111111111111111111';

async function setTickers(ts = Date.now()) {
  await redis.del(...ALL_TICKERS);
  for (const [id, last] of Object.entries(TICKERS))
    await redis.set(
      `ticker:${id}`,
      JSON.stringify({
        instrumentId: id,
        ts,
        last,
        bid: last,
        ask: last,
        change24hPct: 0,
        volume24hQuote: '0',
      }),
    );
}

/** The providers' HTTP APIs, answered from the recordings; every request is kept. */
const requests: string[] = [];
const fakeFetch: Fetch = async (input, init) => {
  // The processor and EsploraClient pass the URL as a string, and JSON-RPC bodies as strings.
  const url = new URL(input as string);
  if (url.hostname === 'btc.invalid') {
    const path = url.pathname.replace(/^\/api/, '');
    requests.push(`GET ${path}`);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path === `/block/${btc.block.hash}`)
      return json({ height: btc.block.height, timestamp: btc.block.timestamp, tx_count: btc.txs.length });
    if (path === `/block/${btc.block.hash}/txs/0`) return json(btc.txs);
    if (path === '/blocks/tip/height') return new Response(String(btc.block.height), { status: 200 });
    if (path === `/block-height/${btc.block.height}`) return new Response(btc.block.hash, { status: 200 });
    return new Response('not found', { status: 404 });
  }
  if (url.hostname !== 'eth.invalid' && url.hostname !== 'sol.invalid')
    throw new Error(`unexpected host ${url.hostname}`);
  const body = JSON.parse(init?.body as string) as { method: string; params: unknown[] };
  requests.push(`${body.method} ${JSON.stringify(body.params[0])}`);
  const result = (r: unknown) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }), { status: 200 });
  if (body.method === 'eth_getBlockByNumber') {
    const n = Number(BigInt(body.params[0] as string));
    if (n === Number(BigInt(eth.block.number))) return result(eth.block);
    for (const r of [mint, burn])
      if (n === r.block.number)
        return result({ number: hex(n), hash: r.block.hash, timestamp: hex(r.block.timestamp) });
    return result(null);
  }
  if (body.method === 'getTransaction') return result(solanaTx(body.params[0] as string));
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }));
};

/** 50,000 SOL from a whale into the listed exchange wallet. */
function solanaTx(signature: string): SolanaTx {
  const sol = 1_000_000_000;
  return {
    slot: 300_000_000,
    blockTime: 1_794_855_000,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [WHALE_SOL, EXCHANGE_SOL, '11111111111111111111111111111111'] },
    },
    meta: {
      err: null,
      preBalances: [60_000 * sol, 10 * sol, 1],
      postBalances: [10_000 * sol - 5_000, 50_010 * sol, 1],
    },
  };
}

const esplora = new EsploraClient(() => 'https://btc.invalid/api', fakeFetch, 0);

const stored = (txHash: string) =>
  owner.selectFrom('onchain.events').selectAll().where('tx_hash', '=', txHash).orderBy('position').execute();

beforeAll(async () => {
  await owner.deleteFrom('onchain.events').execute();
  await owner.deleteFrom('onchain.cursors').execute();
  await owner.deleteFrom('onchain.labels').execute();
  await owner
    .insertInto('onchain.labels')
    .values({
      id: '019a9000-0000-7000-8000-000000000001',
      chain: 'solana',
      address: EXCHANGE_SOL,
      owner: 'Example Exchange',
      wallet: 'cold',
      source: 'test',
    })
    .execute();
  await redis.del(ETH_BLOCK_TIMES_KEY, ONCHAIN_STATUS_KEY, ONCHAIN_LEASE);
  await setTickers();
});

afterAll(async () => {
  await owner.deleteFrom('onchain.events').execute();
  await owner.deleteFrom('onchain.cursors').execute();
  await owner.deleteFrom('onchain.labels').execute();
  await redis.del(
    ...ALL_TICKERS,
    ETH_BLOCK_TIMES_KEY,
    ONCHAIN_STATUS_KEY,
    ONCHAIN_LEASE,
    solCallsKey(Date.now()),
  );
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

describe('the on-chain processor on recorded chain data (criterion 11.2)', () => {
  const processor = (solDailyCalls = 5_000) =>
    new OnchainProcessor({
      db,
      redis,
      log,
      prices: new OnchainPrices(db, redis),
      esplora,
      fetch: fakeFetch,
      ethHttpUrl: () => 'https://eth.invalid/v2/test-key',
      solHttpUrl: () => 'https://sol.invalid/v2/test-key',
      thresholdsUsd: { BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' },
      solDailyCalls,
      btcProvider: 'btc.invalid',
    });

  it('stores the known PAXG mint and burn once each, from their supply events, whatever is delivered twice', async () => {
    const p = processor();
    // The mint's block time comes from the pushed heads; the burn's is asked of the provider.
    await redis.hset(ETH_BLOCK_TIMES_KEY, String(mint.block.number), String(mint.block.timestamp * 1000));
    requests.length = 0;
    const results = [];
    for (const r of [mint, burn])
      for (const l of paxgLogs(r)) results.push(await p.run({ kind: 'paxg-log', log: l }));
    // Each supply event is one event; its Transfer from or to the zero address is not a second one.
    expect(results.map((r) => r.events)).toEqual([1, 0, 1, 0]);
    // Only the burn's block was asked for (once for each of its two PAXG logs).
    expect(new Set(requests)).toEqual(new Set([`eth_getBlockByNumber "${hex(burn.block.number)}"`]));

    // Delivered again (a reconnect, a retried job): nothing more.
    for (const r of [mint, burn])
      for (const l of paxgLogs(r)) expect((await p.run({ kind: 'paxg-log', log: l })).events).toBe(0);

    const [m] = await stored('0xef39a122bccb55760d2568db1b832ff9ebf42e2140dcc51e80a1b9719702e2ff');
    expect(m).toMatchObject({
      chain: 'ethereum',
      asset: 'PAXG',
      kind: 'mint',
      position: 132,
      block_time: new Date(Date.UTC(2026, 10, 16, 17, 23, 59)),
      from_address: null,
      to_address: '0xedd40fe35a559b8f5340b77af93083f3462ebb42',
      amount: '62.9874',
      price_usd: '4000',
      usd_value: '251949.6',
      provider: 'alchemy',
    });
    expect(String(m!.block_number)).toBe('26429062');
    const [b] = await stored('0xf74c23dbadd747a6fc48c9e37a33b1ef8ea4b6f100529dfd83e0bd0f8b64b044');
    expect(b).toMatchObject({
      kind: 'burn',
      position: 164,
      block_time: new Date(Date.UTC(2026, 10, 16, 18, 12, 59)),
      from_address: '0xf58e79a7bd26532ff525db5b78456eb2e79076ec',
      to_address: null,
      amount: '3.2',
    });
    expect(
      await owner.selectFrom('onchain.events').select(owner.fn.countAll().as('n')).executeTakeFirst(),
    ).toEqual({
      n: '2',
    });
  });

  it('removes a PAXG event when its block is replaced, and stores it again when it comes back', async () => {
    const p = processor();
    const tx = '0xef39a122bccb55760d2568db1b832ff9ebf42e2140dcc51e80a1b9719702e2ff';
    expect(await p.run({ kind: 'paxg-removed', txHash: tx, logIndex: 132 })).toEqual({ events: -1 });
    expect(await stored(tx)).toHaveLength(0);
    await p.run({ kind: 'paxg-removed', txHash: tx, logIndex: 132 }); // removing it again is harmless
    expect(await stored(tx)).toHaveLength(0);
    expect((await p.run({ kind: 'paxg-log', log: paxgLogs(mint)[0]! })).events).toBe(1);
    expect(await stored(tx)).toHaveLength(1);
  });

  it('reads a Bitcoin block once for its large transfers, and moves the cursor', async () => {
    const p = processor();
    const job: OnchainJob = { kind: 'btc-block', hash: btc.block.hash, height: btc.block.height };
    expect(await p.run(job)).toEqual({ events: 1 });
    expect(await p.run(job)).toEqual({ events: 0 });
    const [t] = await stored('7663e888950a2341d27366e341408671127e4f989b126872969e0a8ae9e018ec');
    expect(t).toMatchObject({
      asset: 'BTC',
      kind: 'transfer',
      from_address: '33uVWjMEXvu1xBWjydjPod9K87jgjm7WXm',
      to_address: '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
      amount: '100.00095775',
      usd_value: '6500062.25',
      provider: 'btc.invalid',
      details: { inputs: 1, outputs: 39, recipients: 39, senders: 1 },
    });
    const cursor = await owner
      .selectFrom('onchain.cursors')
      .selectAll()
      .where('chain', '=', 'bitcoin')
      .executeTakeFirst();
    expect(String(cursor?.block_number)).toBe('976172');
  });

  it('reads an Ethereum block once for ETH moved over the threshold', async () => {
    const p = processor();
    const job: OnchainJob = { kind: 'eth-block', number: 26_429_557 };
    expect(await p.run(job)).toEqual({ events: 1 });
    expect(await p.run(job)).toEqual({ events: 0 });
    const [t] = await stored('0x1ae7ecf44df7e9b00a5e8e0aee85e65425b33afc8bc75ad663059e3f3b8738bd');
    expect(t).toMatchObject({ asset: 'ETH', amount: '16517.6664708876044614', usd_value: '52856532.71' });
  });

  it('records SOL into a listed exchange wallet, within the daily allowance of Solana reads', async () => {
    await redis.del(solCallsKey(Date.now()));
    const p = processor(2);
    expect(await p.run({ kind: 'sol-tx', signature: 'sig-1' })).toEqual({ events: 1 });
    expect(await p.run({ kind: 'sol-tx', signature: 'sig-1' })).toEqual({ events: 0 });
    expect(await p.run({ kind: 'sol-tx', signature: 'sig-2' })).toEqual({
      events: 0,
      skipped: 'daily Solana budget reached',
    });
    const [t] = await stored('sig-1');
    expect(t).toMatchObject({
      asset: 'SOL',
      from_address: WHALE_SOL,
      to_address: EXCHANGE_SOL,
      amount: '50000',
    });
  });

  it('records no transfer without a fresh price, but still reads the block and records supply events', async () => {
    await setTickers(Date.now() - 10 * 60_000);
    try {
      const p = processor();
      await owner.deleteFrom('onchain.events').where('asset', '=', 'BTC').execute();
      const job: OnchainJob = { kind: 'btc-block', hash: btc.block.hash, height: btc.block.height };
      expect(await p.run(job)).toEqual({ events: 0, skipped: 'no BTC price' });
      await owner.deleteFrom('onchain.events').where('kind', '=', 'burn').execute();
      expect((await p.run({ kind: 'paxg-log', log: paxgLogs(burn)[0]! })).events).toBe(1);
      const [b] = await stored('0xf74c23dbadd747a6fc48c9e37a33b1ef8ea4b6f100529dfd83e0bd0f8b64b044');
      expect(b).toMatchObject({ kind: 'burn', price_usd: null, usd_value: null });
    } finally {
      await setTickers();
    }
  });
});

/** An in-memory provider connection: opens at once, keeps what is sent, delivers what a test pushes. */
class FakeProviderSocket implements MinimalWebSocket {
  static sockets: FakeProviderSocket[] = [];
  readyState = 0;
  onopen: MinimalWebSocket['onopen'] = null;
  onmessage: MinimalWebSocket['onmessage'] = null;
  onclose: MinimalWebSocket['onclose'] = null;
  onerror: MinimalWebSocket['onerror'] = null;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeProviderSocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  static on(host: string): FakeProviderSocket | undefined {
    return FakeProviderSocket.sockets.find((s) => new URL(s.url).hostname === host && s.readyState === 1);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('the on-chain watcher, against in-memory providers (criterion 11.2: push, one job each)', () => {
  const prefix = `test-onchain-${process.pid}`;
  const queueConnection = redis.duplicate();
  const queue = new Queue<OnchainJob>(ONCHAIN_QUEUE, { connection: queueConnection, prefix });
  const thresholdsUsd = { BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' };
  const watcher = (key: string | null) =>
    new OnchainWatcher({
      db,
      redis,
      queue,
      esplora,
      log,
      instance: `test-${key ?? 'no-key'}`,
      webSocket: FakeProviderSocket,
      config: {
        btcWsUrl: 'wss://btc.invalid/api/v1/ws',
        ethWsUrl: () => (key ? `wss://eth.invalid/v2/${key}` : null),
        solWsUrl: () => (key ? `wss://sol.invalid/v2/${key}` : null),
        thresholdsUsd,
      },
    });
  const jobIds = async () => (await queue.getJobs(['waiting', 'delayed'])).map((j) => j.id).sort();
  const status = async () =>
    JSON.parse((await redis.get(ONCHAIN_STATUS_KEY)) ?? 'null') as OnchainStatus | null;

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    queueConnection.disconnect();
  });

  it('subscribes on connection, and queues each pushed block, PAXG log and Solana transaction once', async () => {
    await owner.deleteFrom('onchain.cursors').execute();
    FakeProviderSocket.sockets = [];
    const w = watcher('test-key');
    await w.start();
    try {
      await expect
        .poll(() =>
          [
            FakeProviderSocket.on('btc.invalid'),
            FakeProviderSocket.on('eth.invalid'),
            FakeProviderSocket.on('sol.invalid'),
          ].every(Boolean),
        )
        .toBe(true);
      const btcSocket = FakeProviderSocket.on('btc.invalid')!;
      const ethSocket = FakeProviderSocket.on('eth.invalid')!;
      const solSocket = FakeProviderSocket.on('sol.invalid')!;
      expect(ethSocket.url).toBe('wss://eth.invalid/v2/test-key');

      // Bitcoin: blocks wanted; on a first start the tip is read, then each pushed block is queued.
      expect(btcSocket.sent).toContainEqual({ action: 'want', data: ['blocks'] });
      const btcJob = `btc-${btc.block.height}-${btc.block.hash}`;
      await expect.poll(jobIds, { timeout: 5_000 }).toEqual([btcJob]);
      btcSocket.push({
        block: { id: btc.block.hash, height: btc.block.height, timestamp: btc.block.timestamp },
      });
      btcSocket.push({
        block: { id: btc.block.hash, height: btc.block.height, timestamp: btc.block.timestamp },
      });

      // Ethereum: new heads, and PAXG's Transfer, SupplyIncreased and SupplyDecreased logs.
      expect(ethSocket.sent).toEqual([
        { jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_subscribe',
          params: [
            'logs',
            {
              address: '0x45804880de22913dafe09f4980848ece6ecbaf78',
              topics: [
                [
                  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                  '0xf5c174d57843e57fea3c649fdde37f015ef08750759cbee88060390566a98797',
                  '0x1b7e18241beced0d7f41fbab1ea8ed468732edbcb74ec4420151654ca71c8a63',
                ],
              ],
            },
          ],
        },
      ]);
      ethSocket.push({ jsonrpc: '2.0', id: 1, result: '0xheads' });
      ethSocket.push({ jsonrpc: '2.0', id: 2, result: '0xlogs' });
      const head = { number: hex(mint.block.number), timestamp: hex(mint.block.timestamp) };
      ethSocket.push({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0xheads', result: head },
      });
      const [supply] = paxgLogs(mint);
      for (let i = 0; i < 2; i++)
        ethSocket.push({
          jsonrpc: '2.0',
          method: 'eth_subscription',
          params: { subscription: '0xlogs', result: supply },
        });
      ethSocket.push({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0xlogs', result: { ...supply, removed: true } },
      });

      // Solana: one subscription per listed exchange wallet; a failed transaction is not read.
      expect(solSocket.sent).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [EXCHANGE_SOL] }, { commitment: 'confirmed' }],
        },
      ]);
      solSocket.push({ jsonrpc: '2.0', id: 1, result: 7 });
      const notification = (signature: string, err: unknown) => ({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { subscription: 7, result: { context: { slot: 300_000_000 }, value: { signature, err } } },
      });
      solSocket.push(notification('sig-3', null));
      solSocket.push(notification('sig-3', null));
      solSocket.push(notification('sig-failed', { InstructionError: [0, 'x'] }));

      const tx = '0xef39a122bccb55760d2568db1b832ff9ebf42e2140dcc51e80a1b9719702e2ff';
      await expect
        .poll(jobIds, { timeout: 5_000 })
        .toEqual(
          [
            btcJob,
            `eth-${mint.block.number - 2}`,
            `paxg-${tx}-132`,
            `paxg-removed-${tx}-132`,
            'sol-sig-3',
          ].sort(),
        );
      expect(await redis.hget(ETH_BLOCK_TIMES_KEY, String(mint.block.number))).toBe(
        String(mint.block.timestamp * 1000),
      );

      // The status the Whale Tracker shows, written every 5 s: each source's state and last block.
      await expect
        .poll(
          async () =>
            (await status())?.sources.map((s) => [s.chain, s.state, s.lastBlock, s.watching] as const),
          { timeout: 12_000 },
        )
        .toEqual([
          ['bitcoin', 'connected', btc.block.height, null],
          ['ethereum', 'connected', mint.block.number, null],
          ['solana', 'connected', 300_000_000, 1],
        ]);
      expect(w.summary()).toBe('on-chain: bitcoin connected, ethereum connected, solana connected');
    } finally {
      await w.stop();
    }
    expect(FakeProviderSocket.sockets.every((s) => s.readyState === 3)).toBe(true);
  });

  it('without an Alchemy key, connects to nothing but Bitcoin and says why', async () => {
    await redis.del(ONCHAIN_STATUS_KEY, ONCHAIN_LEASE);
    FakeProviderSocket.sockets = [];
    const w = watcher(null);
    await w.start();
    try {
      await expect.poll(() => FakeProviderSocket.on('btc.invalid')).toBeDefined();
      expect(FakeProviderSocket.sockets.map((s) => new URL(s.url).hostname)).toEqual(['btc.invalid']);
      const sources = (await status())!.sources;
      for (const chain of ['ethereum', 'solana'])
        expect(sources.find((s) => s.chain === chain)).toMatchObject({
          state: 'no_key',
          detail: 'no Alchemy key in .secrets-jobs/alchemy-api-key',
        });
    } finally {
      await w.stop();
    }
  });

  it('leaves the providers to the one instance holding the lease', async () => {
    await redis.del(ONCHAIN_LEASE);
    FakeProviderSocket.sockets = [];
    const first = watcher('test-key');
    const second = watcher('other-key');
    await first.start();
    await second.start();
    try {
      expect([first.holding, second.holding]).toEqual([true, false]);
      expect(second.summary()).toBe('on-chain: standby');
      await expect.poll(() => FakeProviderSocket.sockets.length).toBe(3);
      expect(FakeProviderSocket.sockets.every((s) => !s.url.includes('other-key'))).toBe(true);
    } finally {
      await second.stop();
      await first.stop();
    }
  });
});
