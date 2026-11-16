import type { AlertCondition, AlertConditionKind, AlertRule, CreateAlertRuleRequest } from '@cip/contracts';
import { PATTERN_SHORT, STATE_TITLE } from './setups.js';

/** The query of the user's own alert rules (the Alert Center and the automatic trading card). */
export const ALERT_RULES_KEY = ['alerts', 'rules'] as const;

/**
 * Notifications of automatic practice trading (changed 2026-11-16, at a user's request; ADR 022): the
 * alert rules the automatic trading card offers to make, so that each automatic buy placed, each
 * practice order filled, each stop or target sold and a pause reach the inbox, and as desktop or
 * browser notifications while the app is open. No cooldown: each is a trade of its own.
 */
export const AUTO_TRADE_ALERTS: readonly CreateAlertRuleRequest[] = [
  {
    name: 'Automatic practice buy placed',
    condition: { kind: 'practice_auto_order' },
    severity: 'info',
    cooldownSec: 0,
    channels: ['in_app', 'desktop', 'web'],
  },
  {
    name: 'Practice order filled',
    condition: { kind: 'practice_order_filled' },
    severity: 'info',
    cooldownSec: 0,
    channels: ['in_app', 'desktop', 'web'],
  },
  {
    name: 'Practice stop or target sold',
    condition: { kind: 'practice_exit', on: ['stop', 'target'] },
    severity: 'info',
    cooldownSec: 0,
    channels: ['in_app', 'desktop', 'web'],
  },
  {
    name: 'Automatic practice trading paused',
    condition: { kind: 'practice_auto_paused' },
    severity: 'warning',
    cooldownSec: 0,
    channels: ['in_app', 'desktop', 'web'],
  },
];

/**
 * Those of {@link AUTO_TRADE_ALERTS} the user's rules do not give yet: a rule gives one when it is
 * switched on, has the same condition kind and watches every pair. Stops and targets are counted leg
 * by leg, so a rule for the stop alone leaves only the target to make. Rules switched off do not count.
 */
export function missingAutoTradeAlerts(rules: readonly AlertRule[]): CreateAlertRuleRequest[] {
  const live = rules.filter((r) => r.enabled && !r.scope.instrumentIds && !r.scope.venues);
  const legs = new Set(live.flatMap((r) => (r.condition.kind === 'practice_exit' ? r.condition.on : [])));
  return AUTO_TRADE_ALERTS.flatMap((want) => {
    const c = want.condition;
    if (c.kind !== 'practice_exit') return live.some((r) => r.condition.kind === c.kind) ? [] : [want];
    const on = c.on.filter((leg) => !legs.has(leg));
    if (on.length === c.on.length) return [want];
    return on.map((leg) => ({
      ...want,
      name: `Practice ${leg} sold`,
      condition: { kind: c.kind, on: [leg] },
    }));
  });
}

/** The sixteen condition kinds, in the order the rule form offers them. */
export const KIND_LABELS: Record<AlertConditionKind, string> = {
  price_cross: 'Price crosses a level',
  price_change_pct: 'Price moves by a percentage',
  indicator_threshold: 'Indicator threshold',
  volume_anomaly: 'Volume anomaly',
  smc_event: 'SMC event (sweep, BOS, CHOCH, MSS, POI entry)',
  setup_transition: 'Setup state change',
  spread_threshold: 'PAXG cross-venue spread',
  economic_event_upcoming: 'Economic release approaching',
  gold_market_session: 'Gold market opens or closes',
  large_trade: 'Large trade',
  wall: 'Order-book wall',
  feed_health: 'Data feed health',
  practice_order_filled: 'Practice order filled (simulated)',
  practice_exit: 'Practice stop or target reached (simulated)',
  practice_auto_order: 'Automatic practice order placed (simulated)',
  practice_auto_paused: 'Automatic practice trading paused (simulated)',
};
export const KINDS = Object.keys(KIND_LABELS) as AlertConditionKind[];

/**
 * Kinds that watch instruments (the rest are about PAXG's spread, the calendar, the gold market, or
 * the pause of the user's automatic practice trading).
 */
export function watchesInstruments(kind: AlertConditionKind): boolean {
  return (
    kind !== 'spread_threshold' &&
    kind !== 'economic_event_upcoming' &&
    kind !== 'gold_market_session' &&
    kind !== 'practice_auto_paused'
  );
}

