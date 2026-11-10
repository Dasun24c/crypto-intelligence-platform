import { describe, expect, it } from 'vitest';
import {
  CandlesQuerySchema,
  CHANNEL_PATTERN,
  channels,
  CreateClosureRequestSchema,
  CreateInstrumentRequestSchema,
  DecimalSchema,
  FeedStatusEventSchema,
  GapClosedEventSchema,
  GapsQuerySchema,
  isDurableChannel,
  SubscribeRequestSchema,
  toWireCandle,
  UpdateInstrumentRequestSchema,
  WallsQuerySchema,
} from './index.js';

const ID = '019a6f00-0000-7000-8000-000000000001';

describe('live channels (API contracts §5.3)', () => {
  it('names every channel family and recognises only those', () => {
    const names = [
      channels.ticker(ID),
      channels.book(ID),
      channels.candles(ID, '4h'),
      channels.trades(ID),
      channels.market(ID),
      channels.systemHealth,
    ];
    expect(names).toEqual([
      `ticker:${ID}`,
      `book:${ID}`,
      `candles:${ID}:4h`,
      `trades:${ID}`,
      `market:${ID}`,
      'system:health',
    ]);
    for (const n of names) expect(CHANNEL_PATTERN.test(n)).toBe(true);
    for (const bad of ['ticker:BTC', `candles:${ID}:2h`, `orders:${ID}`, 'system:secrets', `ticker:${ID}x`])
      expect(CHANNEL_PATTERN.test(bad)).toBe(false);
  });

  it('marks trades and market channels durable (they carry seq and replay)', () => {
    expect(isDurableChannel(channels.trades(ID))).toBe(true);
    expect(isDurableChannel(channels.market(ID))).toBe(true);
    expect(isDurableChannel(channels.ticker(ID))).toBe(false);
    expect(isDurableChannel(channels.candles(ID, '1m'))).toBe(false);
  });

  it('accepts subscriptions with stream positions only in Redis id form', () => {
    expect(
      SubscribeRequestSchema.safeParse({ channels: [channels.market(ID)], since: { x: '1794300000000-0' } })
        .success,
    ).toBe(true);
    expect(
      SubscribeRequestSchema.safeParse({ channels: [channels.market(ID)], since: { x: 'yesterday' } })
        .success,
    ).toBe(false);
    expect(SubscribeRequestSchema.safeParse({ channels: [] }).success).toBe(false);
  });
});

describe('market schemas', () => {
  it('maps a candle to its wire form', () => {
    expect(
      toWireCandle({
        openTime: 60_000,
        open: '1',
        high: '2',
        low: '0.5',
        close: '1.5',
        volume: '10',
        quoteVolume: '15',
        tradeCount: null,
        quality: 'repaired',
        underlyingClosed: true,
      }),
    ).toEqual({
      t: 60_000,
      o: '1',
      h: '2',
      l: '0.5',
      c: '1.5',
      v: '10',
      qv: '15',
      n: null,
      quality: 'repaired',
      underlyingClosed: true,
    });
  });

  it('keeps decimals as plain decimal strings', () => {
    expect(DecimalSchema.safeParse('74000.25').success).toBe(true);
    expect(DecimalSchema.safeParse('-0.5').success).toBe(true);
    for (const bad of ['1e-7', '1,000', '', '.5']) expect(DecimalSchema.safeParse(bad).success).toBe(false);
  });

  it('coerces query strings and bounds candle requests at 5,000', () => {
    expect(CandlesQuerySchema.parse({ tf: '1h', from: '1000' })).toEqual({
      tf: '1h',
      from: 1000,
      limit: 1000,
    });
    expect(CandlesQuerySchema.safeParse({ tf: '1h', limit: '5001' }).success).toBe(false);
    expect(CandlesQuerySchema.safeParse({ tf: '2h' }).success).toBe(false);
    expect(CandlesQuerySchema.safeParse({ tf: '1h', extra: 'x' }).success).toBe(false);
    expect(WallsQuerySchema.parse({ active: 'true' })).toEqual({ active: true });
    expect(WallsQuerySchema.parse({ active: 'false' })).toEqual({ active: false });
    expect(GapsQuerySchema.parse({ status: 'open' })).toEqual({ status: 'open', limit: 100 });
  });

  it('validates instrument administration requests', () => {
    expect(
      CreateInstrumentRequestSchema.parse({
        venue: 'coinbase',
        venueSymbol: 'XRP-USD',
        base: 'XRP',
        quote: 'USD',
        assetClass: 'crypto',
      }),
    ).toMatchObject({
      role: 'monitored',
      isPrimaryVenue: false,
      underlyingCalendar: null,
      storeRawTrades: true,
    });
    for (const venueSymbol of ['xrpusdt', 'XRP USDT', 'X', 'XRP-USD-PERP'])
      expect(
        CreateInstrumentRequestSchema.safeParse({
          venue: 'binance',
          venueSymbol,
          base: 'XRP',
          quote: 'USDT',
          assetClass: 'crypto',
        }).success,
      ).toBe(false);
    expect(UpdateInstrumentRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateInstrumentRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('requires a holiday to end after it starts', () => {
    expect(CreateClosureRequestSchema.safeParse({ from: 2, to: 1 }).success).toBe(false);
    expect(CreateClosureRequestSchema.parse({ from: 1, to: 2 })).toEqual({
      calendar: 'gold',
      from: 1,
      to: 2,
    });
  });

  it('describes market channel events, keeping a repair outcome as extra fields', () => {
    expect(
      GapClosedEventSchema.parse({
        gapId: ID,
        instrumentId: ID,
        status: 'repaired',
        inserted: 5,
        aggregates: 2,
      }),
    ).toMatchObject({ inserted: 5, aggregates: 2 });
    expect(
      FeedStatusEventSchema.safeParse({
        instrumentId: ID,
        stream: 'trades',
        state: 'disconnected',
        detail: 'delisted',
        previous: 'trading',
      }).success,
    ).toBe(true);
  });
});
