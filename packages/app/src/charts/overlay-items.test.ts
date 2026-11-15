import { describe, expect, it } from 'vitest';
import { drawnRecord, overlayItems } from './overlay-items.js';
import { TimeIndex } from './overlay-primitive.js';
import { H, overlay, T0 } from '../test/smc-fixtures.js';

const candles = Array.from({ length: 12 }, (_, i) => ({ t: T0 + i * H, h: '106', l: '98' }));

describe('overlay items (criterion 7.1)', () => {
  it('gives one item per detection, clamped to the chart window, with labels and descriptions', () => {
    const items = overlayItems(overlay(), candles, '1h');
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ['range', 'Range'],
      ['zone', 'HTF OB 35%'],
      ['level', 'London high'],
      ['setup', 'P4 Confirmed'],
      ['swing', 'H'],
      ['structure', 'BOS'],
      ['sweep', 'Thin book'],
    ]);
    const end = T0 + 12 * H;
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    // Open-ended items run to the window's end; ended ones stop where they ended.
    expect(byKind['range']).toMatchObject({ from: T0 + H, to: end });
    expect(byKind['zone']).toMatchObject({ from: T0 + 2 * H, to: end });
    expect(byKind['level']).toMatchObject({ from: T0 + 3 * H, to: T0 + 7 * H, status: 'swept' });
    expect(byKind['structure']).toMatchObject({ at: T0 + 8 * H, from: T0 + 2 * H });
    expect(byKind['sweep']).toMatchObject({ thinBook: true, price: '104.9' });
    expect(byKind['setup']).toMatchObject({
      anchor: '106',
      lines: [
        { role: 'entry', price: '98.2' },
        { role: 'invalidation', price: '102.48' },
        { role: 'target1', price: '96' },
      ],
    });
    expect(byKind['zone']!.description).toBe('Bearish HTF OB 104.6–105.2 (1h), partially filled, 35% filled');
  });

  it('shades gold-market closures and records what each item was drawn from', () => {
    const items = overlayItems(
      overlay({ closures: [{ from: T0 + 5 * H, to: T0 + 6 * H, reason: 'daily_break' }] }),
      candles,
      '1h',
    );
    expect(drawnRecord(items[0]!)).toEqual({
      kind: 'closure',
      id: `closure:${T0 + 5 * H}`,
      from: T0 + 5 * H,
      to: T0 + 6 * H,
    });
    expect(items.map(drawnRecord).find((r) => r.kind === 'setup')).toEqual({
      kind: 'setup',
      id: expect.any(String),
      state: 'confirmed',
      entry: '98.2',
      invalidation: '102.48',
      target1: '96',
      target2: null,
    });
  });

  it('draws nothing without candles', () => {
    expect(overlayItems(overlay(), [], '1h')).toEqual([]);
  });
});

describe('time index', () => {
  const index = new TimeIndex([0, 60, 120, 300], 60);
  it('maps a bar open to its index, a time inside a bar to a fraction, and beyond either end linearly', () => {
    expect(index.logical(60)).toBe(1);
    expect(index.logical(90)).toBe(1.5);
    expect(index.logical(-60)).toBe(-1);
    expect(index.logical(420)).toBe(5);
  });

  it('collapses missing candles: a time inside a gap ends its bar', () => {
    expect(index.logical(180)).toBe(3);
    expect(index.logical(300)).toBe(3);
  });
});
