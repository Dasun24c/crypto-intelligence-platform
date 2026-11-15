import { describe, expect, it } from 'vitest';
import {
  AUTO_SKIP_REASONS,
  AUTO_SKIP_TEXT,
  AutoDecisionSchema,
  AutoRulesSchema,
  AutoSwitchOnRequestSchema,
  DEFAULT_AUTO_RULES,
  DEFAULT_PRACTICE_SETTINGS,
  PlacePracticeOrderRequestSchema,
  PRACTICE_EVENTS_STREAM,
  PracticeAutomaticMessageSchema,
  PracticeSettingsSchema,
  tradesStream,
  UpdateAutoRulesRequestSchema,
} from './practice.js';
import { PATTERN_NAMES } from './smc-params.js';
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
      order({ clientOrderId: 'auto:019a6f00-0000-7000-8000-000000000001' }), // kept for automatic orders
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

describe('automatic practice trading contracts (Phase 16)', () => {
  const rules = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_AUTO_RULES, ...over });

  it('ship the recommended defaults, every pattern, and a text for every skip reason', () => {
    expect(AutoRulesSchema.parse(DEFAULT_AUTO_RULES)).toEqual(DEFAULT_AUTO_RULES);
    expect(DEFAULT_AUTO_RULES).toMatchObject({ minScore: 70, minReward: 2, riskPct: 1, dailyLossPct: 3 });
    expect(DEFAULT_AUTO_RULES.patterns).toEqual([...PATTERN_NAMES]);
    expect(Object.keys(AUTO_SKIP_TEXT).sort()).toEqual([...AUTO_SKIP_REASONS].sort());
  });

  it('keep the rules inside their limits', () => {
    for (const r of [
      rules({ riskPct: 0.1 }),
      rules({ riskPct: 2 }),
      rules({ maxOpenTrades: 10, maxOrdersPerDay: 50, dailyLossPct: 10, minReward: 10, minScore: 0 }),
      rules({ instrumentIds: [INSTRUMENT], patterns: ['htf_order_block'] }),
    ])
      expect(AutoRulesSchema.safeParse(r).success).toBe(true);
    for (const r of [
      rules({ riskPct: 2.5 }), // at most 2 % a trade
      rules({ riskPct: 0 }),
      rules({ patterns: [] }),
      rules({ patterns: ['guess'] }),
      rules({ minScore: 101 }),
      rules({ minReward: 0.4 }),
      rules({ maxOpenTrades: 0 }),
      rules({ maxOpenTrades: 1.5 }),
      rules({ maxOrdersPerDay: 51 }),
      rules({ dailyLossPct: 11 }),
      rules({ venue: 'kraken' }),
      rules({ instrumentIds: ['not-a-uuid'] }),
      rules({ leverage: 2 }), // spot only, and nothing unknown
    ])
      expect(AutoRulesSchema.safeParse(r).success).toBe(false);
    expect(UpdateAutoRulesRequestSchema.safeParse({ version: 3, rules: rules() }).success).toBe(true);
    expect(UpdateAutoRulesRequestSchema.safeParse({ rules: rules() }).success).toBe(false);
    expect(AutoSwitchOnRequestSchema.safeParse({ version: 0 }).success).toBe(true);
    expect(AutoSwitchOnRequestSchema.safeParse({}).success).toBe(false);
  });

  it('describe decisions, pauses and stops on the practice channel', () => {
    const decision = {
      id: INSTRUMENT,
      setupId: INSTRUMENT,
      instrumentId: INSTRUMENT,
      pattern: 'htf_order_block',
      outcome: 'skipped',
      reason: 'score',
      orderId: null,
      order: null,
      strategyVersion: 2,
      decidedAt: 1_763_190_000_000,
    };
    for (const m of [
      { event: 'decision', decision },
      { event: 'paused', at: 1_763_200_000_000, until: 1_763_251_200_000, result: '-310.5', asset: 'USDT' },
      { event: 'stopped', cancelled: 2 },
    ])
      expect(PracticeAutomaticMessageSchema.safeParse(m).success).toBe(true);
    expect(AutoDecisionSchema.safeParse({ ...decision, outcome: 'maybe' }).success).toBe(false);
    const placed = {
      ...decision,
      outcome: 'placed',
      reason: null,
      orderId: INSTRUMENT,
      order: { quantity: '0.5', limitPrice: '99', stop: '97', target: '105' },
    };
    expect(AutoDecisionSchema.safeParse(placed).success).toBe(true);
    expect(PracticeAutomaticMessageSchema.safeParse({ event: 'other' }).success).toBe(false);
  });
});
