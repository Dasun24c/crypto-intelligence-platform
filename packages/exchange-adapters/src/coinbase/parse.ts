import { normalizeDecimal, toNumber } from '@cip/domain';
import type { Level, ParseResult } from '../events.js';

/**
 * Coinbase Exchange public feed (feasibility §3.2): `matches`, `ticker`, `heartbeat` and
 * `level2_batch` (answered as `level2_50`). Subscription acknowledgements return null.
 */
type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
};
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('expected integer');
  return v;
};
const time = (v: unknown): number => {
  const ms = Date.parse(str(v));
  if (Number.isNaN(ms)) throw new Error('bad time');
  return ms;
};
const levels = (v: unknown): Level[] => {
  if (!Array.isArray(v)) throw new Error('expected levels');
  return v.map((l: unknown) => {
    if (!Array.isArray(l) || l.length < 2) throw new Error('expected [price, size]');
    return [normalizeDecimal(str(l[0])), normalizeDecimal(str(l[1]))];
  });
};

export function parseCoinbaseMessage(message: unknown, receivedAt: number): ParseResult {
  if (!isObj(message)) return { type: 'unparsed', venue: 'coinbase', reason: 'not an object', raw: message };
  try {
    switch (message['type']) {
      case 'subscriptions':
        return null;
      case 'match':
      case 'last_match': {
        const tradeId = int(message['trade_id']);
        return {
          type: 'trade',
          venue: 'coinbase',
          symbol: str(message['product_id']),
          ts: time(message['time']),
          receivedAt,
          tradeId: String(tradeId),
          seq: tradeId,
          price: normalizeDecimal(str(message['price'])),
          qty: normalizeDecimal(str(message['size'])),
          // `side` is the maker's side: a resting buy order filled means the taker sold.
          takerSide: message['side'] === 'buy' ? 'sell' : 'buy',
          takerOrderRef: typeof message['taker_order_id'] === 'string' ? message['taker_order_id'] : null,
        };
      }
      case 'ticker': {
        const last = normalizeDecimal(str(message['price']));
        const open = normalizeDecimal(str(message['open_24h']));
        const volume = normalizeDecimal(str(message['volume_24h']));
        const openNum = toNumber(open);
        return {
          type: 'ticker',
          venue: 'coinbase',
          symbol: str(message['product_id']),
          ts: time(message['time']),
          receivedAt,
          last,
          bid: normalizeDecimal(str(message['best_bid'])),
          ask: normalizeDecimal(str(message['best_ask'])),
          open24h: open,
          change24hPct: openNum === 0 ? 0 : ((toNumber(last) - openNum) / openNum) * 100,
          volume24hBase: volume,
          volume24hQuote: normalizeDecimal((toNumber(volume) * toNumber(last)).toFixed(2)),
        };
      }
      case 'heartbeat':
        return {
          type: 'heartbeat',
          venue: 'coinbase',
          symbol: str(message['product_id']),
          ts: time(message['time']),
          receivedAt,
          lastTradeId: int(message['last_trade_id']),
        };
      case 'snapshot':
        return {
          type: 'book_snapshot',
          venue: 'coinbase',
          symbol: str(message['product_id']),
          ts: receivedAt,
          receivedAt,
          bids: levels(message['bids']),
          asks: levels(message['asks']),
        };
      case 'l2update': {
        const changes = message['changes'];
        if (!Array.isArray(changes)) throw new Error('changes');
        const bids: Level[] = [];
        const asks: Level[] = [];
        for (const c of changes) {
          if (!Array.isArray(c) || c.length < 3) throw new Error('change');
          const level: Level = [normalizeDecimal(str(c[1])), normalizeDecimal(str(c[2]))];
          if (c[0] === 'buy') bids.push(level);
          else if (c[0] === 'sell') asks.push(level);
          else throw new Error('change side');
        }
        return {
          type: 'book_delta',
          venue: 'coinbase',
          symbol: str(message['product_id']),
          ts: time(message['time']),
          receivedAt,
          bids,
          asks,
        };
      }
      case 'error':
        return {
          type: 'unparsed',
          venue: 'coinbase',
          reason: `venue error: ${String(message['message'])}`,
          raw: message,
        };
      default:
        return {
          type: 'unparsed',
          venue: 'coinbase',
          reason: `type ${String(message['type'])}`,
          raw: message,
        };
    }
  } catch (err) {
    return {
      type: 'unparsed',
      venue: 'coinbase',
      reason: err instanceof Error ? err.message : 'invalid',
      raw: message,
    };
  }
}
