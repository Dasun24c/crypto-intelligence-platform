import { z } from 'zod';
import { pageSchema, PageQuerySchema, TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, TimeframeSchema, VenueSchema } from './market.js';
import { LevelTypeSchema, PatternSchema, SetupStateSchema, ZoneTypeSchema } from './smc.js';

/**
 * Alerts and notifications (Phase 8; architecture §9, data model §7, API contracts §4 "Alert
 * conditions", ADR 020). A rule belongs to one user; when its condition matches a source event, the
 * analyzer records one alert event per logical occurrence, and the notifications queue puts it in
 * the owner's inbox and pushes it on their `alerts` channel.
 */

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/** Where a fired alert is delivered: the in-app inbox always; desktop and browser notifications if chosen. */
export const NOTIFICATION_CHANNELS = ['in_app', 'desktop', 'web'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const SMC_ALERT_EVENTS = ['sweep', 'false_breakout', 'bos', 'choch', 'mss', 'poi_entry'] as const;
export type SmcAlertEvent = (typeof SMC_ALERT_EVENTS)[number];
export const ALERT_INDICATORS = ['rsi', 'macd_hist', 'volume_z', 'atr'] as const;
export type AlertIndicator = (typeof ALERT_INDICATORS)[number];
export const INDICATOR_OPS = ['>', '<', 'cross_above', 'cross_below'] as const;
export type IndicatorOp = (typeof INDICATOR_OPS)[number];
export const WALL_EVENTS = ['appeared', 'pulled', 'filled'] as const;
export const FEED_HEALTH_EVENTS = ['gap', 'delayed', 'halted', 'delisted', 'disconnected'] as const;
export type FeedHealthEvent = (typeof FEED_HEALTH_EVENTS)[number];

const Direction = z.enum(['bullish', 'bearish']);
const nonEmpty = <T extends z.ZodType>(item: T) => z.array(item).min(1);
/** A positive decimal string (USD amounts, prices). */
const PositiveDecimal = DecimalSchema.refine((v) => Number(v) > 0, 'a positive decimal');

/** The twelve condition kinds (API contracts §4). */
export const AlertConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('price_cross'),
    price: PositiveDecimal,
    direction: z.enum(['above', 'below']),
  }),
  z.strictObject({
    kind: z.literal('price_change_pct'),
    windowMin: z.number().int().min(1).max(1440),
    /** Absolute change, either way. */
    pct: z.number().positive().max(100),
  }),
  z.strictObject({
    kind: z.literal('indicator_threshold'),
    tf: TimeframeSchema,
    indicator: z.enum(ALERT_INDICATORS),
    op: z.enum(INDICATOR_OPS),
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal('volume_anomaly'),
    tf: TimeframeSchema,
    minZ: z.number().positive().max(100),
  }),
  z.strictObject({
    kind: z.literal('smc_event'),
    tfs: nonEmpty(TimeframeSchema),
    events: nonEmpty(z.enum(SMC_ALERT_EVENTS)),
    /** Sweeps and false breakouts: only of these level types. */
    levelTypes: nonEmpty(LevelTypeSchema).optional(),
    /** POI entries: only into these zone types. */
    zoneTypes: nonEmpty(ZoneTypeSchema).optional(),
  }),
  z.strictObject({
    kind: z.literal('setup_transition'),
    patterns: nonEmpty(PatternSchema).optional(),
    directions: nonEmpty(Direction).optional(),
    toStates: nonEmpty(SetupStateSchema),
    minScore: z.number().int().min(0).max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal('spread_threshold'),
    baseAsset: z.literal('PAXG'),
    /** Binance vs Coinbase, in basis points either way. */
    absBps: z.number().positive().max(10_000),
  }),
  z.strictObject({
    kind: z.literal('economic_event_upcoming'),
    minImpact: z.enum(['medium', 'high']),
    minutesBefore: z.number().int().min(1).max(1440),
  }),
  z.strictObject({ kind: z.literal('gold_market_session'), on: nonEmpty(z.enum(['open', 'close'])) }),
  z.strictObject({
    kind: z.literal('large_trade'),
    minUsd: PositiveDecimal.optional(),
    sides: nonEmpty(z.enum(['buy', 'sell'])).optional(),
  }),
  z.strictObject({
    kind: z.literal('wall'),
    minUsd: PositiveDecimal.optional(),
    events: nonEmpty(z.enum(WALL_EVENTS)),
  }),
  z.strictObject({ kind: z.literal('feed_health'), events: nonEmpty(z.enum(FEED_HEALTH_EVENTS)) }),
]);
export type AlertCondition = z.infer<typeof AlertConditionSchema>;
export type AlertConditionKind = AlertCondition['kind'];
export const ALERT_CONDITION_KINDS: readonly AlertConditionKind[] = AlertConditionSchema.options.map(
  (o) => o.shape.kind.value,
);

