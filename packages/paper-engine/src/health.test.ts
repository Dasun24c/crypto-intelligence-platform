import { describe, expect, it } from 'vitest';
import { practiceHealth, type HealthInput } from './health.js';

const streaming: HealthInput = {
  enabled: true,
  venueStatus: 'trading',
  feeds: [
    { stream: 'trades', state: 'connected' },
    { stream: 'depth', state: 'connected' },
    { stream: 'ticker', state: 'degraded' },
  ],
  openGaps: [],
};

describe('practice health (TRD-07)', () => {
  it('is ok while trades and the book stream', () => {
    expect(practiceHealth(streaming)).toBe('ok');
    expect(practiceHealth({ ...streaming, venueStatus: 'unknown' })).toBe('ok');
    expect(practiceHealth({ ...streaming, openGaps: ['kline'] })).toBe('ok');
  });

  it('names why orders cannot be taken up, most serious first', () => {
    expect(practiceHealth({ ...streaming, enabled: false })).toBe('pair_halted');
    expect(practiceHealth({ ...streaming, venueStatus: 'halted', openGaps: ['trades'] })).toBe('pair_halted');
    expect(practiceHealth({ ...streaming, venueStatus: 'delisted' })).toBe('pair_halted');
    expect(practiceHealth({ ...streaming, openGaps: ['depth'] })).toBe('data_gap');
    expect(practiceHealth({ ...streaming, feeds: [] })).toBe('data_delayed');
    expect(
      practiceHealth({
        ...streaming,
        feeds: [
          { stream: 'trades', state: 'degraded' },
          { stream: 'depth', state: 'connected' },
        ],
      }),
    ).toBe('data_delayed');
    expect(practiceHealth({ ...streaming, feeds: [{ stream: 'trades', state: 'connected' }] })).toBe(
      'data_delayed',
    );
  });
});