/** A sensible starting condition for each kind, for the rule form. */
export function defaultCondition(kind: AlertConditionKind): AlertCondition {
  switch (kind) {
    case 'price_cross':
      return { kind, price: '100000', direction: 'above' };
    case 'price_change_pct':
      return { kind, windowMin: 60, pct: 2 };
    case 'indicator_threshold':
      return { kind, tf: '1h', indicator: 'rsi', op: 'cross_above', value: 70 };
    case 'volume_anomaly':
      return { kind, tf: '15m', minZ: 3 };
    case 'smc_event':
      return { kind, tfs: ['1h', '4h'], events: ['sweep', 'mss'] };
    case 'setup_transition':
      return { kind, toStates: ['confirmed'] };
    case 'spread_threshold':
      return { kind, baseAsset: 'PAXG', absBps: 30 };
    case 'economic_event_upcoming':
      return { kind, minImpact: 'high', minutesBefore: 30 };
    case 'gold_market_session':
      return { kind, on: ['open', 'close'] };
    case 'large_trade':
      return { kind, minUsd: '1000000' };
    case 'wall':
      return { kind, events: ['appeared', 'pulled'] };
    case 'feed_health':
      return { kind, events: ['gap', 'halted', 'delisted', 'disconnected'] };
    case 'practice_order_filled':
      return { kind };
    case 'practice_exit':
      return { kind, on: ['stop', 'target'] };
    case 'practice_auto_order':
    case 'practice_auto_paused':
      return { kind };
  }
}

const SMC_EVENT_LABELS = {
  sweep: 'sweep',
  false_breakout: 'false breakout',
  bos: 'BOS',
  choch: 'CHOCH',
  mss: 'MSS',
  poi_entry: 'POI entry',
} as const;
const INDICATOR_LABELS = {
  rsi: 'RSI',
  macd_hist: 'MACD histogram',
  volume_z: 'volume z-score',
  atr: 'ATR',
} as const;
const OP_LABELS = {
  '>': 'above',
  '<': 'below',
  cross_above: 'crosses above',
  cross_below: 'crosses below',
} as const;
const list = (items: readonly string[]) => items.join(', ');

/** One line saying what the condition watches for. */
export function describeCondition(c: AlertCondition): string {
  switch (c.kind) {
    case 'price_cross':
      return `Price crosses ${c.direction} ${c.price}`;
    case 'price_change_pct':
      return `Price moves ${c.pct}% or more within ${c.windowMin} min`;
    case 'indicator_threshold':
      return `${c.tf} ${INDICATOR_LABELS[c.indicator]} ${OP_LABELS[c.op]} ${c.value}`;
    case 'volume_anomaly':
      return `${c.tf} volume z-score ≥ ${c.minZ}`;
    case 'smc_event':
      return `${list(c.events.map((e) => SMC_EVENT_LABELS[e]))} on ${list(c.tfs)}`;
    case 'setup_transition':
      return [
        `${c.patterns ? list(c.patterns.map((p) => PATTERN_SHORT[p])) : 'Any pattern'} reaching ${list(c.toStates.map((s) => STATE_TITLE[s].toLowerCase()))}`,
        c.directions ? `, ${list(c.directions)}` : '',
        c.minScore !== undefined ? `, score ≥ ${c.minScore}` : '',
      ].join('');
    case 'spread_threshold':
      return `PAXG spread beyond ${c.absBps} bps`;
    case 'economic_event_upcoming':
      return `${c.minImpact === 'high' ? 'High' : 'Medium or high'}-impact release within ${c.minutesBefore} min`;
    case 'gold_market_session':
      return `Gold market ${c.on.map((o) => (o === 'open' ? 'opens' : 'closes')).join(' or ')}`;
    case 'large_trade':
      return `Large ${c.sides ? list(c.sides) : 'buy or sell'} trade${c.minUsd ? ` of at least $${c.minUsd}` : ''}`;
    case 'wall':
      return `Wall ${list(c.events)}${c.minUsd ? `, at least $${c.minUsd}` : ''}`;
    case 'feed_health':
      return `Feed ${list(c.events)}`;
    case 'practice_order_filled':
      return 'One of your practice orders filled (simulated)';
    case 'practice_exit':
      return `Your practice ${c.on.join(' or ')} sold (simulated)`;
    case 'practice_auto_order':
      return 'Your automatic practice trading placed an order (simulated)';
    case 'practice_auto_paused':
      return 'Your automatic practice trading paused at its daily loss limit (simulated)';
  }
}

/** Where a fired alert goes, in words. */
export function describeDelivery(rule: Pick<AlertRule, 'channels' | 'quietHours'>): string {
  const native = rule.channels
    .filter((c) => c !== 'in_app')
    .map((c) => (c === 'desktop' ? 'desktop' : 'browser'));
  const base = native.length ? `Inbox, ${native.join(' and ')} notifications` : 'Inbox only';
  return rule.quietHours
    ? `${base}; quiet ${rule.quietHours.start}–${rule.quietHours.end} (${rule.quietHours.timeZone})`
    : base;
}
