import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRACTICE_SETTINGS,
  PlacePracticeOrderRequestSchema,
  PRACTICE_EVENTS_STREAM,
  PracticeSettingsSchema,
  tradesStream,
} from './practice.js';
import { PRACTICE_COMMANDS_STREAM } from './practice-commands.js';

const INSTRUMENT = '019a6f00-0000-7000-8000-000000000001';

describe('practice trading contracts (Phase 14)', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    clientOrderId: 'client-order-1',
    instrumentId: INSTRUMENT,
    side: 'buy',
    type: 'market',
    quantity: '0.01',
    ...over,
  });

  it('accept market and limit orders, a buy with its stop and target', () => {
    for (const o of [
      order(),
      order({ type: 'limit', limitPrice: '65000.5' }),
      order({ side: 'sell', type: 'limit', limitPrice: '70000' }),
      order({ stop: '60000', target: '75000', setupId: INSTRUMENT }),
    ])
      expect(PlacePracticeOrderRequestSchema.safeParse(o).success).toBe(true);
  });

  it('refuse what does not make a practice order', () => {
    for (const o of [
      order({ type: 'limit' }), // no limit price
      order({ limitPrice: '65000' }), // a market order with a price
      order({ side: 'sell', stop: '60000' }), // only a buy carries a stop or target
      order({ quantity: '0' }),
      order({ quantity: '-1' }),
      order({ quantity: '1e3' }),
      order({ clientOrderId: 'short' }),
      order({ type: 'stop' }), // stops come only with a buy
      order({ leverage: 2 }), // spot only
    ])
      expect(PlacePracticeOrderRequestSchema.safeParse(o).success).toBe(false);
  });

  it('name its streams, and ship valid default settings', () => {
    expect(PRACTICE_COMMANDS_STREAM).toBe('practice:commands');
    expect(PRACTICE_EVENTS_STREAM).toBe('practice:events');
    expect(tradesStream(INSTRUMENT)).toBe(`md:trades:${INSTRUMENT}`);
    expect(PracticeSettingsSchema.parse(DEFAULT_PRACTICE_SETTINGS)).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(DEFAULT_PRACTICE_SETTINGS.startingBalances.binance).toEqual({ USDT: '10000' });
    expect(DEFAULT_PRACTICE_SETTINGS.startingBalances.coinbase).toEqual({ USD: '10000' });
  });
});
