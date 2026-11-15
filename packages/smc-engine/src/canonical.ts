import type { SmcEvent } from './types.js';

/**
 * JSON with object keys sorted, so equal values always give equal text whatever their key order
 * (PostgreSQL's jsonb reorders keys). Numbers use JavaScript's shortest round-trip form, which
 * jsonb keeps exactly; −0 becomes 0 and is never emitted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`cannot serialise ${typeof value}`);
  }
}

/** What `analysis.detection_events.payload` holds: the entity's natural key and the event data. */
export interface StoredPayload {
  key: string;
  data: SmcEvent['data'];
}

export const storedPayload = (e: SmcEvent): StoredPayload => ({ key: e.key, data: e.data });

/**
 * One event's line in a run digest: everything the engine decided, nothing that depends on the run
 * (ids, the warm-up and late flags). sha256 over the lines of a period, in `seq` order, is the
 * digest that a replay must reproduce (ADR 004, criterion 4.3).
 */
export function digestLine(e: {
  seq: number;
  type: string;
  tf: string;
  time: number;
  key: string;
  data: unknown;
}): string {
  return `${e.seq}|${e.type}|${e.tf}|${e.time}|${e.key}|${canonicalJson(e.data)}\n`;
}
