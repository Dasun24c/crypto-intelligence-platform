import { normalizeDecimal } from '@cip/domain';
import type { Level, ParseResult } from '../events.js';

/**
 * Binance spot public streams (feasibility §3.1), from the combined-stream wrapper
 * `{"stream": "btcusdt@aggTrade", "data": {...}}` or a raw event. Control replies
 * (`{"result": null, "id": 1}`) return null.
 */
type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
};
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('expected number');
  return v;
};
const levels = (v: unknown): Level[] => {
  if (!Array.isArray(v)) throw new Error('expected levels');
  return v.map((l: unknown) => {
    if (!Array.isArray(l) || l.length < 2) throw new Error('expected [price, qty]');
    return [normalizeDecimal(str(l[0])), normalizeDecimal(str(l[1]))];
  });
};

export function parseBinanceMessage(message: unknown, receivedAt: number): ParseResult {
  const data = isObj(message) && isObj(message['data']) ? message['data'] : message;
  if (!isObj(data)) return { type: 'unparsed', venue: 'binance', reason: 'not an object', raw: message };
  if ('result' in data && 'id' in data) return null;
  try {
    switch (data['e']) {
      case 'aggTrade':
        return {
          type: 'trade',
          venue: 'binance',
          symbol: str(data['s']),
          ts: num(data['T']),
          receivedAt,
          tradeId: String(num(data['a'])),
          seq: num(data['a']),
          price: normalizeDecimal(str(data['p'])),
          qty: normalizeDecimal(str(data['q'])),
          // `m`: the buyer is the maker, so the taker sold.
          takerSide: data['m'] === true ? 'sell' : 'buy',
          takerOrderRef: null,
          fills: { first: num(data['f']), last: num(data['l']) },
        };
      case 'kline': {
        const k = data['k'];
        if (!isObj(k)) throw new Error('kline without k');
        if (k['i'] !== '1m')
          return {
            type: 'unparsed',
            venue: 'binance',
            reason: `kline interval ${String(k['i'])}`,
            raw: message,
          };
        return {
          type: 'kline',
          venue: 'binance',
          symbol: str(data['s']),
          ts: num(data['E']),
          receivedAt,
          interval: '1m',
          openTime: num(k['t']),
          open: normalizeDecimal(str(k['o'])),
          high: normalizeDecimal(str(k['h'])),
          low: normalizeDecimal(str(k['l'])),
          close: normalizeDecimal(str(k['c'])),
          volume: normalizeDecimal(str(k['v'])),
          quoteVolume: normalizeDecimal(str(k['q'])),
          tradeCount: num(k['n']),
          takerBuyVolume: normalizeDecimal(str(k['V'])),
          final: k['x'] === true,
        };
      }
      case 'depthUpdate':
        return {
          type: 'book_delta',
          venue: 'binance',
          symbol: str(data['s']),
          ts: num(data['E']),
          receivedAt,
          firstUpdateId: num(data['U']),
          lastUpdateId: num(data['u']),
          bids: levels(data['b']),
          asks: levels(data['a']),
        };
      case '24hrTicker':
        return {
          type: 'ticker',
          venue: 'binance',
          symbol: str(data['s']),
          ts: num(data['E']),
          receivedAt,
          last: normalizeDecimal(str(data['c'])),
          bid: normalizeDecimal(str(data['b'])),
          ask: normalizeDecimal(str(data['a'])),
          open24h: normalizeDecimal(str(data['o'])),
          change24hPct: Number(str(data['P'])),
          volume24hBase: normalizeDecimal(str(data['v'])),
          volume24hQuote: normalizeDecimal(str(data['q'])),
        };
      default:
        return { type: 'unparsed', venue: 'binance', reason: `event ${String(data['e'])}`, raw: message };
    }
  } catch (err) {
    return {
      type: 'unparsed',
      venue: 'binance',
      reason: err instanceof Error ? err.message : 'invalid',
      raw: message,
    };
  }
}

/** REST `GET /api/v3/depth`: the snapshot the diff stream is synchronised against. */
export function parseBinanceDepthSnapshot(symbol: string, body: unknown, receivedAt: number): ParseResult {
  if (!isObj(body)) return { type: 'unparsed', venue: 'binance', reason: 'depth body', raw: body };
  try {
    return {
      type: 'book_snapshot',
      venue: 'binance',
      symbol,
      ts: receivedAt,
      receivedAt,
      lastUpdateId: num(body['lastUpdateId']),
      bids: levels(body['bids']),
      asks: levels(body['asks']),
    };
  } catch (err) {
    return {
      type: 'unparsed',
      venue: 'binance',
      reason: err instanceof Error ? err.message : 'invalid',
      raw: body,
    };
  }
}
