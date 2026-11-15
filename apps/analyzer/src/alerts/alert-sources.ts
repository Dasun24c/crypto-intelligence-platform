import type { AlertSource, InstrumentRef } from '@cip/alerts';
import type {
  FeedStatusEvent,
  GapOpenedEvent,
  IndicatorPoint,
  LargeTrade,
  SetupTransitionMessage,
  SmcEventMessage,
  StructureEvent,
  Sweep,
  Tf,
  Wall,
  ZoneStatusChange,
} from '@cip/contracts';
import { TF_MS } from '@cip/domain';

/**
 * Turns what the analyzer published, what the ingestor and jobs put on `md:events`, and tickers into
 * the alert evaluator's sources (ADR 020). Anything a rule cannot match becomes nothing.
 */

/** What an actor published, handed to the alert service right after (never warm-up or replays). */
export type Published =
  | { kind: 'indicators'; tf: Tf; point: IndicatorPoint }
  | { kind: 'smc'; message: SmcEventMessage }
  | { kind: 'setup'; message: SetupTransitionMessage };

/** A zone's type, direction and proximal edge, for `poi_entry` (the `zone.status` message has neither). */
export interface ZoneFacts {
  type: 'order_block' | 'fvg' | 'supply' | 'demand';
  direction: 'bullish' | 'bearish';
  top: string;
  bottom: string;
}

export function fromIndicator(
  instrument: InstrumentRef,
  tf: Tf,
  point: IndicatorPoint,
  processedAt: number,
): AlertSource {
  const closedAt = point.t + TF_MS[tf];
  return {
    kind: 'indicator',
    instrument,
    tf,
    candleTime: point.t,
    at: closedAt,
    values: { rsi: point.rsi, macd_hist: point.macdHist, volume_z: point.volumeZ, atr: point.atr },
    decidedAt: closedAt,
    processedAt,
  };
}

/** The SMC detections rules can name: sweeps, false breakouts, structure breaks and first touches of a zone. */
export function fromSmc(
  instrument: InstrumentRef,
  m: SmcEventMessage,
  processedAt: number,
  zone: (id: string) => ZoneFacts | null,
): AlertSource | null {
  const base = {
    kind: 'smc' as const,
    instrument,
    tf: m.tf as Tf,
    at: m.time,
    decidedAt: m.time,
    processedAt,
  };
  switch (m.type) {
    case 'sweep': {
      const s = m.data as Sweep;
      return {
        ...base,
        event: s.kind === 'false_breakout' ? 'false_breakout' : 'sweep',
        id: s.id,
        price: s.levelPrice,
        direction: null,
        levelType: s.levelType,
        zoneType: null,
      };
    }
    case 'structure': {
      const s = m.data as StructureEvent;
      return {
        ...base,
        event: s.type,
        id: s.id,
        price: s.breakPrice,
        direction: s.direction,
        levelType: null,
        zoneType: null,
      };
    }
    case 'zone.status': {
      const z = m.data as ZoneStatusChange;
      // A first touch: the zone was touched by the very candle that decided this message.
      if (z.firstTouchAt !== m.time) return null;
      const facts = zone(z.id);
      if (!facts) return null;
      return {
        ...base,
        event: 'poi_entry',
        id: z.id,
        // Bullish zones are approached from above (their top is proximal), bearish ones from below.
        price: facts.direction === 'bullish' ? facts.top : facts.bottom,
        direction: facts.direction,
        levelType: null,
        zoneType: facts.type,
      };
    }
    default:
      return null;
  }
}

export function fromSetup(instrument: InstrumentRef, m: SetupTransitionMessage): AlertSource {
  return {
    kind: 'setup',
    instrument,
    tf: m.setupTf,
    setupId: m.id,
    pattern: m.pattern,
    direction: m.direction,
    toState: m.transition.to,
    score: m.score,
    at: m.transition.decidedAt,
    decidedAt: m.transition.decidedAt,
    processedAt: m.transition.processedAt,
  };
}

/** One `md:events` entry (its stream id names the occurrence for events that carry no id of their own). */
export function fromMarketEvent(
  entryId: string,
  type: string,
  data: unknown,
  ref: (instrumentId: string) => InstrumentRef | null,
  processedAt: number,
): AlertSource | null {
  // The stream id's first part is when the entry was written (ms).
  const written = Number(entryId.split('-')[0]);
  switch (type) {
    case 'gap.opened': {
      const g = data as GapOpenedEvent;
      const instrument = ref(g.instrumentId);
      if (!instrument) return null;
      return {
        kind: 'feed',
        instrument,
        id: g.gapId,
        at: written,
        event: 'gap',
        detail: `Missing ${g.stream} data from ${new Date(g.from).toISOString().slice(0, 16).replace('T', ' ')} UTC (${g.detectedBy}).`,
        processedAt,
      };
    }
    case 'feed.status': {
      const f = data as FeedStatusEvent;
      const instrument = ref(f.instrumentId);
      if (!instrument) return null;
      // The pair-status job reports halts and delistings in `detail`; the ingestor reports its feed.
      const event =
        f.detail === 'halted' || f.detail === 'delisted'
          ? f.detail
          : f.state === 'disconnected'
            ? 'disconnected'
            : f.state === 'degraded'
              ? 'delayed'
              : null;
      if (!event) return null;
      return {
        kind: 'feed',
        instrument,
        id: `md:${entryId}`,
        at: written,
        event,
        detail: `${instrument.name}: ${f.stream} feed ${f.detail} (was ${f.previous}).`,
        processedAt,
      };
    }
    case 'trade.large': {
      const t = data as LargeTrade;
      const instrument = ref(t.instrumentId);
      if (!instrument) return null;
      return {
        kind: 'large_trade',
        instrument,
        id: t.id,
        at: t.ts,
        side: t.takerSide,
        price: t.avgPrice,
        usd: t.notionalUsd,
        processedAt,
      };
    }
    case 'wall.appeared':
    case 'wall.ended': {
      const w = data as Wall;
      const instrument = ref(w.instrumentId);
      const event = type === 'wall.appeared' ? 'appeared' : w.endedReason;
      if (!instrument || (event !== 'appeared' && event !== 'pulled' && event !== 'filled')) return null;
      return {
        kind: 'wall',
        instrument,
        id: w.id,
        at: event === 'appeared' ? w.firstSeen : w.lastSeen,
        event,
        side: w.side,
        price: w.price,
        usd: w.maxNotionalUsd,
        processedAt,
      };
    }
    default:
      return null;
  }
}
