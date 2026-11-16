import { describe, expect, it } from 'vitest';
import type { AiContext } from '@cip/contracts';
import { answerView, describeRef, failureText, formatTokens, formatUsd, triggerLabel } from './ai.js';

const CTX: AiContext = {
  contextVersion: '1',
  asOf: Date.UTC(2026, 10, 20, 10),
  instrument: { id: 'instr', displayName: 'BTC · Binance BTC/USDT', assetClass: 'crypto', venue: 'binance' },
  market: { id: 'mkt', last: '65432.10', change24hPct: -1.84, volume24hUsd: 1_834_500_000, spreadBps: 0.03 },
  goldMarket: { id: 'gold', status: 'closed', nextChangeAt: null, crossVenueSpreadBps: null },
  indicators: [{ id: 'ind:1h:rsi', tf: '1h', name: 'rsi', value: 38.6 }],
  structure: [
    {
      id: 'str:1h',
      tf: '1h',
      trend: 'bullish',
      lastEvent: { type: 'mss', direction: 'bullish', price: '65210.50', at: 0 },
    },
    { id: 'str:4h', tf: '4h', trend: 'undefined', lastEvent: null },
  ],
  levels: [
    { id: 'lvl:3f2a9c1e', tf: '1h', type: 'pdl', price: '64150.00', distanceAtr: 3.2, status: 'swept' },
  ],
  zones: [
    {
      id: 'zone:1a2b3c4d',
      tf: '1h',
      type: 'order_block',
      direction: 'bullish',
      top: '64890.00',
      bottom: '64512.30',
      status: 'untouched',
      fillPct: 0,
    },
  ],
  setups: [
    {
      id: 'setup:5e6f7a8b',
      pattern: 'htf_order_block',
      direction: 'bullish',
      state: 'confirmed',
      entry: '64890.00',
      invalidation: '64512.30',
      target1: '66820.40',
      rr: 5.11,
      score: 82.5,
      checklist: [],
      flags: [],
    },
  ],
  recentEvents: [{ id: 'evt:9c8b7a6d', at: 0, type: 'sweep', summary: 'Sweep of the pdl at 64150.00 on 1h' }],
  calendar: [{ id: 'cal:7e6d5c4b', at: 0, title: 'US CPI', impact: 'high' }],
  dataQuality: [{ id: 'dq:ticker', code: 'no_ticker', detail: 'No live ticker.' }],
};

describe('AI analysis helpers', () => {
  it('says what each cited id points at in the context that was sent', () => {
    expect(describeRef(CTX, 'instr')).toBe('BTC · Binance BTC/USDT');
    expect(describeRef(CTX, 'mkt')).toBe('The market: last 65432.10, -1.84 % in 24 h');
    expect(describeRef({ ...CTX, market: { ...CTX.market, last: null } }, 'mkt')).toBe(
      'The market (no live price)',
    );
    expect(describeRef(CTX, 'gold')).toBe('The gold market: closed');
    expect(describeRef(CTX, 'ind:1h:rsi')).toBe('RSI (1h): 38.6');
    expect(describeRef(CTX, 'str:1h')).toBe('Structure (1h): bullish, last bullish MSS at 65210.50');
    expect(describeRef(CTX, 'str:4h')).toBe('Structure (4h): undefined');
    expect(describeRef(CTX, 'lvl:3f2a9c1e')).toBe('Previous day low at 64150.00 (1h, swept)');
    expect(describeRef(CTX, 'zone:1a2b3c4d')).toBe('Bullish order block 64512.30–64890.00 (1h)');
    expect(describeRef(CTX, 'setup:5e6f7a8b')).toBe('Higher-timeframe order block, bullish, confirmed');
    expect(describeRef(CTX, 'evt:9c8b7a6d')).toBe('Sweep of the pdl at 64150.00 on 1h');
    expect(describeRef(CTX, 'cal:7e6d5c4b')).toBe('US CPI (high impact)');
    expect(describeRef(CTX, 'dq:ticker')).toBe('No live ticker.');
    expect(describeRef(CTX, 'lvl:deadbeef')).toBeNull();
  });

  it('puts failures, money, tokens and triggers into words', () => {
    expect(failureText('no_key')).toBe('No Grok API key was configured.');
    expect(failureText('daily_cap')).toBe('The call could have passed the daily cap.');
    expect(failureText('repair failed: timeout')).toMatch(
      /^The repair attempt failed: grok did not answer in time/,
    );
    expect(failureText('no repair: monthly_cap')).toBe(
      'No repair attempt: the call could have passed the monthly cap.',
    );
    expect(failureText('something_new')).toBe('something_new');
    expect(failureText(null)).toBe('');
    expect(formatUsd('0.0095')).toBe('$0.0095');
    expect(formatUsd('12.5')).toBe('$12.50');
    expect(formatUsd('0')).toBe('$0');
    expect(formatUsd(null)).toBe('—');
    expect(formatTokens(12_000)).toBe('12,000');
    expect(formatTokens(null)).toBe('—');
    expect(triggerLabel({ trigger: 'event', reason: null })).toBe('Significant events');
    expect(triggerLabel({ trigger: 'digest', reason: null })).toBe('4-hourly digest');
    expect(triggerLabel({ trigger: 'on_demand', reason: 'setup_review' })).toBe('On request: setup review');
  });

  it('reads a stored answer defensively', () => {
    expect(answerView(null)).toBeNull();
    expect(answerView({ raw: 'not json' })).toBeNull();
    const view = answerView({
      headline: 'H',
      summary: 'S',
      stance: 'neutral',
      confidence: 'low',
      observations: [{ text: 'o', refs: ['mkt', 3] }, { nope: true }],
      supportingIndicators: [{ ref: 'ind:1h:rsi', reading: 'r' }, { ref: 5 }],
      risks: 'not a list',
      invalidation: { text: 'i', refs: ['instr'] },
      competingScenario: null,
      dataQualityNotes: ['n', 7],
    });
    expect(view).toEqual({
      headline: 'H',
      summary: 'S',
      stance: 'neutral',
      confidence: 'low',
      observations: [{ text: 'o', refs: ['mkt'] }],
      supportingIndicators: [{ ref: 'ind:1h:rsi', reading: 'r' }],
      risks: [],
      invalidation: { text: 'i', refs: ['instr'] },
      competingScenario: null,
      dataQualityNotes: ['n'],
    });
  });
});
