import {
  ACTIVITY_PULSES_PER_SEC,
  ACTIVITY_STALE_MS,
  AI_EVENTS_STREAM,
  ALERTS_STREAM,
  ANALYSIS_EVENTS_STREAM,
  type ActivityError,
  type ActivityPulse,
  type ActivityReport,
  type ActivitySnapshot,
  type AiStatus,
  type SystemHealth,
  type VenueLinkState,
} from '@cip/contracts';

/** `alert.fired` entries this recent count in `alerts.firedLastMin`. */
const ALERT_WINDOW_MS = 60_000;
type AiResult = ActivitySnapshot['ai']['lastResult'];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An analysis' status as the brain's last AI result: a reused answer is an accepted one. */
export function aiResultOf(status: AiStatus): NonNullable<AiResult> {
  return status === 'accepted' || status === 'cache_hit'
    ? 'accepted'
    : status === 'rejected'
      ? 'rejected'
      : 'failed';
}

/**
 * System Health as the brain's errors (ADR 024): critical for a dependency down or a service with no
 * live instance; a warning for a degraded service, with what its probe says.
 */
export function errorsOf(health: SystemHealth): ActivityError[] {
  const errors: ActivityError[] = [];
  for (const d of health.dependencies)
    if (d.status === 'down') errors.push({ component: d.name, severity: 'critical', detail: d.detail });
  for (const s of health.services) {
    if (s.status === 'down')
      errors.push({ component: s.service, severity: 'critical', detail: 'no instance is running' });
    else if (s.status === 'degraded') {
      const detail = s.instances.find((i) => i.status === 'degraded')?.detail;
      errors.push({ component: s.service, severity: 'warning', ...(detail ? { detail } : {}) });
    }
  }
  return errors;
}

/**
 * Combines the services' latest reports on `sys:activity` with what the api reads from its other
 * streams into the brain's snapshot (ADR 024). The gateway feeds it; it holds no timers.
 */
export class ActivityAggregator {
  private readonly reports = new Map<string, ActivityReport>();
  private readonly alertTimes: number[] = [];
  private ai: { lastCompletedAt: number | null; lastResult: AiResult } = {
    lastCompletedAt: null,
    lastResult: null,
  };
  private errors: ActivityError[] = [];
  /** When System Health last updated the errors (the gateway refreshes them while anyone watches). */
  errorsAt = -Infinity;

  /** A service instance's second; it replaces that instance's previous one. */
  report(r: ActivityReport): void {
    const key = `${r.service}:${r.instance}`;
    const previous = this.reports.get(key);
    if (!previous || previous.at <= r.at) this.reports.set(key, r);
  }

  alertFired(at: number): void {
    this.alertTimes.push(at);
  }

  /** An AI analysis finished: the latest one is the brain's last result. */
  aiFinished(result: NonNullable<AiResult>, at: number): void {
    if (this.ai.lastCompletedAt === null || at >= this.ai.lastCompletedAt)
      this.ai = { lastCompletedAt: at, lastResult: result };
  }

  health(health: SystemHealth, at: number): void {
    this.errors = errorsOf(health);
    this.errorsAt = at;
  }

  snapshot(now: number): ActivitySnapshot {
    for (const [key, r] of this.reports) if (now - r.at > ACTIVITY_STALE_MS) this.reports.delete(key);
    while (this.alertTimes.length > 0 && now - this.alertTimes[0]! > ALERT_WINDOW_MS) this.alertTimes.shift();

    const perVenue: Record<string, number> = {};
    const venues = new Map<string, VenueLinkState[]>();
    const analysis = { candlesPerSec: 0, activeJobs: 0, backlog: 0, paused: 0 };
    let ingestors = 0;
    let inflight = 0;
    let queued = 0;
    for (const r of this.reports.values()) {
      if (r.ingest) {
        ingestors++;
        for (const [venue, rate] of Object.entries(r.ingest.msgsPerSec))
          perVenue[venue] = round2((perVenue[venue] ?? 0) + rate);
        for (const [venue, state] of Object.entries(r.ingest.venues))
          venues.set(venue, [...(venues.get(venue) ?? []), state]);
      }
      if (r.analysis) {
        // Each analyzer instance analyses its own instruments: they add up.
        analysis.candlesPerSec = round2(analysis.candlesPerSec + r.analysis.candlesPerSec);
        analysis.activeJobs += r.analysis.activeJobs;
        analysis.backlog += r.analysis.backlog;
        analysis.paused += r.analysis.paused;
      }
      if (r.ai) {
        inflight += r.ai.inflight;
        // Every jobs instance sees the same queue.
        queued = Math.max(queued, r.ai.queued);
      }
    }
    // A venue is ingested when some instance holds it and is connected.
    const state: ActivitySnapshot['ingest']['state'] =
      ingestors === 0
        ? 'down'
        : [...venues.values()].every((states) => states.includes('open'))
          ? 'ok'
          : 'degraded';
    return {
      ts: now,
      ingest: {
        msgsPerSec: round2(Object.values(perVenue).reduce((a, b) => a + b, 0)),
        perVenue,
        state,
      },
      analysis,
      ai: { inflight, queued, ...this.ai },
      alerts: { firedLastMin: this.alertTimes.length },
      errors: this.errors,
    };
  }
}

