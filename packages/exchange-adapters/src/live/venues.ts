import { normalizeDecimal } from '@cip/domain';
import { parseBinanceDepthSnapshot, parseBinanceMessage } from '../binance/parse.js';
import { parseCoinbaseMessage } from '../coinbase/parse.js';
import type { BookSnapshotEvent, MarketEvent, Unparsed } from '../events.js';
import { RestBudget, RestClient } from './rest.js';
import { type MinimalWebSocket, ReconnectingSocket, type SocketStatus } from './socket.js';

export interface VenueHooks {
  onEvent(event: MarketEvent): void;
  onUnparsed(u: Unparsed): void;
  onStatus(status: SocketStatus, detail: string): void;
}

export interface VenueOptions {
  WebSocketImpl?: new (url: string) => MinimalWebSocket;
  fetchImpl?: typeof fetch;
  wsUrl?: string;
  restUrl?: string;
}

/** A REST candle row, venue-neutral: open time (epoch ms) and exact decimal fields. */
export interface RestCandle {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** Binance only. */
  quoteVolume?: string;
  tradeCount?: number;
  takerBuyVolume?: string;
}

export interface PairStatus {
  symbol: string;
  status: 'trading' | 'halted' | 'delisted';
  priceTick: string;
  qtyStep: string;
}

const dispatch = (hooks: VenueHooks, result: MarketEvent | Unparsed | null) => {
  if (!result) return;
  if (result.type === 'unparsed') hooks.onUnparsed(result);
  else hooks.onEvent(result);
};

// ---------------------------------------------------------------- Binance (feasibility §3.1)

const BINANCE_CHANNELS = ['aggTrade', 'kline_1m', 'depth@100ms', 'ticker'];

export class BinanceVenue {
  readonly rest: RestClient;
  private symbols: string[] = [];
  private readonly socket: ReconnectingSocket;

  constructor(
    private readonly hooks: VenueHooks,
    opts: VenueOptions = {},
  ) {
    const wsUrl = opts.wsUrl ?? 'wss://data-stream.binance.vision';
    // Half of Binance's 6,000 weight per minute, so backfills never put the IP at risk.
    this.rest = new RestClient({
      baseUrl: opts.restUrl ?? 'https://data-api.binance.vision',
      budget: new RestBudget(3_000, 50),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.socket = new ReconnectingSocket(
      () =>
        `${wsUrl}/stream?streams=${this.symbols.flatMap((s) => BINANCE_CHANNELS.map((c) => `${s.toLowerCase()}@${c}`)).join('/')}`,
      {
        onOpen: () => undefined, // combined-stream URL carries the subscription
        onMessage: (data, receivedAt) =>
          dispatch(this.hooks, parseBinanceMessage(JSON.parse(data), receivedAt)),
        onStatus: (status, detail) => this.hooks.onStatus(status, detail),
      },
      {
        idleTimeoutMs: 30_000,
        maxLifetimeMs: 23 * 3_600_000 + 50 * 60_000,
        ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
      },
    );
  }

  /**
   * Sets the streamed symbols (instruments added or disabled live). On an open connection the change
   * is a SUBSCRIBE/UNSUBSCRIBE request, so the other symbols' streams are not interrupted; the
   * combined-stream URL carries the full set for the next connection.
   */
  setSymbols(symbols: string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.join() === this.symbols.join()) return;
    const previous = this.symbols;
    this.symbols = next;
    if (next.length === 0) {
      this.socket.stop();
      return;
    }
    if (previous.length === 0) {
      this.socket.start();
      return;
    }
    const streams = (list: string[]) =>
      list.flatMap((s) => BINANCE_CHANNELS.map((c) => `${s.toLowerCase()}@${c}`));
    const added = streams(next.filter((s) => !previous.includes(s)));
    const removed = streams(previous.filter((s) => !next.includes(s)));
    const sent =
      (removed.length === 0 ||
        this.socket.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: removed, id: ++this.requestId }))) &&
      (added.length === 0 ||
        this.socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: added, id: ++this.requestId })));
    if (!sent) this.socket.restart('subscription changed');
  }

  private requestId = 0;

  stop(): void {
    this.symbols = [];
    this.socket.stop();
  }

  /**
   * The best `limit` levels per side (weight 250 at 5,000). 1,000 levels cover only about ±0.3% of a
   * BTCUSDT book; 5,000 reach past ±1%, the widest depth band (measured 2026-11-10).
   */
  async depthSnapshot(symbol: string, limit = 5_000): Promise<BookSnapshotEvent> {
    const weight = limit <= 100 ? 5 : limit <= 500 ? 25 : limit <= 1_000 ? 50 : 250;
    const body = await this.rest.get<unknown>(`/api/v3/depth?symbol=${symbol}&limit=${limit}`, weight);
    const parsed = parseBinanceDepthSnapshot(symbol, body, Date.now());
    if (!parsed || parsed.type !== 'book_snapshot')
      throw new Error(`unexpected depth snapshot for ${symbol}`);
    return parsed;
  }

  /** Klines from `startTime` (inclusive), up to 1,000 per call (weight 2). */
  async klines(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    limit = 1_000,
  ): Promise<RestCandle[]> {
    const rows = await this.rest.get<unknown[][]>(
      `/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`,
      2,
    );
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: normalizeDecimal(String(r[1])),
      high: normalizeDecimal(String(r[2])),
      low: normalizeDecimal(String(r[3])),
      close: normalizeDecimal(String(r[4])),
      volume: normalizeDecimal(String(r[5])),
      quoteVolume: normalizeDecimal(String(r[7])),
      tradeCount: Number(r[8]),
      takerBuyVolume: normalizeDecimal(String(r[9])),
    }));
  }

  /**
   * The local clock's offset from Binance server time (server − local), taking the sample with the
   * shortest round trip; its uncertainty is half that round trip (architecture §5.4 clock drift).
   */
  async clockOffset(samples = 3): Promise<{ offsetMs: number; rttMs: number }> {
    let best: { offsetMs: number; rttMs: number } | null = null;
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const { serverTime } = await this.rest.get<{ serverTime: number }>('/api/v3/time', 1);
      const t1 = Date.now();
      const sample = { offsetMs: Math.round(serverTime - (t0 + t1) / 2), rttMs: t1 - t0 };
      if (!best || sample.rttMs < best.rttMs) best = sample;
    }
    return best!;
  }

  async pairStatus(symbols: string[]): Promise<PairStatus[]> {
    const body = await this.rest.get<{
      symbols: {
        symbol: string;
        status: string;
        filters: { filterType: string; tickSize?: string; stepSize?: string }[];
      }[];
    }>(`/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`, 20);
    return body.symbols.map((s) => ({
      symbol: s.symbol,
      status:
        s.status === 'TRADING'
          ? 'trading'
          : s.status === 'BREAK' || s.status === 'HALT'
            ? 'halted'
            : 'delisted',
      priceTick: normalizeDecimal(s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? '0'),
      qtyStep: normalizeDecimal(s.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? '0'),
    }));
  }
}

