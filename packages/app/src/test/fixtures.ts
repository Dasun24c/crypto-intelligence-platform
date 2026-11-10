import type {
  CrossVenueSpread,
  FeedStatus,
  Instrument,
  LargeTrade,
  SystemHealth,
  Ticker,
  Wall,
} from '@cip/contracts';

/** Instruments as the development seed defines them (packages/db migration 0005). */
function instrument(
  n: number,
  venue: Instrument['venue'],
  venueSymbol: string,
  base: string,
  quote: string,
  extra: Partial<Instrument> = {},
): Instrument {
  const venueName = { binance: 'Binance', coinbase: 'Coinbase', replay: 'Replay' }[venue];
  const gold = base === 'PAXG';
  return {
    id: `019a6f00-0000-7000-8000-${String(n).padStart(12, '0')}`,
    venue,
    venueSymbol,
    base,
    quote,
    assetClass: gold ? 'tokenised_gold' : base === 'USDT' ? 'stablecoin' : 'crypto',
    role: base === 'USDT' ? 'reference' : 'monitored',
    displayName: `${gold ? 'PAXG (gold-backed token)' : base} · ${venueName} ${base}/${quote}`,
    priceTick: base === 'USDT' ? '0.00001' : '0.01',
    qtyStep: '0.00001',
    isPrimaryVenue: venue === 'binance',
    venueStatus: 'trading',
    enabled: true,
    profile: null,
    underlyingCalendar: gold ? 'gold' : null,
    ...extra,
  };
}

export const BTC_BINANCE = instrument(1, 'binance', 'BTCUSDT', 'BTC', 'USDT');
export const PAXG_BINANCE = instrument(4, 'binance', 'PAXGUSDT', 'PAXG', 'USDT');
export const BTC_COINBASE = instrument(5, 'coinbase', 'BTC-USD', 'BTC', 'USD');
export const PAXG_COINBASE = instrument(8, 'coinbase', 'PAXG-USD', 'PAXG', 'USD');
export const USDT_COINBASE = instrument(9, 'coinbase', 'USDT-USD', 'USDT', 'USD');
export const BTC_REPLAY = instrument(20, 'replay', 'BTCUSDT', 'BTC', 'USDT', { isPrimaryVenue: false });

export const INSTRUMENTS = [BTC_BINANCE, PAXG_BINANCE, BTC_COINBASE, PAXG_COINBASE, USDT_COINBASE];

export function ticker(instrumentId: string, last: string, extra: Partial<Ticker> = {}): Ticker {
  return {
    instrumentId,
    ts: Date.now() - 1_000,
    last,
    bid: last,
    ask: last,
    change24hPct: 0,
    volume24hQuote: '1000000',
    ...extra,
  };
}

export function feed(instrumentId: string, stream: FeedStatus['stream'], extra: Partial<FeedStatus> = {}) {
  return {
    instrumentId,
    stream,
    state: 'connected',
    lastMessageAt: Date.now() - 500,
    lagMsP50: 120,
    lagMsP95: 480,
    openGaps: 0,
    detail: 'streaming',
    ...extra,
  } satisfies FeedStatus;
}

export function health(feeds: FeedStatus[], extra: Partial<SystemHealth> = {}): SystemHealth {
  const now = Date.now();
  const instance = (service: 'api' | 'ingestor' | 'analyzer' | 'jobs') => ({
    service,
    instance: `${service}-1`,
    version: '0.2.0',
    startedAt: now - 60_000,
    sentAt: now - 1_000,
    status: 'ok' as const,
    detail: 'running',
    ageMs: 1_000,
  });
  return {
    status: feeds.every((f) => f.state === 'connected') ? 'ok' : 'degraded',
    checkedAt: now - 1_000,
    dependencies: [
      { name: 'database', status: 'ok', latencyMs: 2, detail: 'reachable' },
      { name: 'redis', status: 'ok', latencyMs: 1, detail: 'reachable' },
    ],
    services: (['api', 'ingestor', 'analyzer', 'jobs'] as const).map((s) => ({
      service: s,
      status: 'ok' as const,
      instances: [instance(s)],
    })),
    feeds,
    ...extra,
  };
}

export function largeTrade(n: number, instrumentId: string, extra: Partial<LargeTrade> = {}): LargeTrade {
  return {
    id: `019a7000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    instrumentId,
    ts: Date.now() - (100 - n) * 1_000,
    takerSide: n % 2 === 0 ? 'buy' : 'sell',
    avgPrice: '74012.35',
    qty: '2.5',
    notionalUsd: '185030.875',
    grouping: 'taker_order',
    fillCount: 7,
    priceLevels: 3,
    thresholdUsd: '150000',
    ...extra,
  };
}

export function wall(n: number, instrumentId: string, extra: Partial<Wall> = {}): Wall {
  return {
    id: `019a7100-0000-7000-8000-${String(n).padStart(12, '0')}`,
    instrumentId,
    side: 'bid',
    price: '74000',
    firstSeen: Date.now() - 20 * 60_000,
    lastSeen: Date.now() - 1_000,
    maxNotionalUsd: '2500000',
    endedReason: null,
    ...extra,
  };
}

export function spread(ts: number, spreadBps: number): CrossVenueSpread {
  return {
    baseAsset: 'PAXG',
    ts,
    primaryInstrumentId: PAXG_BINANCE.id,
    secondaryInstrumentId: PAXG_COINBASE.id,
    primaryUsd: '4106.99234567',
    secondaryUsd: '4107.95',
    usdtUsd: '0.99985',
    spreadBps,
  };
}
