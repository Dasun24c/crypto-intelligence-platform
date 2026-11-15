/** A Redis stream entry id as durable channels use it for `seq` (API contracts §5.4): "<ms>-<n>". */
const SEQ = /^\d+-\d+$/;

export function isSeq(value: unknown): value is string {
  return typeof value === 'string' && SEQ.test(value);
}

/** Orders two stream ids, comparing the millisecond and counter parts as numbers. */
export function compareSeq(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('-').map(Number);
  const [bm = 0, bn = 0] = b.split('-').map(Number);
  return am !== bm ? am - bm : an - bn;
}

/** The later of two stream ids; null counts as "nothing yet". */
export function maxSeq(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareSeq(a, b) >= 0 ? a : b;
}
