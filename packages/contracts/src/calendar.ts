import { z } from 'zod';
import { TsSchema, UuidSchema } from './common.js';

// ---------------------------------------------------------------------------------------------
// The economic calendar (Phase 7; feasibility §6.1, data model §4, rulebook §7 item 8 and I38)
// ---------------------------------------------------------------------------------------------

/**
 * The scheduled US releases the platform tracks: CPI and the Employment Situation (BLS dates via
 * FRED), GDP and Personal Income and Outlays (BEA, with times; FRED as the fallback), and FOMC
 * statements (entered by an admin).
 */
export const ECONOMIC_RELEASES = [
  'cpi',
  'employment_situation',
  'gdp',
  'personal_income_outlays',
  'fomc',
] as const;
export const EconomicReleaseSchema = z.enum(ECONOMIC_RELEASES);
export type EconomicRelease = z.infer<typeof EconomicReleaseSchema>;

export const IMPACTS = ['low', 'medium', 'high'] as const;
export const ImpactSchema = z.enum(IMPACTS);
export type Impact = z.infer<typeof ImpactSchema>;

export const ECONOMIC_CATEGORIES = ['inflation', 'employment', 'growth', 'central_bank', 'other'] as const;
export const EconomicCategorySchema = z.enum(ECONOMIC_CATEGORIES);
export type EconomicCategory = z.infer<typeof EconomicCategorySchema>;

/** Where an event comes from: a synced source or an admin's entry. */
export const CALENDAR_SOURCES = ['fred', 'bea', 'manual'] as const;
export const CalendarSourceSchema = z.enum(CALENDAR_SOURCES);
export type CalendarSource = z.infer<typeof CalendarSourceSchema>;

/** The sources the calendar syncs from. */
export const SYNCED_SOURCES = ['fred', 'bea'] as const;
export const SyncedSourceSchema = z.enum(SYNCED_SOURCES);
export type SyncedSource = z.infer<typeof SyncedSourceSchema>;

/** `GET /calendar/events` items (API contracts §4). */
export const EconomicEventSchema = z.object({
  id: UuidSchema,
  source: CalendarSourceSchema,
  /** The source's own reference, e.g. `fred:10:2026-12-10` or a BEA release id. */
  sourceRef: z.string(),
  release: EconomicReleaseSchema.nullable(),
  title: z.string(),
  country: z.string(),
  currency: z.string(),
  category: EconomicCategorySchema,
  impact: ImpactSchema,
  scheduledAt: TsSchema,
  /** False when only the date is published and the time is the release's standard one. */
  timeConfirmed: z.boolean(),
  actual: z.string().nullable(),
  forecast: z.string().nullable(),
  previous: z.string().nullable(),
  updatedAt: TsSchema,
});
export type EconomicEvent = z.infer<typeof EconomicEventSchema>;

const ms = z.coerce.number().int().nonnegative();

/** `GET /calendar/events?from&to&minImpact`: by default the last day and the next 60. */
export const CalendarEventsQuerySchema = z
  .strictObject({ from: ms.optional(), to: ms.optional(), minImpact: ImpactSchema.optional() })
  .refine((v) => v.from === undefined || v.to === undefined || v.to > v.from, {
    message: 'to must be after from',
    path: ['to'],
  });
export type CalendarEventsQuery = z.infer<typeof CalendarEventsQuerySchema>;

/** The widest window one `GET /calendar/events` may cover. */
export const CALENDAR_MAX_WINDOW_MS = 400 * 86_400_000;

const Currency = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 currency code');
const Country = z.string().regex(/^[A-Z]{2}$/, 'an ISO 3166 country code');
const Title = z.string().trim().min(1).max(120);

/** `POST /calendar/events`: a manual entry, for example an FOMC statement (admins). */
export const CreateEconomicEventRequestSchema = z.strictObject({
  release: EconomicReleaseSchema.nullable().default(null),
  title: Title,
  category: EconomicCategorySchema,
  impact: ImpactSchema,
  scheduledAt: TsSchema,
  timeConfirmed: z.boolean(),
  currency: Currency.default('USD'),
  country: Country.default('US'),
});
export type CreateEconomicEventRequest = z.infer<typeof CreateEconomicEventRequestSchema>;

/** `PATCH /calendar/events/{id}`: manual entries only; synced ones follow their source. */
export const UpdateEconomicEventRequestSchema = z
  .strictObject({
    release: EconomicReleaseSchema.nullable().optional(),
    title: Title.optional(),
    category: EconomicCategorySchema.optional(),
    impact: ImpactSchema.optional(),
    scheduledAt: TsSchema.optional(),
    timeConfirmed: z.boolean().optional(),
    currency: Currency.optional(),
    country: Country.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateEconomicEventRequest = z.infer<typeof UpdateEconomicEventRequestSchema>;

export const CALENDAR_SYNC_STATUSES = ['running', 'ok', 'failed', 'skipped'] as const;

/** One sync attempt of one source. `skipped`: the source is not configured (no FRED key). */
export const CalendarSyncSchema = z.object({
  source: SyncedSourceSchema,
  startedAt: TsSchema,
  finishedAt: TsSchema.nullable(),
  status: z.enum(CALENDAR_SYNC_STATUSES),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type CalendarSync = z.infer<typeof CalendarSyncSchema>;

/** A profile's news blackout around high-impact events (rulebook §7 item 8). */
export const BlackoutWindowSchema = z.object({
  profile: z.string(),
  version: z.number().int(),
  beforeMin: z.number().int().nonnegative(),
  afterMin: z.number().int().nonnegative(),
  currencies: z.array(z.string()),
  instrumentIds: z.array(UuidSchema),
});
export type BlackoutWindow = z.infer<typeof BlackoutWindowSchema>;

/** `GET /calendar/status`: whether checklist item 8 can use the calendar, and why not. */
export const CalendarStatusSchema = z.object({
  /** Available from the first complete FRED sync on (rulebook I38); until then item 8 fails safe. */
  available: z.boolean(),
  availableFrom: TsSchema.nullable(),
  status: z.enum(['ok', 'degraded', 'down']),
  detail: z.string(),
  sources: z.array(
    z.object({
      source: SyncedSourceSchema,
      configured: z.boolean(),
      lastSync: CalendarSyncSchema.nullable(),
      lastSuccessAt: TsSchema.nullable(),
    }),
  ),
  blackouts: z.array(BlackoutWindowSchema),
});
export type CalendarStatus = z.infer<typeof CalendarStatusSchema>;

/** `calendar.updated` on the `calendar` channel: reload the calendar. */
export const CalendarUpdatedSchema = z.object({
  at: TsSchema,
  reason: z.enum(['sync', 'manual']),
  changed: z.number().int().nonnegative(),
});
export type CalendarUpdated = z.infer<typeof CalendarUpdatedSchema>;

/** The jobs service's maintenance task that syncs the calendar; `POST /calendar/sync` queues it. */
export const CALENDAR_SYNC_JOB = 'calendar.sync';
