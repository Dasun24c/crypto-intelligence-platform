import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { CONFIG_CHANNELS } from '@cip/contracts';
import { createDb } from '@cip/db';
import { type PairStatus, RestStatusError } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { generateGoldClosures, refreshPairStatus } from '../src/market-jobs.ts';

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const jobsDb = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const redis = new Redis(inject('redisUrl'));
const sub = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });

afterAll(async () => {
  // Leave the seeded instruments as they were for any later suite.
  await owner
    .updateTable('market.instruments')
    .set({ venue_status: 'trading' })
    .where('venue_id', 'in', ['binance', 'coinbase'])
    .execute();
  await owner.destroy();
  await jobsDb.destroy();
  redis.disconnect();
  sub.disconnect();
});

const trading = (symbol: string, priceTick = '0.01'): PairStatus => ({
  symbol,
  status: 'trading',
  priceTick,
  qtyStep: symbol.endsWith('USDT') ? '0.00001' : '0.00000001',
});

describe('pair status', () => {
  it('records halts and delistings, updates tick sizes, raises feed events and reloads the ingestor', async () => {
    const before = await owner
      .selectFrom('market.instruments')
      .select(['venue_symbol', 'price_tick', 'qty_step'])
      .execute();
    const tickOf = (s: string) => before.find((r) => r.venue_symbol === s)!;
    const binance = {
      // SOLUSDT is no longer listed: the batch fails with 400, so symbols are asked one by one.
      pairStatus: async (symbols: string[]) => {
        if (symbols.includes('SOLUSDT')) throw new RestStatusError('/api/v3/exchangeInfo', 400);
        return symbols.map((s) =>
          s === 'BTCUSDT'
            ? trading(s, '0.1')
            : { ...trading(s, tickOf(s).price_tick), qtyStep: tickOf(s).qty_step },
        );
      },
    };
    const coinbase = {
      pairStatus: async (product: string): Promise<PairStatus> => {
        if (product === 'USDT-USD') throw new RestStatusError(`/products/${product}`, 404);
        const row = tickOf(product);
        return {
          symbol: product,
          status: product === 'PAXG-USD' ? 'halted' : 'trading',
          priceTick: row.price_tick,
          qtyStep: row.qty_step,
        };
      },
    };
    // Every pair confirmed earlier, except ETHUSDT which has never been checked.
    await owner.updateTable('market.instruments').set({ venue_status: 'trading' }).execute();
    await owner
      .updateTable('market.instruments')
      .set({ venue_status: 'unknown' })
      .where('venue_symbol', '=', 'ETHUSDT')
      .execute();
    const announced: string[] = [];
    await sub.subscribe(CONFIG_CHANNELS.instruments);
    sub.on('message', (_c: string, m: string) => announced.push(m));

    const result = await refreshPairStatus({ db: jobsDb, redis, log, venues: { binance, coinbase } });
    expect(result.checked).toBe(9);
    expect(result.changed.sort()).toEqual([
      'binance:BTCUSDT',
      'binance:ETHUSDT',
      'binance:SOLUSDT',
      'coinbase:PAXG-USD',
      'coinbase:USDT-USD',
    ]);
    const rows = await owner
      .selectFrom('market.instruments')
      .select(['venue_symbol', 'venue_status', 'price_tick'])
      .execute();
    const row = (s: string) => rows.find((r) => r.venue_symbol === s)!;
    expect(row('BTCUSDT')).toMatchObject({ venue_status: 'trading', price_tick: '0.1' });
    expect(row('ETHUSDT').venue_status).toBe('trading'); // confirmed quietly: no event
    expect(row('SOLUSDT').venue_status).toBe('delisted');
    expect(row('PAXG-USD').venue_status).toBe('halted');
    expect(row('USDT-USD').venue_status).toBe('delisted');

    const events = await owner
      .selectFrom('market.feed_events')
      .select(['event', 'details'])
      .where('event', '=', 'status_change')
      .execute();
    expect(events).toHaveLength(3); // neither the tick change nor the first confirmation is an event
    // Other suites share the stream (gap.closed from backfills): look at feed status events only.
    const stream = (await redis.xrange('md:events', '-', '+'))
      .filter(([, f]) => f[1] === 'feed.status')
      .map(([, f]) => JSON.parse(f[3]!) as { detail: string });
    expect(stream.map((e) => e.detail).sort()).toEqual(['delisted', 'delisted', 'halted']);
    await expect.poll(() => announced).toEqual(['pair-status']);

    // Nothing changed since: no writes, no announcement.
    expect(
      (await refreshPairStatus({ db: jobsDb, redis, log, venues: { binance, coinbase } })).changed,
    ).toEqual([]);
  });

  it('lets a network failure fail the job (it is retried) instead of marking pairs delisted', async () => {
    const broken = {
      pairStatus: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(
      refreshPairStatus({ db: jobsDb, redis, log, venues: { binance: broken, coinbase: broken } }),
    ).rejects.toThrow('ECONNRESET');
  });
});

describe('gold closure calendar', () => {
  it('writes the weekly rule 8 weeks ahead, idempotently', async () => {
    const now = Date.UTC(2026, 10, 10, 12, 0); // Tuesday
    const inserted = await generateGoldClosures(jobsDb, now);
    // 8 weeks: one weekend and four daily breaks (Mon–Thu) a week, plus the edges of the window.
    expect(inserted).toBeGreaterThanOrEqual(8 * 5);
    expect(await generateGoldClosures(jobsDb, now)).toBe(0);
    const rows = await owner
      .selectFrom('market.underlying_market_closures')
      .select(['starts_at', 'ends_at', 'reason'])
      .where('calendar_id', '=', 'gold')
      .where('source', '=', 'generated')
      .where('starts_at', '>=', new Date(Date.UTC(2026, 10, 13)))
      .where('starts_at', '<', new Date(Date.UTC(2026, 10, 17)))
      .orderBy('starts_at')
      .execute();
    // New York is on EST (UTC-5) after 1 November 2026.
    expect(rows.map((r) => [r.reason, r.starts_at.toISOString(), r.ends_at.toISOString()])).toEqual([
      ['weekend', '2026-11-13T22:00:00.000Z', '2026-11-15T23:00:00.000Z'],
      ['daily_break', '2026-11-16T22:00:00.000Z', '2026-11-16T23:00:00.000Z'],
    ]);
  });
});
