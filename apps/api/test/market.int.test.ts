import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CONFIG_CHANNELS, type Instrument } from '@cip/contracts';
import { createDb } from '@cip/db';
import { REDIS } from '../src/tokens.ts';
import { call, createUser, type Harness, startApi, tokenFor } from './harness.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const BTC_CB = '019a6f00-0000-7000-8000-000000000005';
const PAXG_BN = '019a6f00-0000-7000-8000-000000000004';
const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';

let h: Harness;
let viewer: string;
let admin: string;
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });

beforeAll(async () => {
  h = await startApi();
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  admin = await tokenFor(h, await createUser(h, 'admin'));
});
afterAll(async () => {
  await h.close();
  await owner.destroy();
});

const get = (path: string, token = viewer) => call(h.base, 'GET', `/api/v1${path}`, { token });

describe('market data endpoints', () => {
  it('lists the seeded instruments with display names, and needs a signed-in user', async () => {
    expect((await call(h.base, 'GET', '/api/v1/instruments')).status).toBe(401);
    const res = await get('/instruments');
    expect(res.status).toBe(200);
    const list = res.body as Instrument[];
    expect(list).toHaveLength(9);
    expect(list.find((i) => i.id === PAXG_BN)).toMatchObject({
      venue: 'binance',
      venueSymbol: 'PAXGUSDT',
      displayName: 'PAXG (gold-backed token) · Binance PAXG/USDT',
      underlyingCalendar: 'gold',
      isPrimaryVenue: true,
      enabled: true,
    });
  });

  it('serves candles oldest first: the latest by default, or forward from `from`', async () => {
    const t0 = Date.UTC(2026, 10, 1, 0, 0);
    await owner
      .insertInto('market.candles')
      .values(
        [0, 1, 2, 3, 4].map((i) => ({
          instrument_id: BTC,
          timeframe: '1m' as const,
          open_time: new Date(t0 + i * 60_000),
          open: String(100 + i),
          high: String(101 + i),
          low: String(99 + i),
          close: String(100.5 + i),
          volume: '1',
          quote_volume: '100',
          trade_count: 3,
          taker_buy_volume: '0.5',
          micro_profile: null,
          source: 'exchange_kline' as const,
          quality: i === 2 ? ('repaired' as const) : ('complete' as const),
          underlying_closed: false,
          finalized_at: new Date(),
        })),
      )
      .execute();
    const latest = await get(`/market/${BTC}/candles?tf=1m&limit=2`);
    expect(latest.body.map((c: { t: number }) => c.t)).toEqual([t0 + 3 * 60_000, t0 + 4 * 60_000]);
    const forward = await get(`/market/${BTC}/candles?tf=1m&from=${t0 + 60_000}&limit=2`);
    expect(forward.body).toEqual([
      expect.objectContaining({ t: t0 + 60_000, o: '101', c: '101.5', n: 3, quality: 'complete' }),
      expect.objectContaining({ t: t0 + 120_000, quality: 'repaired', underlyingClosed: false }),
    ]);
    expect((await get(`/market/${BTC}/candles?tf=2m`)).status).toBe(400);
    expect((await get(`/market/${BTC}/candles?tf=1m&limit=5001`)).status).toBe(400);
    expect((await get(`/market/${randomUUID()}/candles?tf=1m`)).status).toBe(404);
    expect((await get(`/market/not-a-uuid/candles?tf=1m`)).status).toBe(400);
  });

  it('serves the live ticker and book from Redis, and says so when the feed is not streaming', async () => {
    const redis = h.app.get<Redis>(REDIS);
    expect((await get(`/market/${BTC_CB}/ticker`)).status).toBe(503);
    const ticker = {
      instrumentId: BTC_CB,
      ts: 1,
      last: '74000.5',
      bid: '74000',
      ask: '74001',
      change24hPct: 1.25,
      volume24hQuote: '123456789',
    };
    await redis.set(`ticker:${BTC_CB}`, JSON.stringify(ticker), 'PX', 5_000);
    expect((await get(`/market/${BTC_CB}/ticker`)).body).toEqual(ticker);
    await redis.set(
      `book:${BTC_CB}`,
      JSON.stringify({
        instrumentId: BTC_CB,
        ts: 1,
        bids: [
          ['74000', '1'],
          ['73999', '2'],
        ],
        asks: [['74001', '1.5']],
        coverageBps: 42,
      }),
      'PX',
      5_000,
    );
    const book = await get(`/market/${BTC_CB}/book?depth=1`);
    expect(book.body).toMatchObject({ bids: [['74000', '1']], asks: [['74001', '1.5']], coverageBps: 42 });
  });

  it('pages large trades newest first with a keyset cursor', async () => {
    const base = Date.UTC(2026, 10, 2);
    await owner
      .insertInto('market.large_trades')
      .values(
        [0, 1, 2].map((i) => ({
          id: randomUUID(),
          instrument_id: BTC,
          ts: new Date(base + i * 1_000),
          taker_side: 'buy' as const,
          avg_price: '74000',
          qty: String(4 + i),
          notional_usd: String(296_000 + i * 74_000),
          grouping: 'taker_order' as const,
          fill_count: 3,
          price_levels: 2,
          threshold_usd: '250000',
        })),
      )
      .execute();
    const first = await get(`/market/${BTC}/large-trades?limit=2`);
    expect(first.body.items.map((t: { qty: string }) => t.qty)).toEqual(['6', '5']);
    expect(first.body.nextCursor).toMatch(/^\d+_[0-9a-f-]{36}$/);
    const second = await get(`/market/${BTC}/large-trades?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toEqual({ items: [expect.objectContaining({ qty: '4' })], nextCursor: null });
    expect((await get(`/market/${BTC}/large-trades?cursor=bogus`)).status).toBe(400);
  });

  it('filters walls by standing or ended, gaps by status, and returns spreads and closures in range', async () => {
    const now = h.clock.now;
    await owner
      .insertInto('market.orderbook_walls')
      .values([
        wall(PAXG_CB, now - 60_000, null),
        wall(PAXG_CB, now - 120_000, 'pulled'),
        wall(PAXG_CB, now - 10 * 86_400_000, 'filled'),
      ])
      .execute();
    expect((await get(`/market/${PAXG_CB}/walls?active=true`)).body).toEqual([
      expect.objectContaining({ endedReason: null, maxNotionalUsd: '163980' }),
    ]);
    expect((await get(`/market/${PAXG_CB}/walls`)).body).toHaveLength(2); // the last day only
    expect((await get(`/market/${PAXG_CB}/walls?active=false`)).body).toEqual([
      expect.objectContaining({ endedReason: 'pulled' }),
    ]);
    expect((await get(`/market/${PAXG_CB}/walls?from=0&to=${now}`)).status).toBe(400); // over 7 days

    const gap = (status: 'open' | 'repaired') => ({
      id: randomUUID(),
      instrument_id: PAXG_CB,
      stream: 'trades' as const,
      gap_start: new Date(now - 3_600_000),
      gap_end: new Date(now - 3_000_000),
      detected_at: new Date(now - 3_000_000),
      detected_by: 'reconnect' as const,
      status,
    });
    await owner
      .insertInto('market.data_gaps')
      .values([gap('open'), gap('repaired')])
      .execute();
    const open = await get(`/market/gaps?instrumentId=${PAXG_CB}&status=open`);
    expect(open.body.items).toEqual([expect.objectContaining({ status: 'open', detectedBy: 'reconnect' })]);

    await owner
      .insertInto('market.cross_venue_spreads')
      .values({
        base_asset: 'PAXG',
        ts: new Date(now - 30_000),
        primary_instrument_id: PAXG_BN,
        secondary_instrument_id: PAXG_CB,
        primary_usd: '4097.95',
        secondary_usd: '4100',
        usdt_usd: '0.9995',
        spread_bps: 5.0025,
      })
      .execute();
    expect((await get('/market/spreads/PAXG')).body).toEqual([
      expect.objectContaining({ primaryUsd: '4097.95', spreadBps: 5.0025, usdtUsd: '0.9995' }),
    ]);
    expect((await get('/market/spreads/paxg!')).status).toBe(400);

    await owner
      .insertInto('market.underlying_market_closures')
      .values({
        calendar_id: 'gold',
        starts_at: new Date(now + 3_600_000),
        ends_at: new Date(now + 7_200_000),
        reason: 'daily_break',
        source: 'generated',
      })
      .execute();
    expect((await get('/market/closures?calendar=gold')).body).toEqual([
      {
        calendar: 'gold',
        from: now + 3_600_000,
        to: now + 7_200_000,
        reason: 'daily_break',
        source: 'generated',
      },
    ]);
  });
});

describe('instrument administration', () => {
  it('is for admins only', async () => {
    const analyst = await tokenFor(h, await createUser(h, 'analyst'));
    expect((await call(h.base, 'GET', '/api/v1/admin/instruments', { token: analyst })).status).toBe(403);
  });

  it('adds a pair the venue lists, audits it and tells the ingestor; refuses unknown, halted and duplicate pairs', async () => {
    const sub = new Redis(inject('redisUrl'));
    const announced: string[] = [];
    await sub.subscribe(CONFIG_CHANNELS.instruments);
    sub.on('message', (_c: string, m: string) => announced.push(m));
    try {
      const body = {
        venue: 'binance',
        venueSymbol: 'XRPUSDT',
        base: 'XRP',
        quote: 'USDT',
        assetClass: 'crypto',
      };
      const created = await call(h.base, 'POST', '/api/v1/admin/instruments', { token: admin, body });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        venueSymbol: 'XRPUSDT',
        priceTick: '0.01',
        role: 'monitored',
        venueStatus: 'trading',
        enabled: true,
        displayName: 'XRP · Binance XRP/USDT',
      });
      await expect.poll(() => announced).toContain(created.body.id);
      const audit = await call(h.base, 'GET', '/api/v1/admin/audit?action=instrument.', { token: admin });
      expect(audit.body.items[0]).toMatchObject({ action: 'instrument.created', targetId: created.body.id });

      const post = (b: object) =>
        call(h.base, 'POST', '/api/v1/admin/instruments', { token: admin, body: b });
      expect((await post(body)).status).toBe(409);
      expect((await post({ ...body, venueSymbol: 'NOPEUSDT' })).status).toBe(400);
      expect((await post({ ...body, venueSymbol: 'HALTUSDT' })).status).toBe(409);
      expect((await post({ ...body, venueSymbol: 'xrp usdt' })).status).toBe(400);

      // Disabling stops the feed: the instrument leaves the public list, stays in the admin list.
      const off = await call(h.base, 'PATCH', `/api/v1/admin/instruments/${created.body.id}`, {
        token: admin,
        body: { enabled: false },
      });
      expect(off.body.enabled).toBe(false);
      expect((await get('/instruments')).body.some((i: Instrument) => i.id === created.body.id)).toBe(false);
      expect(
        (await call(h.base, 'GET', '/api/v1/admin/instruments', { token: admin })).body.some(
          (i: Instrument) => i.id === created.body.id,
        ),
      ).toBe(true);
      expect(
        (
          await call(h.base, 'PATCH', `/api/v1/admin/instruments/${created.body.id}`, {
            token: admin,
            body: {},
          })
        ).status,
      ).toBe(400);
    } finally {
      sub.disconnect();
    }
  });

  it('keeps one primary venue per base asset', async () => {
    const res = await call(h.base, 'PATCH', `/api/v1/admin/instruments/${PAXG_CB}`, {
      token: admin,
      body: { isPrimaryVenue: true },
    });
    expect(res.body.isPrimaryVenue).toBe(true);
    const list = (await get('/instruments')).body as Instrument[];
    expect(list.find((i) => i.id === PAXG_BN)!.isPrimaryVenue).toBe(false);
    await call(h.base, 'PATCH', `/api/v1/admin/instruments/${PAXG_BN}`, {
      token: admin,
      body: { isPrimaryVenue: true },
    });
    expect(
      ((await get('/instruments')).body as Instrument[]).find((i) => i.id === PAXG_CB)!.isPrimaryVenue,
    ).toBe(false);
  });

  it('adds and removes gold-market holidays with an audit entry each', async () => {
    const from = Date.UTC(2026, 11, 25, 0, 0);
    const to = from + 86_400_000;
    const created = await call(h.base, 'POST', '/api/v1/admin/closures', {
      token: admin,
      body: { calendar: 'gold', from, to },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ calendar: 'gold', from, to, reason: 'holiday', source: 'manual' });
    expect(
      (await call(h.base, 'POST', '/api/v1/admin/closures', { token: admin, body: { from, to } })).status,
    ).toBe(409);
    expect(
      (await call(h.base, 'POST', '/api/v1/admin/closures', { token: admin, body: { from: to, to: from } }))
        .status,
    ).toBe(400);
    const listed = await get(`/market/closures?from=${from - 1}&to=${to + 1}`);
    expect(listed.body).toContainEqual(expect.objectContaining({ from, reason: 'holiday' }));
    expect(
      (await call(h.base, 'DELETE', `/api/v1/admin/closures?from=${from}`, { token: admin })).status,
    ).toBe(204);
    expect(
      (await call(h.base, 'DELETE', `/api/v1/admin/closures?from=${from}`, { token: admin })).status,
    ).toBe(404);
    const audit = await call(h.base, 'GET', '/api/v1/admin/audit?action=closure.', { token: admin });
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual([
      'closure.deleted',
      'closure.created',
    ]);
  });
});

describe('feed status', () => {
  it('reports what the venue lease holders publish, every other feed as not streaming, with open gaps', async () => {
    const redis = h.app.get<Redis>(REDIS);
    await redis.set(
      'feed:status:binance',
      JSON.stringify({
        ts: h.clock.now,
        instance: 'test',
        feeds: ['kline', 'trades', 'depth', 'ticker'].map((stream) => ({
          instrumentId: BTC,
          stream,
          state: 'connected',
          lastMessageAt: h.clock.now,
          lagMsP50: 40,
          lagMsP95: 90,
          detail: 'streaming',
        })),
      }),
      'PX',
      5_000,
    );
    const feeds = (await get('/system/feeds')).body as {
      instrumentId: string;
      stream: string;
      state: string;
      detail: string;
      openGaps: number;
    }[];
    expect(feeds.filter((f) => f.instrumentId === BTC).map((f) => f.state)).toEqual([
      'connected',
      'connected',
      'connected',
      'connected',
    ]);
    const paxgTrades = feeds.find((f) => f.instrumentId === PAXG_CB && f.stream === 'trades')!;
    expect(paxgTrades).toMatchObject({ state: 'disconnected', detail: 'not streaming', openGaps: 1 });
    const health = await get('/system/health');
    expect(health.body.feeds).toHaveLength(feeds.length);
    expect(health.body.status).not.toBe('ok'); // feeds are down
  });
});

function wall(instrumentId: string, firstSeen: number, ended: 'filled' | 'pulled' | null) {
  return {
    id: randomUUID(),
    instrument_id: instrumentId,
    side: 'bid' as const,
    price: '4099.5',
    first_seen: new Date(firstSeen),
    last_seen: new Date(firstSeen + 5_000),
    max_notional_usd: '163980',
    ended_reason: ended,
  };
}
