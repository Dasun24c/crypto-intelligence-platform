import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Closure, Timeframe } from '@cip/domain';
import type { EngineConfig } from '../src/engine.js';
import { overlapsClosure, toSteps } from '../src/harness.js';
import { CRYPTO_MAJORS_SMC_PARAMS, GOLD_SMC_PARAMS, type SmcParams } from '../src/params.js';
import type { EngineCandle, SmcEvent, StepContext, StepInput } from '../src/types.js';

/** A golden fixture as stored (rulebook §12). */
export interface Fixture {
  id: string;
  concept: string;
  class: string;
  description: string;
  profile: 'crypto-majors' | 'gold';
  params?: Record<string, unknown>;
  tick?: string;
  source: string;
  /** Per timeframe: `[openTime, open, high, low, close, volume, extra?]`; a hole is a missing candle. */
  candles: Partial<Record<Timeframe, [number, string, string, string, string, string, Extra?][]>>;
  /** `economicEvents: null` is an unavailable calendar (checklist item 8 then fails). */
  context: {
    closures: { from: string; to: string; reason: Closure['reason'] }[];
    economicEvents: { id: string; at: string; currency: string; impact: 'low' | 'medium' | 'high' }[] | null;
  };
  expected: Expectation[];
  notExpected?: Expectation[];
  exhaustive?: Filter[];
  labelledBy: string | null;
  reviewedBy: string | null;
}

interface Extra {
  profile?: number[] | null;
  quality?: 'partial';
}

export interface Filter {
  type: string;
  tf?: Timeframe;
  key?: string;
  data?: Record<string, unknown>;
}

export interface Expectation extends Filter {
  /** ISO time of the deciding candle's close. */
  at?: string;
  /** notExpected: only events decided at or after / at or before these times. */
  after?: string;
  before?: string;
}

const ROOT = new URL('../fixtures/', import.meta.url);

/** Every fixture under packages/smc-engine/fixtures, with its path relative to that folder. */
export function loadFixtures(): { path: string; fixture: Fixture }[] {
  const out: { path: string; fixture: Fixture }[] = [];
  const walk = (dir: URL, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir), `${rel}${name}/`);
      else if (name.endsWith('.json'))
        out.push({ path: `${rel}${name}`, fixture: JSON.parse(readFileSync(url, 'utf8')) as Fixture });
    }
  };
  walk(ROOT, '');
  return out;
}

function merge(base: unknown, over: unknown): unknown {
  if (over && typeof over === 'object' && !Array.isArray(over) && base && typeof base === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
    return out;
  }
  return over;
}

export function fixtureConfig(f: Fixture): EngineConfig {
  const params = f.profile === 'gold' ? GOLD_SMC_PARAMS : CRYPTO_MAJORS_SMC_PARAMS;
  return { params: merge(params, f.params ?? {}) as SmcParams, tick: f.tick ?? '0.01' };
}

export function fixtureInput(f: Fixture): { steps: StepInput[]; context: StepContext } {
  const closures: Closure[] = f.context.closures.map((c) => ({
    startsAt: Date.parse(c.from),
    endsAt: Date.parse(c.to),
    reason: c.reason,
  }));
  const candles: Partial<Record<Timeframe, EngineCandle[]>> = {};
  for (const [tf, rows] of Object.entries(f.candles) as [
    Timeframe,
    NonNullable<Fixture['candles'][Timeframe]>,
  ][])
    candles[tf] = rows.map(([openTime, open, high, low, close, volume, extra]) => ({
      tf,
      openTime,
      open,
      high,
      low,
      close,
      volume,
      quality: extra?.quality ?? 'complete',
      underlyingClosed: overlapsClosure(openTime, tf, closures),
      microProfile: extra?.profile,
    }));
  const economicEvents =
    f.context.economicEvents === null
      ? null
      : f.context.economicEvents.map((e) => ({
          id: e.id,
          scheduledAt: Date.parse(e.at),
          currency: e.currency,
          impact: e.impact,
        }));
  return { steps: toSteps(candles), context: { closures, economicEvents } };
}

/** `{ "$approx": x, "$tol": t }` matches a number within t; ISO strings match epoch-ms numbers. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$approx' in expected) {
    const { $approx, $tol } = expected as { $approx: number; $tol: number };
    return typeof actual === 'number' && Math.abs(actual - $approx) <= $tol;
  }
  if (typeof expected === 'string' && typeof actual === 'number') return Date.parse(expected) === actual;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => matches(actual[i], e))
    );
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  return actual === expected;
}

export function eventMatches(e: SmcEvent, x: Expectation): boolean {
  if (e.type !== x.type) return false;
  if (x.tf !== undefined && e.tf !== x.tf) return false;
  if (x.key !== undefined && e.key !== x.key) return false;
  if (x.at !== undefined && e.time !== Date.parse(x.at)) return false;
  if (x.after !== undefined && e.time < Date.parse(x.after)) return false;
  if (x.before !== undefined && e.time > Date.parse(x.before)) return false;
  return x.data === undefined || matches(e.data, x.data);
}

const show = (e: SmcEvent) =>
  `${new Date(e.time).toISOString()} ${e.tf} ${e.type} ${e.key} ${JSON.stringify(e.data)}`;

/** What the events get wrong against the fixture's labels (empty when they agree). */
export function fixtureProblems(f: Fixture, events: readonly SmcEvent[]): string[] {
  const out: string[] = [];
  for (const x of f.expected)
    if (!events.some((e) => eventMatches(e, x))) out.push(`missing: ${JSON.stringify(x)}`);
  for (const x of f.notExpected ?? [])
    for (const e of events) if (eventMatches(e, x)) out.push(`unexpected: ${show(e)}`);
  for (const filter of f.exhaustive ?? [])
    for (const e of events)
      if (eventMatches(e, filter) && !f.expected.some((x) => eventMatches(e, x)))
        out.push(`not labelled: ${show(e)}`);
  return out;
}