/** Which instruments and venues a rule watches; absent means all (calendar and gold-session rules ignore it). */
export const AlertScopeSchema = z.strictObject({
  instrumentIds: nonEmpty(UuidSchema).max(100).optional(),
  venues: nonEmpty(VenueSchema).optional(),
});
export type AlertScope = z.infer<typeof AlertScopeSchema>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm, 24-hour');
/**
 * Quiet hours: alerts still reach the inbox, but no desktop or browser notification is shown. The
 * window may cross midnight (22:00–07:00); `days` (0 = Sunday) are the days it starts on.
 */
export const QuietHoursSchema = z
  .strictObject({
    start: HHMM,
    end: HHMM,
    timeZone: z.string().min(1).max(64),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  })
  .refine((q) => q.start !== q.end, { message: 'start and end must differ', path: ['end'] })
  .refine(
    (q) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: q.timeZone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'an IANA time zone', path: ['timeZone'] },
  );
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const AlertRuleSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  name: z.string(),
  enabled: z.boolean(),
  scope: AlertScopeSchema,
  condition: AlertConditionSchema,
  severity: AlertSeveritySchema,
  cooldownSec: z.number().int(),
  channels: z.array(NotificationChannelSchema),
  quietHours: QuietHoursSchema.nullable(),
  version: z.number().int(),
  createdAt: TsSchema,
  updatedAt: TsSchema,
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

const channelsField = nonEmpty(NotificationChannelSchema)
  .refine((c) => c.includes('in_app'), 'the in-app inbox always receives the alert')
  .refine((c) => new Set(c).size === c.length, 'each channel once');

/** `POST /alerts/rules`. */
export const CreateAlertRuleRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  scope: AlertScopeSchema.default({}),
  condition: AlertConditionSchema,
  severity: AlertSeveritySchema.default('info'),
  /** 0 (no cooldown) to 1 day; the same logical occurrence never fires twice regardless. */
  cooldownSec: z.number().int().min(0).max(86_400).default(300),
  channels: channelsField.default(['in_app']),
  quietHours: QuietHoursSchema.nullable().default(null),
});
export type CreateAlertRuleRequest = z.input<typeof CreateAlertRuleRequestSchema>;

/** `PATCH /alerts/rules/{id}`: any field; `version` guards against overwriting a newer edit. */
export const UpdateAlertRuleRequestSchema = z
  .strictObject({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    scope: AlertScopeSchema.optional(),
    condition: AlertConditionSchema.optional(),
    severity: AlertSeveritySchema.optional(),
    cooldownSec: z.number().int().min(0).max(86_400).optional(),
    channels: channelsField.optional(),
    quietHours: QuietHoursSchema.nullable().optional(),
  })
  .refine((r) => Object.keys(r).length > 1, 'nothing to change');
export type UpdateAlertRuleRequest = z.infer<typeof UpdateAlertRuleRequestSchema>;

/** `GET /alerts/rules`: admins may list another user's rules. */
export const AlertRulesQuerySchema = z.strictObject({ ownerId: UuidSchema.optional() });

