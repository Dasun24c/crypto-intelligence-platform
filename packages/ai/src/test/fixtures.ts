import type { AiContext, AiResponse } from '@cip/contracts';

/** A Binance BTC/USDT context as the context builder makes it. */
export function btcContext(over: Partial<AiContext> = {}): AiContext {
  return {
    contextVersion: '1',
    asOf: Date.UTC(2026, 10, 16, 10, 0),
    instrument: {
      id: 'instr',
      displayName: 'BTC · Binance BTC/USDT',
      assetClass: 'crypto',
      venue: 'binance',
    },
    market: { id: 'mkt', last: '65432.10', change24hPct: -1.84, volume24hUsd: 1834500000, spreadBps: 0.3 },
    indicators: [
      { id: 'ind:1h:rsi', tf: '1h', name: 'rsi', value: 38.6 },
      { id: 'ind:1h:atr', tf: '1h', name: 'atr', value: 412.75 },
      { id: 'ind:4h:rsi', tf: '4h', name: 'rsi', value: 44.2 },
      { id: 'ind:1h:volume_z', tf: '1h', name: 'volume_z', value: 3.4 },
    ],
    structure: [
      {
        id: 'str:4h',
        tf: '4h',
        trend: 'bearish',
        lastEvent: { type: 'choch', direction: 'bearish', price: '64980.00', at: Date.UTC(2026, 10, 16, 4) },
      },
      {
        id: 'str:1h',
        tf: '1h',
        trend: 'bullish',
        lastEvent: { type: 'mss', direction: 'bullish', price: '65210.50', at: Date.UTC(2026, 10, 16, 9) },
      },
    ],
    levels: [
      { id: 'lvl:3f2a9c1e', tf: '1h', type: 'pdl', price: '64150.00', distanceAtr: 3.1, status: 'swept' },
      { id: 'lvl:8b7d6e5f', tf: '4h', type: 'pdh', price: '66820.40', distanceAtr: 3.4, status: 'active' },
    ],
    zones: [
      {
        id: 'zone:1a2b3c4d',
        tf: '1h',
        type: 'order_block',
        direction: 'bullish',
        top: '64890.00',
        bottom: '64512.30',
        status: 'active',
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
        checklist: [
          { item: 'htf_bias', credit: 0.5 },
          { item: 'sweep', credit: 1 },
          { item: 'mss', credit: 1 },
        ],
        flags: [],
      },
    ],
    recentEvents: [
      {
        id: 'evt:9c8b7a6d',
        at: Date.UTC(2026, 10, 16, 8, 45),
        type: 'sweep',
        summary: 'Sweep of the previous day low',
      },
      { id: 'evt:1f2e3d4c', at: Date.UTC(2026, 10, 16, 9), type: 'structure', summary: 'Bullish MSS on 1h' },
    ],
    calendar: [{ id: 'cal:7e6d5c4b', at: Date.UTC(2026, 10, 16, 13, 30), title: 'US CPI', impact: 'high' }],
    dataQuality: [],
    ...over,
  };
}

/** PAXG while the gold market is closed. */
export function paxgClosedContext(): AiContext {
  return btcContext({
    instrument: {
      id: 'instr',
      displayName: 'PAXG · Binance PAXG/USDT (gold-backed token)',
      assetClass: 'tokenised_gold',
      venue: 'binance',
    },
    market: { id: 'mkt', last: '4101.50', change24hPct: 0.42, volume24hUsd: 12850000, spreadBps: 2.4 },
    goldMarket: {
      id: 'gold',
      status: 'closed',
      nextChangeAt: Date.UTC(2026, 10, 16, 23),
      crossVenueSpreadBps: 12,
    },
    levels: [
      { id: 'lvl:aa11bb22', tf: '1h', type: 'pdh', price: '4120.80', distanceAtr: 2.2, status: 'active' },
    ],
    zones: [],
    setups: [],
  });
}

/** A valid answer for `btcContext()`. */
export function goodResponse(): AiResponse {
  return {
    stance: 'bullish',
    confidence: 'medium',
    headline: 'BTC/USDT: a bullish 1h shift after the previous day low was swept',
    summary:
      'Price swept the previous day low at 64150.00 and then shifted structure up on 1h at 65210.50. A confirmed setup waits at the order block between 64512.30 and 64890.00, while the 4h trend is still bearish.',
    observations: [
      {
        text: 'The previous day low at 64150.00 was swept before the 1h shift.',
        refs: ['lvl:3f2a9c1e', 'evt:9c8b7a6d'],
      },
      { text: 'A bullish market structure shift on 1h broke 65210.50.', refs: ['str:1h'] },
      {
        text: 'The confirmed setup enters at 64890.00 with its first target at 66820.40.',
        refs: ['setup:5e6f7a8b'],
      },
    ],
    supportingIndicators: [
      { ref: 'ind:1h:rsi', reading: 'RSI on 1h is 38.6: momentum has room either way.' },
      { ref: 'ind:1h:volume_z', reading: 'Volume on 1h is unusually high.' },
    ],
    risks: [
      { text: 'The 4h trend is bearish after a change of character at 64980.00.', refs: ['str:4h'] },
      { text: 'US CPI is due within hours and can move the market sharply.', refs: ['cal:7e6d5c4b'] },
    ],
    invalidation: {
      text: 'A close below the order block at 64512.30 would invalidate the setup.',
      refs: ['zone:1a2b3c4d'],
    },
    competingScenario: {
      text: 'The sweep of the previous day low may be a genuine breakdown that continues the 4h trend.',
      refs: ['lvl:3f2a9c1e', 'str:4h'],
    },
    dataQualityNotes: [],
  };
}
