import type { VenueId } from '@cip/domain';
import { parseBinanceDepthSnapshot, parseBinanceMessage } from '../binance/parse.js';
import { parseCoinbaseMessage } from '../coinbase/parse.js';
import type { MarketEvent, Unparsed } from '../events.js';

/** One line of a recording made by tools/recorder (JSON Lines). */
export interface RecordedLine {
  t: number;
  venue: VenueId;
  kind: 'ws' | 'rest';
  path?: string;
  data: unknown;
}

export function parseRecording(jsonl: string): RecordedLine[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RecordedLine);
}

const DEPTH_PATH = /^\/api\/v3\/depth\?symbol=([A-Z0-9]+)/;

/**
 * Turns recorded lines into normalised events with the same parsers the live adapters use, so the
 * replay venue and the contract tests exercise exactly the production parsing (architecture §1.4).
 */
export function replayEvents(lines: readonly RecordedLine[]): {
  events: MarketEvent[];
  unparsed: Unparsed[];
} {
  const events: MarketEvent[] = [];
  const unparsed: Unparsed[] = [];
  for (const line of lines) {
    let result;
    if (line.kind === 'rest') {
      const symbol = DEPTH_PATH.exec(line.path ?? '')?.[1];
      result = symbol ? parseBinanceDepthSnapshot(symbol, line.data, line.t) : null;
    } else if (line.venue === 'binance') {
      result = parseBinanceMessage(line.data, line.t);
    } else if (line.venue === 'coinbase') {
      result = parseCoinbaseMessage(line.data, line.t);
    } else {
      result = null;
    }
    if (!result) continue;
    if (result.type === 'unparsed') unparsed.push(result);
    else events.push(result);
  }
  return { events, unparsed };
}