/** What fired and why; `sourceRefs` points at the stored source (detection, setup, gap, event…). */
export const AlertEventSchema = z.object({
  id: UuidSchema,
  ruleId: UuidSchema,
  ruleName: z.string(),
  firedAt: TsSchema,
  severity: AlertSeveritySchema,
  title: z.string(),
  body: z.string(),
  /** The instrument it concerns, if any. */
  instrumentId: UuidSchema.nullable(),
  sourceRefs: z.record(z.string(), z.unknown()),
  /** Fired by catch-up processing: the source was decided more than 120 s before (rulebook §8 `late_detection`). */
  late: z.boolean(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

/** `GET /alerts/events`. */
export const AlertEventsQuerySchema = PageQuerySchema.extend({ ruleId: UuidSchema.optional() });
export const AlertEventPageSchema = pageSchema(AlertEventSchema);

/** An inbox item. */
export const NotificationSchema = z.object({
  id: UuidSchema,
  event: AlertEventSchema,
  createdAt: TsSchema,
  readAt: TsSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** `GET /notifications`. */
export const NotificationsQuerySchema = PageQuerySchema.extend({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export const NotificationPageSchema = pageSchema(NotificationSchema).extend({
  /** The user's unread count, whatever the page holds. */
  unread: z.number().int().nonnegative(),
});

/** `POST /notifications/read-all`: up to and including `before` (default: now). */
export const ReadAllRequestSchema = z.strictObject({ before: TsSchema.optional() });

/** `POST /alerts/rules/{id}/test?hours=24` (criterion 8.6). */
export const AlertRuleTestQuerySchema = z.strictObject({
  hours: z.coerce.number().int().min(1).max(168).default(24),
});
export const AlertRuleTestResultSchema = z.object({
  ruleId: UuidSchema,
  from: TsSchema,
  to: TsSchema,
  /** Stored source events the rule was evaluated against. */
  evaluated: z.number().int().nonnegative(),
  /** Matches dropped by the rule's cooldown. */
  suppressed: z.number().int().nonnegative(),
  wouldHaveFired: z.array(
    z.object({
      at: TsSchema,
      title: z.string(),
      body: z.string(),
      dedupeKey: z.string(),
      instrumentId: UuidSchema.nullable(),
      sourceRefs: z.record(z.string(), z.unknown()),
    }),
  ),
  /** How the stored history approximates the live source, when it does (prices from 1m candles). */
  note: z.string().nullable(),
});
export type AlertRuleTestResult = z.infer<typeof AlertRuleTestResultSchema>;

/**
 * The user's `alerts` channel (implicit per user; durable, seq = the `alerts:events` entry):
 * `alert.fired` carries the new inbox item and how to present it; `notification.read` tells the
 * user's other devices what was read.
 */
export const AlertFiredMessageSchema = z.object({
  notification: NotificationSchema,
  /** Native notifications the rule asked for (the in-app inbox always gets it). */
  channels: z.array(NotificationChannelSchema),
  /** Inside the rule's quiet hours: inbox only, no native notification. */
  quiet: z.boolean(),
});
export type AlertFiredMessage = z.infer<typeof AlertFiredMessageSchema>;
export const NotificationReadMessageSchema = z.union([
  z.object({ ids: z.array(UuidSchema).min(1) }),
  z.object({ all: z.literal(true), before: TsSchema }),
]);
export type NotificationReadMessage = z.infer<typeof NotificationReadMessageSchema>;
/** The snapshot when the channel cannot be replayed. */
export const AlertsSnapshotSchema = z.object({
  unread: z.number().int().nonnegative(),
  latest: z.array(NotificationSchema),
});
export type AlertsSnapshot = z.infer<typeof AlertsSnapshotSchema>;

/** The BullMQ queue the jobs service delivers notifications from (architecture §6). */
export const NOTIFICATIONS_QUEUE = 'notifications';
/** Redis stream of the users' alert messages (jobs, api → api). */
export const ALERTS_STREAM = 'alerts:events';
