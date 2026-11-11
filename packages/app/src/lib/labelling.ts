import { z } from 'zod';
import type { Candle, ChartOverlay, Instrument, Tf } from '@cip/contracts';
import { TF_MS } from './analysis.js';

/**
 * Fixture labelling (rulebook §12, development only): an analyst marks which detections a candle
 * window must and must not produce, and exports them as a golden fixture for
 * packages/smc-engine/fixtures/<concept>/<case>.json. A second person reviews the file the same way.
 */

export const CONCEPTS = [
  'swings',
  'structure-bos',
  'structure-choch',
  'structure-mss',
  'displacement',
  'ranges',
  'equal-levels',
  'period-levels',
  'session-levels',
  'weekend-levels',
  'sweeps',
  'false-breakouts',
  'breakouts',
  'thin-book',
  'gold',
] as const;
export const CLASSES = ['bullish', 'bearish', 'negative', 'closure', 'reopening', 'thin_book'] as const;

/** An expected (or forbidden) event, as fixtures state it (packages/smc-engine/test/fixtures.ts). */
export interface Expectation {
  type: string;
  tf?: Tf;
  /** ISO time of the deciding candle's close. */
  at?: string;
  data?: Record<string, unknown>;
}

export type Verdict = 'expected' | 'not_expected';

/** A detection the platform made in the window, or one the analyst added. */
export interface Candidate {
  id: string;
  /** Decision time (epoch ms). */
  at: number;
  summary: string;
  expectation: Expectation;
  manual: boolean;
}

const iso = (t: number) => new Date(t).toISOString();

/** The platform's detections in [from, to) as candidates for labelling. */
export function candidatesFrom(overlay: ChartOverlay, from: number, to: number): Candidate[] {
  const tf = overlay.tf;
  const size = TF_MS[tf];
  const out: Candidate[] = [];
  const add = (id: string, at: number, summary: string, e: Omit<Expectation, 'at'>) => {
    if (at > from && at <= to)
      out.push({ id, at, summary, expectation: { ...e, at: iso(at) }, manual: false });
  };
  for (const s of overlay.swings)
    add(s.id, s.confirmedAt, `${s.level} swing ${s.kind} ${s.price}`, {
      type: 'swing_confirmed',
      tf,
      data: { kind: s.kind, level: s.level, price: s.price, candleTime: iso(s.candleTime) },
    });
  for (const b of overlay.structure)
    add(
      b.id,
      b.breakCandleTime + size,
      `${b.level} ${b.type.toUpperCase()} ${b.direction} through ${b.breakPrice}`,
      {
        type: 'structure',
        tf,
        data: { level: b.level, type: b.type, direction: b.direction, breakPrice: b.breakPrice },
      },
    );
  for (const r of overlay.ranges) {
    add(`${r.id}:detected`, r.detectedAt, `range ${r.low}–${r.high}`, {
      type: 'range_detected',
      tf,
      data: { high: r.high, low: r.low },
    });
    if (r.endedAt !== null && r.endReason !== null)
      add(`${r.id}:ended`, r.endedAt, `range ended: ${r.endReason}`, {
        type: 'range_ended',
        tf,
        data: { reason: r.endReason },
      });
  }
  for (const l of overlay.levels)
    add(l.id, l.knownAt, `${l.type} ${l.price} (${l.tf})`, {
      type: 'level_created',
      tf: l.tf,
      data: { type: l.type, side: l.side, price: l.price },
    });
  for (const w of overlay.sweeps)
    add(w.id, w.confirmedAt, `${w.kind} sweep of ${w.levelType} ${w.levelPrice} to ${w.extremePrice}`, {
      type: 'sweep',
      tf,
      data: {
        kind: w.kind,
        side: w.side,
        levelType: w.levelType,
        levelPrice: w.levelPrice,
        extremePrice: w.extremePrice,
      },
    });
  return out.sort((a, b) => a.at - b.at || a.summary.localeCompare(b.summary));
}

