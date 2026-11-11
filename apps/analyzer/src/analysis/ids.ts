import { createHash } from 'node:crypto';

/**
 * The UUID of an SMC entity in a run: UUIDv7-shaped (data model §1: time-ordered), but derived
 * rather than random, so a restart or a second writer produces the same id for the same detection.
 *
 * - The 48-bit timestamp is the time the natural key ends with (every engine key does: the swing
 *   candle, the break candle, the level's knownAt, …).
 * - The remaining 74 bits come from sha256(runId, key): the same detection in another run (a
 *   replay) gets another id, while the natural key, which the digest uses, stays the same.
 */
export function entityId(runId: string, key: string): string {
  const time = Number(key.slice(key.lastIndexOf(':') + 1));
  if (!Number.isSafeInteger(time) || time < 0) throw new RangeError(`key ${key} does not end with a time`);
  const h = createHash('sha256').update(runId).update('\n').update(key).digest();
  const b = Buffer.alloc(16);
  b.writeUIntBE(time, 0, 6);
  b[6] = 0x70 | (h[0]! & 0x0f); // version 7
  b[7] = h[1]!;
  b[8] = 0x80 | (h[2]! & 0x3f); // variant 10
  h.copy(b, 9, 3, 10);
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
