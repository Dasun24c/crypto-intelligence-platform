import { describe, expect, it } from 'vitest';
import type { AiResponse } from '@cip/contracts';
import { btcContext, goodResponse, paxgClosedContext } from './test/fixtures.js';
import { contextNumbers, significantDigits, statedNumbers } from './numbers.js';
import { contextIds, validateResponse } from './validate.js';

type Mutate = (r: AiResponse) => unknown;
const edit =
  (f: (r: AiResponse) => void): Mutate =>
  (r) => {
    f(r);
    return r;
  };

/**
 * Criterion 9.2: crafted bad answers, each rejected by the rule it breaks. Every one starts from the
 * valid answer and breaks one thing.
 */
const BAD: [string, 'V1' | 'V2' | 'V3' | 'V4' | 'V5', Mutate][] = [
  // V1: the schema.
  ['not an object', 'V1', () => 'just text'],
  ['an array', 'V1', () => [goodResponse()]],
  ['a missing stance', 'V1', edit((r) => delete (r as Partial<AiResponse>).stance)],
  ['an unknown stance', 'V1', edit((r) => Object.assign(r, { stance: 'very bullish' }))],
  ['an unknown confidence', 'V1', edit((r) => Object.assign(r, { confidence: 'certain' }))],
  ['an extra field', 'V1', edit((r) => Object.assign(r, { priceTarget: '70000' }))],
  ['a headline over 120 characters', 'V1', edit((r) => (r.headline = 'x'.repeat(121)))],
  ['an empty summary', 'V1', edit((r) => (r.summary = ''))],
  ['no observations', 'V1', edit((r) => (r.observations = []))],
  [
    'seven observations',
    'V1',
    edit((r) => (r.observations = Array.from({ length: 7 }, () => r.observations[0]!))),
  ],
  ['an observation without refs', 'V1', edit((r) => (r.observations[0]!.refs = []))],
  ['an observation over 300 characters', 'V1', edit((r) => (r.observations[0]!.text = 'y'.repeat(301)))],
  ['six risks', 'V1', edit((r) => (r.risks = Array.from({ length: 6 }, () => r.risks[0]!)))],
  [
    'seven supporting indicators',
    'V1',
    edit((r) => (r.supportingIndicators = Array.from({ length: 7 }, () => r.supportingIndicators[0]!))),
  ],
  ['five data-quality notes', 'V1', edit((r) => (r.dataQualityNotes = ['a', 'b', 'c', 'd', 'e']))],
  ['refs that are not a list', 'V1', edit((r) => Object.assign(r.invalidation, { refs: 'zone:1a2b3c4d' }))],
  // V2: every cited id exists.
  ['an unknown level id', 'V2', edit((r) => (r.observations[0]!.refs = ['lvl:deadbeef']))],
  ['an unknown risk id', 'V2', edit((r) => (r.risks[0]!.refs = ['str:1w']))],
  ['an unknown invalidation id', 'V2', edit((r) => (r.invalidation.refs = ['zone:00000000']))],
  ['an unknown competing-scenario id', 'V2', edit((r) => (r.competingScenario.refs = ['evt:ffffffff']))],
  ['an unknown indicator', 'V2', edit((r) => (r.supportingIndicators[0]!.ref = 'ind:1h:stoch'))],
  ['an id in the wrong case', 'V2', edit((r) => (r.observations[1]!.refs = ['STR:1h']))],
  [
    'a full UUID instead of the id',
    'V2',
    edit((r) => (r.observations[2]!.refs = ['5e6f7a8b-0000-7000-8000-000000000001'])),
  ],
  ['a made-up "gold" on BTC', 'V2', edit((r) => (r.risks[1]!.refs = ['gold']))],
  // V3: numbers grounded.
  ['an invented price in the summary', 'V3', edit((r) => (r.summary = 'Price could reach 68500.00 next.'))],
  [
    'an invented level in the invalidation',
    'V3',
    edit((r) => (r.invalidation.text = 'A close below 63999.99 invalidates it.')),
  ],
  ['an invented 24 h change', 'V3', edit((r) => (r.observations[0]!.text = 'Price fell 3.2% in 24 hours.'))],
  [
    'a percentage 0.2 points off',
    'V3',
    edit((r) => (r.observations[0]!.text = 'Price fell 1.64% in 24 hours.')),
  ],
  ['a price 0.1 % off', 'V3', edit((r) => (r.observations[1]!.text = 'The shift broke 65275.70.'))],
  [
    'an invented target',
    'V3',
    edit((r) => (r.competingScenario.text = 'A run to 67200.00 is also possible.')),
  ],
  [
    'an invented RSI reading',
    'V3',
    edit((r) => (r.supportingIndicators[0]!.reading = 'RSI on 1h is 71.43.')),
  ],
  ['an invented number in the headline', 'V3', edit((r) => (r.headline = 'BTC/USDT holds 63300.5'))],
  ['an invented number in a note', 'V3', edit((r) => (r.dataQualityNotes = ['The feed lagged 1250 ms.']))],
  [
    'an invented price with thousands separators',
    'V3',
    edit((r) => (r.risks[0]!.text = 'Resistance sits at 66,100.25.')),
  ],
  ['an invented ATR', 'V3', edit((r) => (r.supportingIndicators[0]!.reading = 'ATR on 1h is 512.75.'))],
  ['an invented volume', 'V3', edit((r) => (r.summary = 'Volume reached 2.45 billion, or 2450000000 USD.'))],
  // V4: policy.
  ['"guaranteed"', 'V4', edit((r) => (r.summary = 'A guaranteed move higher from the order block.'))],
  [
    '"will definitely"',
    'V4',
    edit((r) => (r.observations[0]!.text = 'Price will definitely retest the order block.')),
  ],
  ['"risk-free"', 'V4', edit((r) => (r.risks[0]!.text = 'A risk-free entry at the order block.'))],
  ['"can\'t lose"', 'V4', edit((r) => (r.summary = "With this setup you can't lose."))],
  ['"buy now"', 'V4', edit((r) => (r.headline = 'Buy now: the setup is confirmed'))],
  [
    '"you should sell"',
    'V4',
    edit((r) => (r.competingScenario.text = 'If the 4h trend wins, you should sell.')),
  ],
  ['"enter long"', 'V4', edit((r) => (r.observations[2]!.text = 'Enter long at the order block.'))],
  ['"go short"', 'V4', edit((r) => (r.risks[1]!.text = 'Traders could go short into CPI.'))],
  ['"open a long position"', 'V4', edit((r) => (r.summary = 'Consider: open a long position at the block.'))],
  ['"place a buy order"', 'V4', edit((r) => (r.invalidation.text = 'Place a buy order at the order block.'))],
  ['"strong buy signal"', 'V4', edit((r) => (r.headline = 'A strong buy signal on BTC/USDT'))],
  ['"100% certain"', 'V4', edit((r) => (r.summary = 'The shift is 100% certain to hold.'))],
  [
    '"bound to rise"',
    'V4',
    edit((r) => (r.observations[1]!.text = 'After the shift, price is bound to rise.')),
  ],
  ['"no doubt"', 'V4', edit((r) => (r.summary = 'There is no doubt the low was the bottom.'))],
  ['"all-in"', 'V4', edit((r) => (r.risks[0]!.text = 'Going all-in ahead of CPI is reckless.'))],
  // V5: gold.
  ['"XAUUSD"', 'V5', edit((r) => (r.summary = 'Like XAUUSD, BTC is volatile around CPI.'))],
  ['"XAU/USD"', 'V5', edit((r) => (r.observations[0]!.text = 'XAU/USD moved with the dollar.'))],
  ['"xau-usd" in lower case', 'V5', edit((r) => (r.risks[1]!.text = 'xau-usd and BTC may move together.'))],
];