/** What an analyst can add at a candle the platform missed. */
export const MANUAL_KINDS = {
  'swing high (internal)': {
    type: 'swing_confirmed',
    data: { kind: 'high', level: 'internal' },
    onCandle: true,
  },
  'swing low (internal)': {
    type: 'swing_confirmed',
    data: { kind: 'low', level: 'internal' },
    onCandle: true,
  },
  'swing high (external)': {
    type: 'swing_confirmed',
    data: { kind: 'high', level: 'external' },
    onCandle: true,
  },
  'swing low (external)': {
    type: 'swing_confirmed',
    data: { kind: 'low', level: 'external' },
    onCandle: true,
  },
  'BOS bullish': { type: 'structure', data: { type: 'bos', direction: 'bullish' } },
  'BOS bearish': { type: 'structure', data: { type: 'bos', direction: 'bearish' } },
  'CHOCH bullish': { type: 'structure', data: { type: 'choch', direction: 'bullish' } },
  'CHOCH bearish': { type: 'structure', data: { type: 'choch', direction: 'bearish' } },
  'MSS bullish': { type: 'structure', data: { type: 'mss', direction: 'bullish' } },
  'MSS bearish': { type: 'structure', data: { type: 'mss', direction: 'bearish' } },
  'range detected': { type: 'range_detected', data: {} },
  'sweep of buy-side liquidity': { type: 'sweep', data: { side: 'buy_side' } },
  'sweep of sell-side liquidity': { type: 'sweep', data: { side: 'sell_side' } },
} as const satisfies Record<string, { type: string; data: Record<string, unknown>; onCandle?: boolean }>;
export type ManualKind = keyof typeof MANUAL_KINDS;

/**
 * A detection added by hand at the candle opening at `openTime`. A swing is identified by its
 * candle (its confirmation time depends on the swing order); everything else is decided at the
 * candle's close.
 */
export function manualCandidate(kind: ManualKind, tf: Tf, openTime: number, seq: number): Candidate {
  const spec: { type: string; data: Record<string, unknown>; onCandle?: boolean } = MANUAL_KINDS[kind];
  const close = openTime + TF_MS[tf];
  const expectation: Expectation = spec.onCandle
    ? { type: spec.type, tf, data: { ...spec.data, candleTime: iso(openTime) } }
    : { type: spec.type, tf, at: iso(close), data: { ...spec.data } };
  return { id: `manual-${seq}`, at: close, summary: `${kind} (added)`, expectation, manual: true };
}

export interface FixtureMeta {
  id: string;
  concept: (typeof CONCEPTS)[number];
  class: (typeof CLASSES)[number];
  description: string;
  labelledBy: string;
  reviewedBy: string | null;
}

/** A candle as a fixture row: `[openTime, open, high, low, close, volume]`. */
export type CandleRow = [number, string, string, string, string, string];

export interface FixtureFile {
  id: string;
  concept: string;
  class: string;
  description: string;
  profile: 'crypto-majors' | 'gold';
  tick: string;
  source: string;
  candles: Partial<Record<Tf, CandleRow[]>>;
  context: { closures: { from: string; to: string; reason: string }[]; economicEvents: [] };
  expected: Expectation[];
  notExpected: Expectation[];
  labelledBy: string;
  reviewedBy: string | null;
}

