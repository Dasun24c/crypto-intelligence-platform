import type { AiContext } from '@cip/contracts';

/**
 * Rule V3 (ADR 011): numbers in the text must come from the context. A percentage must be within
 * 0.1 points of a percentage in the context; any other number with 3 or more significant digits
 * within 0.05 % of a number in the context. Counts of 10 or less, timeframes (`15m`, `4h`), dates
 * and times are not checked.
 */
export const PERCENT_TOLERANCE_POINTS = 0.1;
export const NUMBER_TOLERANCE = 0.0005;

/** A number the text states. */
export interface StatedNumber {
  value: number;
  percent: boolean;
  /** As written, for the error message. */
  raw: string;
}

/** Fields that are times (epoch ms) or ids: never compared with what the text says. */
const NOT_NUMBERS = new Set(['asOf', 'at', 'nextChangeAt']);

/** Every number in the context, and the percentages (a share in basis points also counts as its %). */
export function contextNumbers(ctx: AiContext): { numbers: number[]; percents: number[] } {
  const numbers: number[] = [];
  const percents: number[] = [];
  const visit = (value: unknown, key: string): void => {
    if (NOT_NUMBERS.has(key) || key === 'id') return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      numbers.push(Math.abs(value));
      if (/pct$/i.test(key)) percents.push(Math.abs(value));
      if (/bps$/i.test(key)) percents.push(Math.abs(value) / 100);
      return;
    }
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      numbers.push(Math.abs(Number(value)));
      return;
    }
    if (Array.isArray(value)) for (const v of value) visit(v, key);
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
  };
  visit(ctx, '');
  return { numbers, percents };
}

// Dates (2026-11-15), times (14:30, 14:30:05), timeframes (15m, 4h, 1d, 1w), and day-month dates.
const DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/g;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const TIMEFRAME = /\b\d+\s?(?:m|h|d|w|min|mins|minutes?|hours?|days?|weeks?)\b/gi;
const MONTHS =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_MONTH = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\b|\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`,
  'gi',
);
// A number: 65,432.10 or 65432.1 or .5, optionally a percentage.
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(\s?(?:%|percent\b))?/gi;

// A context id cited inline (`lvl:83f21c09`, `ind:1h:rsi`): its digits are not numbers.
const CONTEXT_ID = /\b[a-z]{2,8}:[a-z0-9:._-]+/gi;

/** The numbers a text states, without context ids, dates, times and timeframes. */
export function statedNumbers(text: string): StatedNumber[] {
  const cleaned = text
    .replace(CONTEXT_ID, ' ')
    .replace(DATE, ' ')
    .replace(TIME, ' ')
    .replace(DAY_MONTH, ' ')
    .replace(TIMEFRAME, ' ');
  const out: StatedNumber[] = [];
  for (const m of cleaned.matchAll(NUMBER)) {
    const digits = m[1]!.replace(/,/g, '');
    out.push({ value: Number(digits), percent: m[2] !== undefined, raw: m[0].trim() });
  }
  return out;
}

/** Significant digits as written: 65432.10 → 7, 0.0012 → 2, 1200 → 2. */
export function significantDigits(value: number, raw: string): number {
  const digits = raw.replace(/[^\d.]/g, '');
  const [whole = '', frac = ''] = digits.split('.');
  if (frac) return (whole.replace(/^0+/, '') + frac).replace(/^0+/, '').length;
  return whole.replace(/^0+/, '').replace(/0+$/, '').length || (value === 0 ? 1 : 0);
}

/** Whether a stated number is grounded in the context, or why not (null when it is not checked). */
export function ungrounded(n: StatedNumber, ctx: { numbers: number[]; percents: number[] }): string | null {
  if (n.percent) {
    const ok = ctx.percents.some((p) => Math.abs(p - n.value) <= PERCENT_TOLERANCE_POINTS + 1e-9);
    return ok ? null : `${n.raw} is not a percentage in the context`;
  }
  if (n.value <= 10) return null;
  if (significantDigits(n.value, n.raw) < 3) return null;
  const ok = ctx.numbers.some((c) => Math.abs(c - n.value) <= NUMBER_TOLERANCE * Math.abs(c) + 1e-12);
  return ok ? null : `${n.raw} is not a value in the context`;
}