describe('validation (ADR 011, criterion 9.2)', () => {
  it('accepts a valid answer, citing only the context and its numbers', () => {
    const checked = validateResponse(btcContext(), JSON.stringify(goodResponse()));
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.response?.stance).toBe('bullish');
  });

  it(`rejects every one of the ${BAD.length} crafted bad answers, by the rule it breaks`, () => {
    expect(BAD.length).toBeGreaterThanOrEqual(50);
    for (const [name, rule, mutate] of BAD) {
      const checked = validateResponse(btcContext(), JSON.stringify(mutate(goodResponse())));
      expect(checked.errors.length, name).toBeGreaterThan(0);
      expect(
        checked.errors.map((e) => e.rule),
        name,
      ).toContain(rule);
    }
  });

  it('rejects text that is not JSON, and says where the schema failed', () => {
    expect(validateResponse(btcContext(), '{"stance":').errors).toEqual([
      { rule: 'V1', path: '', message: 'the answer is not JSON' },
    ]);
    const missing = validateResponse(btcContext(), { ...goodResponse(), risks: undefined });
    expect(missing.errors[0]).toMatchObject({ rule: 'V1', path: 'risks' });
    expect(missing.response).toBeNull();
  });

  it('accepts numbers as the context gives them, within the tolerances, and text that is not a number', () => {
    const r = goodResponse();
    r.summary =
      'At 14:30 UTC on 2026-11-16 (16 Nov), the 15m and 4h charts agree; 2 levels and 3 events matter. Price is 65432.1, down 1.84% (about 1.8% on the day); the spread is 0.3 bps, or 0.003%.';
    r.observations[0]!.text = 'The level lvl:3f2a9c1e at 64,150 was swept; RSI 38.6 on 1h.';
    r.observations[1]!.text = 'The 1h shift broke 65,210.5, within 0.05% of the stored price as 65,230.';
    const checked = validateResponse(btcContext(), r);
    expect(checked.errors).toEqual([]);
  });

  it('enforces the gold rules on PAXG while the gold market is closed', () => {
    const ctx = paxgClosedContext();
    const r: AiResponse = {
      ...goodResponse(),
      headline: 'PAXG holds near 4101.50 while the gold market is closed',
      summary: 'PAXG trades at 4101.50 with the gold market closed; the cross-venue spread is 12 bps.',
      observations: [{ text: 'The previous day high is 4120.80.', refs: ['lvl:aa11bb22'] }],
      supportingIndicators: [],
      risks: [{ text: 'With the gold market closed, PAXG can drift from spot gold.', refs: ['mkt'] }],
      invalidation: { text: 'A break of the previous day high would end the range.', refs: ['lvl:aa11bb22'] },
      competingScenario: { text: 'The range may hold until gold reopens.', refs: ['mkt'] },
    };
    expect(validateResponse(ctx, r).errors).toEqual([
      expect.objectContaining({ rule: 'V5', path: 'observations' }),
    ]);
    r.risks[0]!.refs = ['gold', 'mkt'];
    expect(validateResponse(ctx, r).errors).toEqual([]);
    // Open: no gold citation needed.
    const open = { ...ctx, goldMarket: { ...ctx.goldMarket!, status: 'open' as const } };
    r.risks[0]!.refs = ['mkt'];
    expect(validateResponse(open, r).errors).toEqual([]);
  });

  it('warns, without rejecting, when the stance is against every confirmed setup (V6)', () => {
    const r = { ...goodResponse(), stance: 'bearish' as const };
    const checked = validateResponse(btcContext(), r);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([expect.objectContaining({ rule: 'V6', path: 'stance' })]);
    expect(validateResponse(btcContext(), { ...r, stance: 'neutral' }).warnings).toEqual([]);
    expect(validateResponse(btcContext({ setups: [] }), r).warnings).toEqual([]);
  });

  it('knows every id the context offers, and every number in it', () => {
    const ids = contextIds(paxgClosedContext());
    expect([...ids]).toEqual(
      expect.arrayContaining([
        'instr',
        'mkt',
        'gold',
        'ind:1h:rsi',
        'str:4h',
        'lvl:aa11bb22',
        'evt:9c8b7a6d',
        'cal:7e6d5c4b',
      ]),
    );
    const n = contextNumbers(btcContext());
    expect(n.numbers).toEqual(expect.arrayContaining([65432.1, 1.84, 412.75, 64150, 5.11]));
    // Times and ids are not numbers; a share in basis points is also a percentage.
    expect(n.numbers).not.toContain(Date.UTC(2026, 10, 16, 10, 0));
    expect(n.percents).toEqual(expect.arrayContaining([1.84, 0.003]));
  });

  it('reads the numbers a text states', () => {
    expect(
      statedNumbers('Up 1.5% to 65,432.10 on 4h; 2026-11-16 14:30; lvl:831021ab').map((n) => [
        n.value,
        n.percent,
      ]),
    ).toEqual([
      [1.5, true],
      [65432.1, false],
    ]);
    expect(significantDigits(65432.1, '65,432.10')).toBe(7);
    expect(significantDigits(0.0012, '0.0012')).toBe(2);
    expect(significantDigits(1200, '1200')).toBe(2);
    expect(significantDigits(0, '0')).toBe(1);
  });
});