// ---------------------------------------------------------------- Coinbase (feasibility §3.2)

const COINBASE_CHANNELS = ['matches', 'heartbeat', 'ticker', 'level2_batch'];

export class CoinbaseVenue {
  readonly rest: RestClient;
  private products: string[] = [];
  private readonly socket: ReconnectingSocket;

  constructor(
    private readonly hooks: VenueHooks,
    opts: VenueOptions = {},
  ) {
    const wsUrl = opts.wsUrl ?? 'wss://ws-feed.exchange.coinbase.com';
    // Coinbase allows 10 public requests per second; we use half.
    this.rest = new RestClient({
      baseUrl: opts.restUrl ?? 'https://api.exchange.coinbase.com',
      budget: new RestBudget(5, 5),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.socket = new ReconnectingSocket(
      () => wsUrl,
      {
        onOpen: (send) =>
          send(
            JSON.stringify({ type: 'subscribe', product_ids: this.products, channels: COINBASE_CHANNELS }),
          ),
        onMessage: (data, receivedAt) =>
          dispatch(this.hooks, parseCoinbaseMessage(JSON.parse(data), receivedAt)),
        onStatus: (status, detail) => this.hooks.onStatus(status, detail),
      },
      { idleTimeoutMs: 15_000, ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}) },
    );
  }

  /**
   * Sets the streamed products. On an open connection the change is a subscribe/unsubscribe message
   * (the venue sends a book snapshot for each new product), so the others are not interrupted.
   */
  setProducts(products: string[]): void {
    const next = [...new Set(products)].sort();
    if (next.join() === this.products.join()) return;
    const previous = this.products;
    this.products = next;
    if (next.length === 0) {
      this.socket.stop();
      return;
    }
    if (previous.length === 0) {
      this.socket.start();
      return;
    }
    const added = next.filter((p) => !previous.includes(p));
    const removed = previous.filter((p) => !next.includes(p));
    const message = (type: string, ids: string[]) =>
      JSON.stringify({ type, product_ids: ids, channels: COINBASE_CHANNELS });
    const sent =
      (removed.length === 0 || this.socket.send(message('unsubscribe', removed))) &&
      (added.length === 0 || this.socket.send(message('subscribe', added)));
    if (!sent) this.socket.restart('subscription changed');
  }

  stop(): void {
    this.products = [];
    this.socket.stop();
  }

  /** Candles in [start, end), granularity in seconds (60, 300, 900, 3600, 21600 or 86400), max 300. */
  async candles(product: string, granularity: number, start: number, end: number): Promise<RestCandle[]> {
    const rows = await this.rest.get<number[][]>(
      `/products/${product}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end - 1).toISOString()}`,
    );
    // Rows are [time (s), low, high, open, close, volume], newest first; minutes without trades are omitted.
    return rows
      .map((r) => ({
        openTime: Number(r[0]) * 1000,
        low: normalizeDecimal(String(r[1])),
        high: normalizeDecimal(String(r[2])),
        open: normalizeDecimal(String(r[3])),
        close: normalizeDecimal(String(r[4])),
        volume: normalizeDecimal(String(r[5])),
      }))
      .filter((c) => c.openTime >= start && c.openTime < end)
      .sort((a, b) => a.openTime - b.openTime);
  }

  async pairStatus(product: string): Promise<PairStatus> {
    const p = await this.rest.get<{
      id: string;
      status: string;
      trading_disabled: boolean;
      cancel_only: boolean;
      quote_increment: string;
      base_increment: string;
    }>(`/products/${product}`);
    return {
      symbol: p.id,
      status:
        p.status === 'delisted'
          ? 'delisted'
          : p.status !== 'online' || p.trading_disabled || p.cancel_only
            ? 'halted'
            : 'trading',
      priceTick: normalizeDecimal(p.quote_increment),
      qtyStep: normalizeDecimal(p.base_increment),
    };
  }
}
