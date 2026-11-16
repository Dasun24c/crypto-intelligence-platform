import { z } from 'zod';
import { TsSchema } from './common.js';

/**
 * System activity for the 3D brain (Phase 10; architecture §12, API contracts §5.3, ADR 024). Every
 * service instance appends a report a second to `sys:activity`, saying what it did during that
 * second; the api combines the latest reports into `activity.snapshot` on `system:activity`, and
 * sends `activity.pulse` at once for detections, accepted AI analyses and fired alerts.
 */

/** The Redis stream the services report to (never replayed to clients). */
export const ACTIVITY_STREAM = 'sys:activity';
/** How often each service instance reports. */
export const ACTIVITY_REPORT_MS = 1_000;
/** A report older than this no longer counts: a stopped instance contributes nothing. */
export const ACTIVITY_STALE_MS = 5_000;
/** How often the api sends a snapshot while anyone is subscribed (≤ 4 Hz, API contracts §5.3). */
export const ACTIVITY_SNAPSHOT_MS = 500;
/** Without a snapshot for this long, the brain shows "Disconnected" (architecture §12). */
export const ACTIVITY_SILENT_MS = 3_000;
/** At most this many pulses a second leave one api instance; the rest are dropped and counted. */
export const ACTIVITY_PULSES_PER_SEC = 20;

const Count = z.number().int().nonnegative();
const Rate = z.number().nonnegative().finite();

/** A venue's connection as the ingestor instance sees it; `standby` where another instance holds its lease. */
export const VENUE_LINK_STATES = ['open', 'connecting', 'closed', 'standby'] as const;
export type VenueLinkState = (typeof VENUE_LINK_STATES)[number];

export const ACTIVITY_SERVICES = ['ingestor', 'analyzer', 'jobs'] as const;
export type ActivityService = (typeof ACTIVITY_SERVICES)[number];

export const IngestActivitySchema = z.object({
  /** Venue messages processed during the second, per venue. */
  msgsPerSec: z.record(z.string(), Rate),
  venues: z.record(z.string(), z.enum(VENUE_LINK_STATES)),
});
export const AnalysisActivitySchema = z.object({
  /** Candle boundaries analysed during the second. */
  candlesPerSec: Rate,
  /**
   * Instruments that analysed at least one candle boundary during the second (a step takes
   * milliseconds, so a sample at the second's end would miss it; a wake-up that finds nothing due is
   * not counted).
   */
  activeJobs: Count,
  /** Instruments with a wake-up waiting behind the step in progress. */
  backlog: Count,
  /** Instruments whose analysis is held back (warming up, or paused on a data gap). */
  paused: Count,
});
export type AnalysisActivity = z.infer<typeof AnalysisActivitySchema>;
export const AiActivitySchema = z.object({
  /** The most AI calls in progress at once during the second. */
  inflight: Count,
  /** AI jobs waiting in the queue. */
  queued: Count,
});

/** One service instance's second, appended to `sys:activity` (`type` `activity`, `data` this JSON). */
export const ActivityReportSchema = z.object({
  service: z.enum(ACTIVITY_SERVICES),
  instance: z.string().min(1).max(200),
  /** When the second it describes ended (epoch ms). */
  at: TsSchema,
  ingest: IngestActivitySchema.optional(),
  analysis: AnalysisActivitySchema.optional(),
  ai: AiActivitySchema.optional(),
});
export type ActivityReport = z.infer<typeof ActivityReportSchema>;
/** What a service supplies each second; `runService` adds who and when. */
export type ActivityCounters = Omit<ActivityReport, 'service' | 'instance' | 'at'>;

export const ACTIVITY_ERROR_SEVERITIES = ['warning', 'critical'] as const;
export const ActivityErrorSchema = z.object({
  /** `database`, `redis`, or a service: `api`, `ingestor`, `analyzer`, `jobs`, `broker`. */
  component: z.string(),
  severity: z.enum(ACTIVITY_ERROR_SEVERITIES),
  /** As implemented in Phase 10: what System Health says about it. */
  detail: z.string().optional(),
});
export type ActivityError = z.infer<typeof ActivityErrorSchema>;

export const AI_RESULTS = ['accepted', 'rejected', 'failed'] as const;

/** `activity.snapshot` on `system:activity` (API contracts §5.3). */
export const ActivitySnapshotSchema = z.object({
  ts: TsSchema,
  ingest: z.object({
    msgsPerSec: Rate,
    perVenue: z.record(z.string(), Rate),
    state: z.enum(['ok', 'degraded', 'down']),
  }),
  analysis: AnalysisActivitySchema,
  ai: z.object({
    inflight: Count,
    queued: Count,
    lastCompletedAt: TsSchema.nullable(),
    lastResult: z.enum(AI_RESULTS).nullable(),
  }),
  alerts: z.object({ firedLastMin: Count }),
  errors: z.array(ActivityErrorSchema),
});
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;

export const ACTIVITY_PULSE_KINDS = ['pattern', 'sweep', 'mss', 'ai_completed', 'alert'] as const;
export type ActivityPulseKind = (typeof ACTIVITY_PULSE_KINDS)[number];

/**
 * `activity.pulse` on `system:activity`: a setup transition (`pattern`), a sweep, an MSS, an accepted
 * AI analysis, or a fired alert. Alerts are private: an alert's pulse carries only the stream
 * entry's id.
 */
export const ActivityPulseSchema = z.object({
  ts: TsSchema,
  kind: z.enum(ACTIVITY_PULSE_KINDS),
  refId: z.string(),
  instrumentId: z.string().optional(),
});
export type ActivityPulse = z.infer<typeof ActivityPulseSchema>;

/** Nothing reported yet: what the api sends before the first report arrives. */
export function emptyActivitySnapshot(ts: number): ActivitySnapshot {
  return {
    ts,
    ingest: { msgsPerSec: 0, perVenue: {}, state: 'down' },
    analysis: { candlesPerSec: 0, activeJobs: 0, backlog: 0, paused: 0 },
    ai: { inflight: 0, queued: 0, lastCompletedAt: null, lastResult: null },
    alerts: { firedLastMin: 0 },
    errors: [],
  };
}
