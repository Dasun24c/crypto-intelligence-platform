import { describe, expect, it } from 'vitest';
import { positionSize, riskReward } from './position-size.js';

/**
 * Criterion 6.4: R:R and position sizes against examples worked out by hand (the arithmetic is in
 * each comment), including decimal edge cases.
 */
describe('positionSize', () => {
  it('sizes a BTC long', () => {
    // 10,000 × 1 % = 100 at risk; 65,000 − 64,500 = 500 per BTC: 0.2 BTC, 13,000 notional (1.3×).
    // Target 66,500: 1,500 / 500 = 3 R, 0.2 × 1,500 = 300.
    expect(
      positionSize({
        accountSize: '10000',
        riskPct: '1',
        entry: '65000',
        invalidation: '64500',
        qtyStep: '0.00001',
        target: '66500',
      }),
    ).toEqual({
      side: 'long',
      riskAmount: '100',
      distance: '500',
      distancePct: '0.7692',
      quantity: '0.2',
      notional: '13000',
      riskAtQuantity: '100',
      leverage: '1.3',
      rr: '3',
      reward: '300',
    });
  });

  it('sizes a short and rounds the quantity down to the step', () => {
    // The p1-a-bearish-001 setup: entry 98.2, invalidation 102.48, T1 96. 2,500 × 0.5 % = 12.5;
    // distance 4.28; 12.5 / 4.28 = 2.92056…, down to the 0.001 step: 2.92. It risks 2.92 × 4.28 =
    // 12.4976 and is worth 2.92 × 98.2 = 286.744. R:R 2.2 / 4.28 = 0.51401… → 0.514; reward 6.424.
    expect(
      positionSize({
        accountSize: '2500',
        riskPct: '0.5',
        entry: '98.2',
        invalidation: '102.48',
        qtyStep: '0.001',
        target: '96',
      }),
    ).toEqual({
      side: 'short',
      riskAmount: '12.5',
      distance: '4.28',
      distancePct: '4.3584',
      quantity: '2.92',
      notional: '286.744',
      riskAtQuantity: '12.4976',
      leverage: '0.1146',
      rr: '0.514',
      reward: '6.424',
    });
  });

  it('keeps every decimal exact', () => {
    // 0.3 − 0.1 is exactly 0.2 (a float gives 0.19999999999999998): 1,000 × 2 % = 20 / 0.2 = 100.
    const r = positionSize({ accountSize: '1000', riskPct: '2', entry: '0.3', invalidation: '0.1' });
    expect([r.distance, r.quantity, r.notional, r.riskAtQuantity]).toEqual(['0.2', '100', '30', '20']);
    // A one-satoshi stop: 10 at risk / 0.00000001 = 1,000,000,000 units, worth 123,450 (123.45×).
    const tiny = positionSize({
      accountSize: '1000',
      riskPct: '1',
      entry: '0.00012345',
      invalidation: '0.00012344',
      qtyStep: '1',
    });
    expect([tiny.distance, tiny.quantity, tiny.notional, tiny.leverage]).toEqual([
      '0.00000001',
      '1000000000',
      '123450',
      '123.45',
    ]);
  });

  it('sizes gold (PAXG) with its 0.0001 step', () => {
    // 5,000 × 0.75 % = 37.5; 2,655.12 − 2,650.37 = 4.75; 37.5 / 4.75 = 7.894736…, down to 7.8947.
    // 7.8947 × 2,650.37 = 20,923.8760… exactly 20923.876039; risk 7.8947 × 4.75 = 37.499825.
    const r = positionSize({
      accountSize: '5000',
      riskPct: '0.75',
      entry: '2650.37',
      invalidation: '2655.12',
      qtyStep: '0.0001',
    });
    expect(r).toMatchObject({
      side: 'short',
      riskAmount: '37.5',
      quantity: '7.8947',
      notional: '20923.876039',
      riskAtQuantity: '37.499825',
      leverage: '4.1847',
    });
  });

  it('never risks more than the risk amount, and rounds 8 decimals by default', () => {
    // 100 × 1 % = 1 / 3 = 0.333333333…, down to 8 decimals: 0.33333333, risking 0.99999999.
    const r = positionSize({ accountSize: '100', riskPct: '1', entry: '10', invalidation: '7' });
    expect([r.quantity, r.riskAtQuantity]).toEqual(['0.33333333', '0.99999999']);
  });

  it('refuses inputs that make no sense', () => {
    const ok = { accountSize: '1000', riskPct: '1', entry: '100', invalidation: '99' };
    expect(() => positionSize({ ...ok, invalidation: '100' })).toThrow(/differ/);
    expect(() => positionSize({ ...ok, riskPct: '0' })).toThrow(/riskPct/);
    expect(() => positionSize({ ...ok, riskPct: '101' })).toThrow(/at most 100/);
    expect(() => positionSize({ ...ok, accountSize: '-5' })).toThrow(/accountSize/);
    expect(() => positionSize({ ...ok, entry: 'abc' })).toThrow(/not a number/);
    expect(() => positionSize({ ...ok, qtyStep: '0' })).toThrow(/qtyStep/);
  });
});

describe('riskReward', () => {
  it('measures the target against the distance to the invalidation', () => {
    expect(riskReward('100', '98', '106')).toBe('3'); // long: 6 / 2
    expect(riskReward('100', '102', '97')).toBe('1.5'); // short: 3 / 2
    expect(riskReward('100.3', '102.34', '96')).toBe('2.1078'); // 4.3 / 2.04 = 2.10784…
  });

  it('is null when the target is on the wrong side', () => {
    expect(riskReward('100', '98', '99')).toBeNull();
    expect(riskReward('100', '102', '100')).toBeNull();
  });
});