/** Field pairs of a stream entry as a record. */
function fieldsOf(fields: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
  return f;
}

function parse(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * The pulse a stream entry makes, if any (ADR 024): a setup transition (`pattern`), a sweep or an MSS
 * from `an:events`; an accepted AI analysis from `ai:events`; a fired alert from `alerts:events`,
 * which carries only the entry's id (alerts are private).
 */
export function pulseOf(stream: string, seq: string, fields: string[]): ActivityPulse | null {
  const ts = Number(seq.split('-')[0]);
  const f = fieldsOf(fields);
  if (stream === ALERTS_STREAM) return f['type'] === 'alert.fired' ? { ts, kind: 'alert', refId: seq } : null;
  // Only these entries can pulse: nothing else is parsed (indicator points and market events are many).
  const candidate =
    stream === AI_EVENTS_STREAM
      ? f['type'] === 'ai.completed'
      : stream === ANALYSIS_EVENTS_STREAM && (f['type'] === 'setup' || f['type'] === 'smc');
  if (!candidate) return null;
  const data = parse(f['data']);
  if (!data) return null;
  if (stream === AI_EVENTS_STREAM) {
    const analysis = data['analysis'] as Record<string, unknown> | undefined;
    const id = str(analysis?.['id']);
    const instrumentId = str(analysis?.['instrumentId']);
    return id ? { ts, kind: 'ai_completed', refId: id, ...(instrumentId ? { instrumentId } : {}) } : null;
  }
  if (stream !== ANALYSIS_EVENTS_STREAM) return null;
  const instrumentId = str(data['instrumentId']);
  if (!instrumentId) return null;
  if (f['type'] === 'setup') {
    const id = str(data['id']);
    return id ? { ts, kind: 'pattern', refId: id, instrumentId } : null;
  }
  if (f['type'] !== 'smc') return null;
  const inner = data['data'] as Record<string, unknown> | undefined;
  const id = str(inner?.['id']) ?? `${str(data['runId']) ?? ''}:${String(data['seq'])}`;
  if (data['type'] === 'sweep') return { ts, kind: 'sweep', refId: id, instrumentId };
  if (data['type'] === 'structure' && inner?.['type'] === 'mss')
    return { ts, kind: 'mss', refId: id, instrumentId };
  return null;
}

/** What an `ai:events` entry says about the AI's last result, if it is an outcome. */
export function aiOutcomeOf(fields: string[]): NonNullable<AiResult> | null {
  const type = fieldsOf(fields)['type'];
  return type === 'ai.completed'
    ? 'accepted'
    : type === 'ai.rejected'
      ? 'rejected'
      : type === 'ai.failed'
        ? 'failed'
        : null;
}

/** At most ACTIVITY_PULSES_PER_SEC pulses in each second; the rest are counted as dropped. */
export class PulseLimiter {
  private second = -1;
  private sent = 0;
  dropped = 0;

  allow(now: number): boolean {
    const second = Math.floor(now / 1000);
    if (second !== this.second) {
      this.second = second;
      this.sent = 0;
    }
    if (this.sent >= ACTIVITY_PULSES_PER_SEC) {
      this.dropped++;
      return false;
    }
    this.sent++;
    return true;
  }
}
