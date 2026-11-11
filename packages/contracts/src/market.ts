import { z } from 'zod';
import { PageQuerySchema, TsSchema, UuidSchema } from './common.js';

/** Market data (API contracts §3 "Market data", §4 key schemas, §5 channels). Decimals are strings. */

export const DecimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal string');
export type Decimal = z.infer<typeof DecimalSchema>;

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Tf = z.infer<typeof TimeframeSchema>;

export const VENUES = ['binance', 'coinbase', 'replay'] as const;
export const VenueSchema = z.enum(VENUES);
export const ASSET_CLASSES = ['crypto', 'tokenised_gold', 'stablecoin'] as const;
export const AssetClassSchema = z.enum(ASSET_CLASSES);
export const InstrumentRoleSchema = z.enum(['monitored', 'reference']);
export const VenueStatusSchema = z.enum(['trading', 'halted', 'delisted', 'unknown']);

export const InstrumentSchema = z.object({
  id: UuidSchema,
  venue: VenueSchema,
  venueSymbol: z.string(),
  base: z.string(),
  quote: z.string(),
  assetClass: AssetClassSchema,
  role: InstrumentRoleSchema,
  /** e.g. 'PAXG (gold-backed token) · Binance PAXG/USDT' */
  displayName: z.string(),
  priceTick: DecimalSchema,
  qtyStep: DecimalSchema,
  isPrimaryVenue: z.boolean(),
  venueStatus: VenueStatusSchema,
  enabled: z.boolean(),
  /** Whether every trade is stored (needed for micro profiles and the large-trade threshold's history). */
  storeRawTrades: z.boolean(),
  profile: z.object({ name: z.string(), version: z.number().int() }).nullable(),
  underlyingCalendar: z.enum(['gold']).nullable(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export const CandleQualitySchema = z.enum(['complete', 'repaired', 'partial']);

export const CandleSchema = z.object({
  t: TsSchema,
  o: DecimalSchema,
  h: DecimalSchema,
  l: DecimalSchema,
  c: DecimalSchema,
  v: DecimalSchema,
  qv: DecimalSchema,
  n: z.number().int().nullable(),
  quality: CandleQualitySchema,
  underlyingClosed: z.boolean(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const TickerSchema = z.object({
  instrumentId: UuidSchema,
  ts: TsSchema,
  last: DecimalSchema,
  bid: DecimalSchema,
  ask: DecimalSchema,
  change24hPct: z.number(),
  volume24hQuote: DecimalSchema,
});
export type Ticker = z.infer<typeof TickerSchema>;

const LevelSchema = z.tuple([DecimalSchema, DecimalSchema]);
export const BookSnapshotSchema = z.object({
  instrumentId: UuidSchema,
  ts: TsSchema,
  bids: z.array(LevelSchema),
  asks: z.array(LevelSchema),
  /** How far from mid the local book reaches on its shorter side. */
  coverageBps: z.number(),
});
export type BookSnapshot = z.infer<typeof BookSnapshotSchema>;

/** 1 Hz book metrics; depth is quote-currency notional within ±0.1%, ±0.5% and ±1% of mid. */
export const BookMetricsSchema = z.object({
  ts: TsSchema,
  mid: DecimalSchema,
  spreadBps: z.number(),
  bidDepth10bp: z.number().nullable(),
  askDepth10bp: z.number().nullable(),
  bidDepth50bp: z.number().nullable(),
  askDepth50bp: z.number().nullable(),
  bidDepth100bp: z.number().nullable(),
  askDepth100bp: z.number().nullable(),
  imbalance10bp: z.number().nullable(),
  imbalance50bp: z.number().nullable(),
  imbalance100bp: z.number().nullable(),
  coverageBps: z.number().nullable(),
});
export type BookMetrics = z.infer<typeof BookMetricsSchema>;

export const LargeTradeSchema = z.object({
  id: UuidSchema,
  instrumentId: UuidSchema,
  ts: TsSchema,
  takerSide: z.enum(['buy', 'sell']),
  avgPrice: DecimalSchema,
  qty: DecimalSchema,
  notionalUsd: DecimalSchema,
  /** single: one venue message; taker_order: merged by order id or Binance sweep; burst: same side within 250 ms. */
  grouping: z.enum(['single', 'taker_order', 'burst']),
  fillCount: z.number().int(),
  priceLevels: z.number().int(),
  thresholdUsd: DecimalSchema,
});
export type LargeTrade = z.infer<typeof LargeTradeSchema>;

export const WallSchema = z.object({
  id: UuidSchema,
  instrumentId: UuidSchema,
  side: z.enum(['bid', 'ask']),
  price: DecimalSchema,
  firstSeen: TsSchema,
  lastSeen: TsSchema,
  maxNotionalUsd: DecimalSchema,
  /** null while the wall stands. */
  endedReason: z.enum(['filled', 'pulled', 'unknown']).nullable(),
});
export type Wall = z.infer<typeof WallSchema>;

export const CrossVenueSpreadSchema = z.object({
  baseAsset: z.string(),
  ts: TsSchema,
  primaryInstrumentId: UuidSchema,
  secondaryInstrumentId: UuidSchema,
  /** The primary venue's USDT price × USDT-USD. */
  primaryUsd: DecimalSchema,
  secondaryUsd: DecimalSchema,
  usdtUsd: DecimalSchema,
  /** (secondary − primary) / primary, in bps. */
  spreadBps: z.number(),
});
export type CrossVenueSpread = z.infer<typeof CrossVenueSpreadSchema>;

export const GapStreamSchema = z.enum(['trades', 'depth', 'kline', 'ticker']);
export const DataGapSchema = z.object({
  id: UuidSchema,
  instrumentId: UuidSchema,
  stream: GapStreamSchema,
  from: TsSchema,
  to: TsSchema.nullable(),
  detectedAt: TsSchema,
  detectedBy: z.enum(['sequence', 'heartbeat', 'timer', 'reconnect', 'consistency_check']),
  status: z.enum(['open', 'backfilling', 'repaired', 'unrepairable']),
  resolvedAt: TsSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type DataGap = z.infer<typeof DataGapSchema>;

export const ClosureSchema = z.object({
  calendar: z.literal('gold'),
  from: TsSchema,
  to: TsSchema,
  reason: z.enum(['weekend', 'daily_break', 'holiday']),
  source: z.enum(['generated', 'manual']),
});
export type Closure = z.infer<typeof ClosureSchema>;

export const FeedStatusSchema = z.object({
  instrumentId: UuidSchema,
  stream: GapStreamSchema,
  state: z.enum(['connected', 'degraded', 'disconnected']),
  lastMessageAt: TsSchema.nullable(),
  lagMsP50: z.number().nullable(),
  lagMsP95: z.number().nullable(),
  openGaps: z.number().int(),
  /** streaming, no messages, delayed, disconnected, halted, ... */
  detail: z.string(),
});
export type FeedStatus = z.infer<typeof FeedStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

const ms = z.coerce.number().int().nonnegative();

export const InstrumentIdParamSchema = z.strictObject({ instrumentId: UuidSchema });

export const CandlesQuerySchema = z.strictObject({
  tf: TimeframeSchema,
  from: ms.optional(),
  to: ms.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type CandlesQuery = z.infer<typeof CandlesQuerySchema>;

export const RangeQuerySchema = z.strictObject({ from: ms.optional(), to: ms.optional() });
export type RangeQuery = z.infer<typeof RangeQuerySchema>;

export const BookQuerySchema = z.strictObject({
  depth: z.coerce.number().int().min(1).max(50).default(50),
});

export const LargeTradesQuerySchema = PageQuerySchema.extend({ from: ms.optional(), to: ms.optional() });
export type LargeTradesQuery = z.infer<typeof LargeTradesQuerySchema>;

export const WallsQuerySchema = z.strictObject({
  from: ms.optional(),
  to: ms.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type WallsQuery = z.infer<typeof WallsQuerySchema>;

export const GapsQuerySchema = PageQuerySchema.extend({
  instrumentId: UuidSchema.optional(),
  status: DataGapSchema.shape.status.optional(),
});
export type GapsQuery = z.infer<typeof GapsQuerySchema>;

export const ClosuresQuerySchema = z.strictObject({
  calendar: z.literal('gold').default('gold'),
  from: ms.optional(),
  to: ms.optional(),
});
export type ClosuresQuery = z.infer<typeof ClosuresQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------------------------

export const CreateInstrumentRequestSchema = z.strictObject({
  venue: z.enum(['binance', 'coinbase']),
  venueSymbol: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,20}(-[A-Z0-9]{2,10})?$/, 'venue symbol, e.g. BTCUSDT or BTC-USD'),
  base: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,10}$/),
  quote: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,10}$/),
  assetClass: AssetClassSchema,
  role: InstrumentRoleSchema.default('monitored'),
  isPrimaryVenue: z.boolean().default(false),
  underlyingCalendar: z.enum(['gold']).nullable().default(null),
  storeRawTrades: z.boolean().default(true),
});
export type CreateInstrumentRequest = z.infer<typeof CreateInstrumentRequestSchema>;

export const UpdateInstrumentRequestSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    isPrimaryVenue: z.boolean().optional(),
    role: InstrumentRoleSchema.optional(),
    storeRawTrades: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateInstrumentRequest = z.infer<typeof UpdateInstrumentRequestSchema>;

export const CreateClosureRequestSchema = z
  .strictObject({ calendar: z.literal('gold').default('gold'), from: TsSchema, to: TsSchema })
  .refine((v) => v.to > v.from, { message: 'to must be after from', path: ['to'] });
export type CreateClosureRequest = z.infer<typeof CreateClosureRequestSchema>;

export const DeleteClosureQuerySchema = z.strictObject({
  calendar: z.literal('gold').default('gold'),
  from: ms,
});

// ---------------------------------------------------------------------------------------------
// Live channels (API contracts §5)
// ---------------------------------------------------------------------------------------------

/** Socket.IO namespace; the client connects with `transports: ['websocket']` and `auth: { token }`. */
export const WS_NAMESPACE = '/v1';
/** Socket.IO's default HTTP path, routed by Caddy (and the Vite dev proxy) to the API. */
export const WS_PATH = '/socket.io';

export const channels = {
  ticker: (instrumentId: string) => `ticker:${instrumentId}`,
  book: (instrumentId: string) => `book:${instrumentId}`,
  candles: (instrumentId: string, tf: Tf) => `candles:${instrumentId}:${tf}`,
  trades: (instrumentId: string) => `trades:${instrumentId}`,
  market: (instrumentId: string) => `market:${instrumentId}`,
  indicators: (instrumentId: string, tf: Tf) => `indicators:${instrumentId}:${tf}`,
  smc: (instrumentId: string) => `smc:${instrumentId}`,
  systemHealth: 'system:health',
} as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const CHANNEL_PATTERN = new RegExp(
  `^(?:(?:ticker|book|trades|market|smc):${UUID}|(?:candles|indicators):${UUID}:(?:1m|5m|15m|1h|4h|1d)|system:health)$`,
);

/**
 * Durable channels carry `seq` (the id of the stream entry behind the message: md:events for
 * trades and market, an:events for indicators and smc) and can be replayed after a reconnect.
 */
export function isDurableChannel(channel: string): boolean {
  return (
    channel.startsWith('trades:') ||
    channel.startsWith('market:') ||
    channel.startsWith('indicators:') ||
    channel.startsWith('smc:')
  );
}

export const SubscribeRequestSchema = z.strictObject({
  channels: z.array(z.string().max(80)).min(1).max(100),
  since: z.record(z.string(), z.string().regex(/^\d+-\d+$/)).optional(),
});
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const UnsubscribeRequestSchema = z.strictObject({
  channels: z.array(z.string().max(80)).min(1).max(100),
});

export interface SubscribeAck {
  ok: boolean;
  results: Record<
    string,
    {
      mode: 'replayed' | 'snapshot' | 'live';
      seq?: string;
      snapshot?: unknown;
      error?: 'CHANNEL_UNKNOWN' | 'FORBIDDEN' | 'RATE_LIMITED';
    }
  >;
}

/** Every server → client message, on the event 'message'. */
export interface Envelope<T = unknown> {
  ch: string;
  seq?: string;
  ts: number;
  type: string;
  data: T;
}

/** `market:{id}` payloads (data of the envelope). */
export const GapOpenedEventSchema = z.object({
  gapId: UuidSchema,
  instrumentId: UuidSchema,
  stream: GapStreamSchema,
  from: TsSchema,
  to: TsSchema.nullable(),
  detectedBy: DataGapSchema.shape.detectedBy,
});
export type GapOpenedEvent = z.infer<typeof GapOpenedEventSchema>;

/** Carries the repair's outcome (inserted, aggregates, restCandles) or the reason it could not be repaired. */
export const GapClosedEventSchema = z
  .object({
    gapId: UuidSchema,
    instrumentId: UuidSchema.nullable(),
    status: z.enum(['repaired', 'unrepairable']),
  })
  .catchall(z.unknown());
export type GapClosedEvent = z.infer<typeof GapClosedEventSchema>;

/** A feed's state changed; from the ingestor (with lag and last message) or from the pair-status job. */
export const FeedStatusEventSchema = z.object({
  instrumentId: UuidSchema,
  stream: GapStreamSchema,
  state: FeedStatusSchema.shape.state,
  previous: z.string(),
  detail: z.string(),
  lastMessageAt: TsSchema.nullable().optional(),
  lagMsP50: z.number().nullable().optional(),
  lagMsP95: z.number().nullable().optional(),
});
export type FeedStatusEvent = z.infer<typeof FeedStatusEventSchema>;

/** Message types per channel family. */
export type MarketMessageType =
  | 'ticker'
  | 'book.snapshot'
  | 'candle.update'
  | 'candle.closed'
  | 'trade.large'
  | 'gap.opened'
  | 'gap.closed'
  | 'feed.status'
  | 'wall.appeared'
  | 'wall.ended'
  | 'spread'
  | 'indicators.closed'
  | 'swing.confirmed'
  | 'structure'
  | 'range.detected'
  | 'range.ended'
  | 'level.created'
  | 'level.status'
  | 'sweep'
  | 'health.update';

/** A stored or live candle in its wire form (structural, so this package stays dependency-free). */
export function toWireCandle(c: {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  tradeCount: number | null;
  quality: Candle['quality'];
  underlyingClosed: boolean;
}): Candle {
  return {
    t: c.openTime,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
    qv: c.quoteVolume,
    n: c.tradeCount,
    quality: c.quality,
    underlyingClosed: c.underlyingClosed,
  };
}

/** Redis pub/sub channels announcing admin changes; the ingestor reloads without a restart (MD-02). */
export const CONFIG_CHANNELS = { instruments: 'config:instruments', closures: 'config:closures' } as const;
