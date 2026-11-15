import { describe, expect, it } from 'vitest';
import { setupSummary } from '../test/smc-fixtures.js';
import { readLiquiditySearch, readScannerSearch } from './search.js';
import { creditText, evidenceText, formatRr, sortSetups } from './setups.js';

describe('the Setup Scanner order (criterion 7.2)', () => {
  const a = setupSummary(1, {
    score: 60,
    levels: { entry: '1', invalidation: '2', target1: '0', target2: null, rr: 1.5 },
    instrumentId: 'b',
  });
  const b = setupSummary(2, {
    score: 80,
    levels: { entry: '1', invalidation: '2', target1: '0', target2: null, rr: null },
    instrumentId: 'a',
  });
  const c = setupSummary(3, {
    score: 60,
    levels: { entry: '1', invalidation: '2', target1: '0', target2: null, rr: 2.25 },
    instrumentId: 'a',
  });
  const ids = (list: { id: string }[]) => list.map((s) => s.id);

  it('sorts by latest change, score, R:R (none last) and instrument, newest first among equals', () => {
    expect(ids(sortSetups([a, b, c], 'updated'))).toEqual(ids([c, b, a]));
    expect(ids(sortSetups([a, b, c], 'score'))).toEqual(ids([b, c, a]));
    expect(ids(sortSetups([a, b, c], 'rr'))).toEqual(ids([c, a, b]));
    const names = (id: string) => ({ a: 'Alpha', b: 'Beta' })[id] ?? id;
    expect(ids(sortSetups([a, b, c], 'instrument', names))).toEqual(ids([c, b, a]));
  });

  it('does not change the list it was given', () => {
    const list = [a, b, c];
    sortSetups(list, 'score');
    expect(ids(list)).toEqual(ids([a, b, c]));
  });
});

describe('checklist wording', () => {
  it('reads credits, the news item and R:R', () => {
    expect([creditText(1), creditText(0.5), creditText(0)]).toEqual(['Pass', 'Half', 'Fail']);
    const news = { item: 'news_clear' as const, weight: 5, mandatory: false };
    expect(evidenceText({ ...news, credit: 0, evidence: { reason: 'calendar_unavailable' } })).toBe(
      'Economic calendar unavailable',
    );
    expect(evidenceText({ ...news, credit: 0, evidence: { events: ['e1'] } }, () => 'CPI at 13:30')).toBe(
      'In the blackout window: CPI at 13:30',
    );
    expect(evidenceText({ ...news, credit: 1, evidence: {} })).toBe('No high-impact event in the window');
    expect(
      evidenceText({
        item: 'risk_reward',
        credit: 0,
        weight: 15,
        mandatory: false,
        evidence: { rr: 0.514, minRR: 2 },
      }),
    ).toBe('R:R 0.514 (minimum 2)');
    expect(formatRr(2.1078)).toBe('1 : 2.1078');
    expect(formatRr(null)).toBe('—');
  });
});

describe('search parameters', () => {
  it('keeps only what the pages understand', () => {
    expect(readLiquiditySearch({ instrument: 'x', tf: '4h' })).toEqual({ instrument: 'x', tf: '4h' });
    expect(readLiquiditySearch({ tf: '1m' })).toEqual({});
    expect(
      readScannerSearch({
        pattern: 'eq_near_poi',
        direction: 'up',
        minScore: '150',
        sort: 'rr',
        state: 'all',
      }),
    ).toEqual({
      pattern: 'eq_near_poi',
      sort: 'rr',
      state: 'all',
    });
    expect(readScannerSearch({ minScore: '40', direction: 'bullish' })).toEqual({
      minScore: 40,
      direction: 'bullish',
    });
  });
});
