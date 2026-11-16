import { describe, expect, it } from 'vitest';
import type { AlertCondition, AlertRule } from '@cip/contracts';
import { AUTO_TRADE_ALERTS, missingAutoTradeAlerts } from './alert-rules.js';

const T = Date.UTC(2026, 10, 16, 10, 0);
const rule = (n: number, condition: AlertCondition, extra: Partial<AlertRule> = {}): AlertRule => ({
  id: `019a7500-0000-7000-8000-${String(n).padStart(12, '0')}`,
  ownerId: '019a7500-0000-7000-8000-000000000001',
  name: `Rule ${n}`,
  enabled: true,
  scope: {},
  condition,
  severity: 'info',
  cooldownSec: 300,
  channels: ['in_app'],
  quietHours: null,
  version: 1,
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const kinds = (rules: readonly { condition: AlertCondition }[]) => rules.map((r) => r.condition);

describe('notifications of automatic trades (changed 2026-11-16)', () => {
  it('offers a rule for each automatic buy, practice fill, stop or target sale and pause, with no cooldown, to the inbox, desktop and browser', () => {
    expect(kinds(AUTO_TRADE_ALERTS)).toEqual([
      { kind: 'practice_auto_order' },
      { kind: 'practice_order_filled' },
      { kind: 'practice_exit', on: ['stop', 'target'] },
      { kind: 'practice_auto_paused' },
    ]);
    for (const r of AUTO_TRADE_ALERTS) {
      expect(r.cooldownSec).toBe(0);
      expect(r.channels).toEqual(['in_app', 'desktop', 'web']);
    }
    expect(missingAutoTradeAlerts([])).toEqual(AUTO_TRADE_ALERTS);
  });

  it('counts only rules that are on and watch every pair', () => {
    const covered = [
      rule(1, { kind: 'practice_auto_order' }),
      rule(2, { kind: 'practice_order_filled' }, { channels: ['in_app', 'web'], quietHours: null }),
      rule(3, { kind: 'practice_exit', on: ['target', 'stop'] }),
      rule(4, { kind: 'practice_auto_paused' }),
      rule(5, { kind: 'price_cross', price: '100000', direction: 'above' }),
    ];
    expect(missingAutoTradeAlerts(covered)).toEqual([]);

    const partly = [
      rule(1, { kind: 'practice_auto_order' }, { enabled: false }),
      rule(2, { kind: 'practice_order_filled' }, { scope: { venues: ['binance'] } }),
      rule(
        3,
        { kind: 'practice_exit', on: ['stop', 'target'] },
        { scope: { instrumentIds: [rule(9, { kind: 'practice_auto_order' }).id] } },
      ),
      rule(4, { kind: 'practice_auto_paused' }),
    ];
    expect(kinds(missingAutoTradeAlerts(partly))).toEqual([
      { kind: 'practice_auto_order' },
      { kind: 'practice_order_filled' },
      { kind: 'practice_exit', on: ['stop', 'target'] },
    ]);
  });

  it('counts stops and targets leg by leg, so a rule for one leaves only the other to make', () => {
    const stopOnly = [rule(1, { kind: 'practice_exit', on: ['stop'] })];
    const missing = missingAutoTradeAlerts(stopOnly);
    expect(missing.map((r) => r.name)).toEqual([
      'Automatic practice buy placed',
      'Practice order filled',
      'Practice target sold',
      'Automatic practice trading paused',
    ]);
    expect(missing[2]).toMatchObject({
      condition: { kind: 'practice_exit', on: ['target'] },
      cooldownSec: 0,
    });
    // Two rules, one leg each, give both.
    const both = [...stopOnly, rule(2, { kind: 'practice_exit', on: ['target'] })];
    expect(kinds(missingAutoTradeAlerts(both))).not.toContainEqual(
      expect.objectContaining({ kind: 'practice_exit' }),
    );
  });
});