/** The rulebook §12 file for a labelled window. */
export function buildFixture(args: {
  meta: FixtureMeta;
  instrument: Pick<Instrument, 'venue' | 'venueSymbol' | 'priceTick' | 'profile'>;
  tf: Tf;
  candles: readonly Candle[];
  closures: readonly { from: number; to: number; reason: string }[];
  candidates: readonly Candidate[];
  verdicts: Readonly<Record<string, Verdict>>;
}): FixtureFile {
  const { meta, instrument, tf, candles } = args;
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) throw new Error('no candles to export');
  const labelled = (v: Verdict) =>
    args.candidates.filter((c) => args.verdicts[c.id] === v).map((c) => c.expectation);
  return {
    id: meta.id,
    concept: meta.concept,
    class: meta.class,
    description: meta.description,
    profile: instrument.profile?.name === 'gold' ? 'gold' : 'crypto-majors',
    tick: instrument.priceTick,
    source: `recorded:${instrument.venue}:${instrument.venueSymbol}:${iso(first.t)}/${iso(last.t + TF_MS[tf])}`,
    candles: { [tf]: candles.map((c): CandleRow => [c.t, c.o, c.h, c.l, c.c, c.v]) },
    context: {
      closures: args.closures.map((c) => ({ from: iso(c.from), to: iso(c.to), reason: c.reason })),
      economicEvents: [],
    },
    expected: labelled('expected'),
    notExpected: labelled('not_expected'),
    labelledBy: meta.labelledBy,
    reviewedBy: meta.reviewedBy,
  };
}

const ExpectationSchema = z.object({
  type: z.string(),
  tf: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional(),
  at: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const FixtureFileSchema = z.object({
  id: z.string().min(1),
  concept: z.string(),
  class: z.string(),
  description: z.string(),
  profile: z.enum(['crypto-majors', 'gold']),
  tick: z.string().optional(),
  source: z.string(),
  candles: z.record(
    z.string(),
    z.array(
      z.tuple([z.number(), z.string(), z.string(), z.string(), z.string(), z.string()]).rest(z.unknown()),
    ),
  ),
  context: z
    .object({ closures: z.array(z.object({ from: z.string(), to: z.string(), reason: z.string() })) })
    .loose(),
  expected: z.array(ExpectationSchema),
  notExpected: z.array(ExpectationSchema).optional(),
  labelledBy: z.string().nullable(),
  reviewedBy: z.string().nullable(),
});

/** A fixture file for review, or the reason it cannot be one. */
export function parseFixture(
  text: string,
): { fixture: z.infer<typeof FixtureFileSchema> } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'The file is not JSON.' };
  }
  const parsed = FixtureFileSchema.safeParse(json);
  if (!parsed.success)
    return {
      error: `Not a fixture: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
    };
  return { fixture: parsed.data };
}

/** A fixture's labels as candidates, so a reviewer sees and can change them. */
export function candidatesOf(fixture: { expected: Expectation[]; notExpected?: Expectation[] }): {
  candidates: Candidate[];
  verdicts: Record<string, Verdict>;
} {
  const candidates: Candidate[] = [];
  const verdicts: Record<string, Verdict> = {};
  const add = (e: Expectation, v: Verdict, i: number) => {
    const id = `${v}-${i}`;
    const at = e.at
      ? Date.parse(e.at)
      : typeof e.data?.candleTime === 'string'
        ? Date.parse(e.data.candleTime)
        : 0;
    candidates.push({
      id,
      at,
      summary: `${e.type} ${JSON.stringify(e.data ?? {})}`,
      expectation: e,
      manual: false,
    });
    verdicts[id] = v;
  };
  fixture.expected.forEach((e, i) => add(e, 'expected', i));
  (fixture.notExpected ?? []).forEach((e, i) => add(e, 'not_expected', i));
  return { candidates: candidates.sort((a, b) => a.at - b.at), verdicts };
}

/** The candles of a fixture file on one timeframe, in the API's shape (for the chart). */
export function candlesOf(fixture: { candles: Record<string, unknown[][]> }, tf: Tf): Candle[] {
  return (fixture.candles[tf] ?? []).map((r) => ({
    t: r[0] as number,
    o: r[1] as string,
    h: r[2] as string,
    l: r[3] as string,
    c: r[4] as string,
    v: r[5] as string,
    qv: '0',
    n: null,
    quality: 'complete',
    underlyingClosed: false,
  }));
}
