import { describe, expect, it } from 'vitest';
import {
  ALERT_CONDITION_KINDS,
  AlertConditionSchema,
  AlertFiredMessageSchema,
  AlertRuleTestQuerySchema,
  CreateAlertRuleRequestSchema,
  NotificationReadMessageSchema,
  NotificationsQuerySchema,
  QuietHoursSchema,
  UpdateAlertRuleRequestSchema,
} from './alerts.js';
import { CHANNEL_PATTERN, channels, CONFIG_CHANNELS, isDurableChannel } from './market.js';

const ID = '019a7000-0000-7000-8000-000000000001';

describe('alert contracts (Phase 8)', () => {
  it('has fourteen condition kinds, each with its own fields (twelve from Phase 8, two for practice trading)', () => {
    expect(ALERT_CONDITION_KINDS).toHaveLength(14);
    const valid = [
      { kind: 'price_cross', price: '100000', direction: 'above' },
      { kind: 'price_change_pct', windowMin: 60, pct: 2 },
      { kind: 'indicator_threshold', tf: '1h', indicator: 'rsi', op: 'cross_above', value: 70 },
      { kind: 'volume_anomaly', tf: '15m', minZ: 3 },
      {
        kind: 'smc_event',
        tfs: ['1h'],
        events: ['sweep', 'poi_entry'],
        levelTypes: ['pdh'],
        zoneTypes: ['fvg'],
      },
      {
        kind: 'setup_transition',
        toStates: ['confirmed'],
        patterns: ['eq_near_poi'],
        directions: ['bearish'],
        minScore: 70,
      },
      { kind: 'spread_threshold', baseAsset: 'PAXG', absBps: 30 },
      { kind: 'economic_event_upcoming', minImpact: 'high', minutesBefore: 30 },
      { kind: 'gold_market_session', on: ['open'] },
      { kind: 'large_trade', minUsd: '1000000', sides: ['buy'] },
      { kind: 'wall', events: ['pulled'] },
      { kind: 'feed_health', events: ['halted'] },
      { kind: 'practice_order_filled' },
      { kind: 'practice_exit', on: ['stop', 'target'] },
    ];
    expect(valid.map((c) => AlertConditionSchema.safeParse(c).success)).toEqual(valid.map(() => true));
    expect(AlertConditionSchema.safeParse({ kind: 'practice_exit', on: [] }).success).toBe(false);
    expect(AlertConditionSchema.safeParse({ kind: 'practice_exit', on: ['entry'] }).success).toBe(false);
    expect(AlertConditionSchema.safeParse({ kind: 'practice_order_filled', side: 'buy' }).success).toBe(
      false,
    );
    expect(new Set(valid.map((c) => c.kind))).toEqual(new Set(ALERT_CONDITION_KINDS));
    const invalid = [
      { kind: 'price_cross', price: '0', direction: 'above' },
      { kind: 'price_cross', price: '1', direction: 'sideways' },
      { kind: 'price_change_pct', windowMin: 0, pct: 2 },
      { kind: 'smc_event', tfs: [], events: ['sweep'] },
      { kind: 'setup_transition', toStates: [] },
      { kind: 'spread_threshold', baseAsset: 'BTC', absBps: 30 },
      { kind: 'large_trade', minUsd: '-5' },
      { kind: 'feed_health', events: ['gap'], extra: true },
      { kind: 'unknown' },
    ];
    expect(invalid.map((c) => AlertConditionSchema.safeParse(c).success)).toEqual(invalid.map(() => false));
  });

  it('fills a new rule’s defaults and keeps the inbox in every rule’s channels', () => {
    const rule = CreateAlertRuleRequestSchema.parse({
      name: ' BTC above 100k ',
      condition: { kind: 'price_cross', price: '100000', direction: 'above' },
    });
    expect(rule).toEqual({
      name: 'BTC above 100k',
      enabled: true,
      scope: {},
      condition: { kind: 'price_cross', price: '100000', direction: 'above' },
      severity: 'info',
      cooldownSec: 300,
      channels: ['in_app'],
      quietHours: null,
    });
    const base = { name: 'x', condition: { kind: 'gold_market_session', on: ['open'] } };
    expect(CreateAlertRuleRequestSchema.safeParse({ ...base, channels: ['desktop'] }).success).toBe(false);
    expect(CreateAlertRuleRequestSchema.safeParse({ ...base, channels: ['in_app', 'in_app'] }).success).toBe(
      false,
    );
    expect(CreateAlertRuleRequestSchema.safeParse({ ...base, cooldownSec: 86_401 }).success).toBe(false);
    expect(
      CreateAlertRuleRequestSchema.safeParse({ ...base, scope: { instrumentIds: [ID], venues: ['binance'] } })
        .success,
    ).toBe(true);
    expect(CreateAlertRuleRequestSchema.safeParse({ ...base, name: '  ' }).success).toBe(false);
  });

  it('checks quiet hours: 24-hour times that differ, an IANA time zone, days 0–6', () => {
    expect(
      QuietHoursSchema.safeParse({ start: '22:00', end: '07:00', timeZone: 'Asia/Colombo' }).success,
    ).toBe(true);
    expect(QuietHoursSchema.safeParse({ start: '22:00', end: '22:00', timeZone: 'UTC' }).success).toBe(false);
    expect(QuietHoursSchema.safeParse({ start: '24:00', end: '07:00', timeZone: 'UTC' }).success).toBe(false);
    expect(
      QuietHoursSchema.safeParse({ start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' }).success,
    ).toBe(false);
    expect(
      QuietHoursSchema.safeParse({ start: '22:00', end: '07:00', timeZone: 'UTC', days: [7] }).success,
    ).toBe(false);
  });

  it('needs a version and something to change in an update', () => {
    expect(UpdateAlertRuleRequestSchema.safeParse({ version: 3, enabled: false }).success).toBe(true);
    expect(UpdateAlertRuleRequestSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(UpdateAlertRuleRequestSchema.safeParse({ enabled: false }).success).toBe(false);
  });

  it('reads the inbox and test queries from the query string', () => {
    expect(NotificationsQuerySchema.parse({ unread: 'true' })).toEqual({ unread: true, limit: 100 });
    expect(NotificationsQuerySchema.parse({ unread: 'false', limit: '5' })).toEqual({
      unread: false,
      limit: 5,
    });
    expect(AlertRuleTestQuerySchema.parse({})).toEqual({ hours: 24 });
    expect(AlertRuleTestQuerySchema.safeParse({ hours: '200' }).success).toBe(false);
  });

  it('describes the alerts channel: durable, per user, its two message kinds', () => {
    expect(channels.alerts).toBe('alerts');
    expect(CHANNEL_PATTERN.test('alerts')).toBe(true);
    expect(isDurableChannel('alerts')).toBe(true);
    expect(CONFIG_CHANNELS.alerts).toBe('config:alerts');
    const event = {
      id: ID,
      ruleId: ID,
      ruleName: 'r',
      firedAt: 1,
      severity: 'info',
      title: 't',
      body: 'b',
      instrumentId: null,
      sourceRefs: {},
      late: false,
    };
    expect(
      AlertFiredMessageSchema.safeParse({
        notification: { id: ID, event, createdAt: 1, readAt: null },
        channels: ['desktop'],
        quiet: false,
      }).success,
    ).toBe(true);
    expect(NotificationReadMessageSchema.safeParse({ ids: [ID] }).success).toBe(true);
    expect(NotificationReadMessageSchema.safeParse({ all: true, before: 5 }).success).toBe(true);
    expect(NotificationReadMessageSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
