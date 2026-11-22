import { describe, expect, it } from 'vitest';
import { settingDifferences } from './comparison.service.js';

describe('settingDifferences', () => {
  it('lists each leaf that differs, by path, in path order', () => {
    const base = {
      smc: { setups: { checklist: { minRR: 2, mandatory: ['sweep', 'mss'] }, timing: { maxHoldBars: 288 } } },
    };
    const other = {
      smc: { setups: { checklist: { minRR: 3, mandatory: ['sweep'] }, timing: { maxHoldBars: 288 } } },
    };
    expect(settingDifferences(base, other)).toEqual([
      { path: 'smc.setups.checklist.mandatory', base: ['sweep', 'mss'], other: ['sweep'] },
      { path: 'smc.setups.checklist.minRR', base: 2, other: 3 },
    ]);
  });

  it('ignores key order, and gives null for a setting only one side has', () => {
    expect(settingDifferences({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([]);
    expect(settingDifferences({ a: 1 }, { a: 1, extra: { x: true } })).toEqual([
      { path: 'extra', base: null, other: { x: true } },
    ]);
  });

  it('compares arrays as wholes, in order', () => {
    expect(settingDifferences({ p: ['a', 'b'] }, { p: ['b', 'a'] })).toEqual([
      { path: 'p', base: ['a', 'b'], other: ['b', 'a'] },
    ]);
    expect(settingDifferences({ p: [{ n: 1 }] }, { p: [{ n: 1 }] })).toEqual([]);
  });

  it('treats a value replaced by an object as one difference at that path', () => {
    expect(settingDifferences({ a: 1 }, { a: { b: 1 } })).toEqual([{ path: 'a', base: 1, other: { b: 1 } }]);
    expect(settingDifferences(1, 2)).toEqual([{ path: '', base: 1, other: 2 }]);
  });
});
