import type { DecimalString, VenueId } from '@cip/domain';

/**
 * Venue messages normalised to one vocabulary (architecture §5.1). Prices and quantities stay exact
 * decimal strings in canonical form; times are epoch ms (venue time `ts`, local `receivedAt`).
 */
export type Level = [price: DecimalString, qty: DecimalString];

interface Base {
  venue: VenueId;
  symbol: string;
  /** Venue event time (epoch ms). */
  ts: number;
  receivedAt: number;
}

export interface TradeEvent extends Base {
  type: 'trade';
  tradeId: string;
  price: DecimalString;
  qty: DecimalString;
  takerSide: 'buy' | 'sell';
  /** Coinbase `taker_order_id`; null where the venue does not publish order ids (Binance). */
  takerOrderRef: string | null;
  /** Contiguous id range covered by this message, for gap detection (Binance aggTrade id; Coinbase trade_id). */
  seq: number;
  /** Binance aggTrade: the underlying first and last trade ids, used to merge one sweep. */
  fills?: { first: number; last: number };
}

export interface KlineEvent extends Base {
  type: 'kline';
  interval: '1m';
  openTime: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
  quoteVolume: DecimalString;
  tradeCount: number;
  takerBuyVolume: DecimalString;
  /** True once the venue has closed the candle: Binance's kline `x`. */
  final: boolean;
}

export interface BookSnapshotEvent extends Base {
  type: 'book_snapshot';
  bids: Level[];
  asks: Level[];
  /** Binance REST `lastUpdateId`; absent for Coinbase. */
  lastUpdateId?: number;
}

export interface BookDeltaEvent extends Base {
  type: 'book_delta';
  /** Quantity "0" removes the level. */
  bids: Level[];
  asks: Level[];
  /** Binance update-id range `U`..`u`; absent for Coinbase `l2update`. */
  firstUpdateId?: number;
  lastUpdateId?: number;
}

export interface TickerEvent extends Base {
  type: 'ticker';
  last: DecimalString;
  bid: DecimalString;
  ask: DecimalString;
  open24h: DecimalString;
  change24hPct: number;
  volume24hBase: DecimalString;
  /** Exact on Binance (`q`); on Coinbase base volume × last price, an approximation. */
  volume24hQuote: DecimalString;
}

export interface HeartbeatEvent extends Base {
  type: 'heartbeat';
  /** Coinbase heartbeat `last_trade_id`: a trade id below it that we never saw was dropped. */
  lastTradeId: number;
}

export type MarketEvent =
  TradeEvent | KlineEvent | BookSnapshotEvent | BookDeltaEvent | TickerEvent | HeartbeatEvent;

/** A message we could not map: counted and logged, never silently dropped. */
export interface Unparsed {
  type: 'unparsed';
  venue: VenueId;
  reason: string;
  raw: unknown;
}

export type ParseResult = MarketEvent | Unparsed | null;
