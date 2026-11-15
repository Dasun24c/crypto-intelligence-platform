import type {
  AlertConditionKind,
  FeedHealthEvent,
  Impact,
  Instrument,
  LevelType,
  Pattern,
  SetupState,
  SmcAlertEvent,
  Tf,
  ZoneType,
} from '@cip/contracts';

/** The instrument a source concerns, as alert messages name it. */
export interface InstrumentRef {
  id: string;
  venue: Instrument['venue'];
  /** The display name, e.g. "BTC · Binance BTC/USDT". */
  name: string;
}

/** What a source event was decided from, for the `late` label (rulebook §8 `late_detection`). */
interface Decided {
  /** When the deciding candle closed (or the event happened). */
  decidedAt: number;
  /** When it was processed. */
  processedAt: number;
}

/**
 * One normalised source event (ADR 020). The analyzer builds these from tickers, `an:events`,
 * `md:events`, the spread, the calendar and the gold-market sessions; the dry run builds them from
 * stored history. Every `at` is epoch ms.
 */
export type AlertSource =
  | { kind: 'price'; instrument: InstrumentRef; at: number; price: string }
  | ({
      kind: 'indicator';
      instrument: InstrumentRef;
      tf: Tf;
      /** Open time of the closed candle. */
      candleTime: number;
      at: number;
      values: Record<'rsi' | 'macd_hist' | 'volume_z' | 'atr', number | null>;
    } & Decided)
  | ({
      kind: 'smc';
      instrument: InstrumentRef;
      tf: Tf;
      event: SmcAlertEvent;
      /** The detection's id (a sweep, a structure event, or the zone for `poi_entry`). */
      id: string;
      at: number;
      price: string;
      direction: 'bullish' | 'bearish' | null;
      levelType: LevelType | null;
      zoneType: ZoneType | null;
    } & Decided)
  | ({
      kind: 'setup';
      instrument: InstrumentRef;
      tf: Tf;
      setupId: string;
      pattern: Pattern;
      direction: 'bullish' | 'bearish';
      toState: SetupState;
      score: number;
      at: number;
    } & Decided)
  /** `bps`: (Coinbase − Binance) / Binance × 10⁴, as the ingestor stores it. */
  | { kind: 'spread'; baseAsset: 'PAXG'; at: number; bps: number }
  | {
      kind: 'economic_event';
      at: number;
      event: { id: string; title: string; scheduledAt: number; impact: Impact; currency: string };
    }
  | { kind: 'gold_session'; at: number; change: 'open' | 'close'; boundaryAt: number }
  | {
      kind: 'large_trade';
      instrument: InstrumentRef;
      id: string;
      at: number;
      side: 'buy' | 'sell';
      price: string;
      usd: string;
      processedAt: number;
    }
  | {
      kind: 'wall';
      instrument: InstrumentRef;
      id: string;
      at: number;
      event: 'appeared' | 'pulled' | 'filled';
      side: 'bid' | 'ask';
      price: string;
      usd: string;
      processedAt: number;
    }
  | {
      kind: 'feed';
      instrument: InstrumentRef;
      id: string;
      at: number;
      event: FeedHealthEvent;
      detail: string;
      processedAt: number;
    }
  /**
   * One of a user's practice orders (ADR 021): a buy or sell that ended with fills (`order_done`), a
   * stop or target that sold, or a buy their automatic practice trading placed (`auto_placed`, ADR
   * 022: what it placed, at its limit price). Only the order's owner's rules may match it.
   */
  | {
      kind: 'practice';
      userId: string;
      instrument: InstrumentRef;
      at: number;
      event: 'order_done' | 'stop_filled' | 'target_filled' | 'auto_placed';
      orderId: string;
      side: 'buy' | 'sell';
      /** What it filled, and at what average price. */
      quantity: string;
      price: string;
      /** When the analyzer read it: a fill read long after (a catch-up) is labelled late. */
      processedAt: number;
    }
  /**
   * A user's automatic practice trading paused at their daily loss limit (ADR 022), until `until`
   * (00:00 UTC). Only its owner's rules may match it.
   */
  | {
      kind: 'practice_pause';
      userId: string;
      at: number;
      until: number;
      /** The day's result of its closed trades, in `asset`. */
      result: string;
      asset: string;
      processedAt: number;
    };

export type AlertSourceKind = AlertSource['kind'];

/** Which source each condition kind reads. */
export const SOURCE_OF: Readonly<Record<AlertConditionKind, AlertSourceKind>> = {
  price_cross: 'price',
  price_change_pct: 'price',
  indicator_threshold: 'indicator',
  volume_anomaly: 'indicator',
  smc_event: 'smc',
  setup_transition: 'setup',
  spread_threshold: 'spread',
  economic_event_upcoming: 'economic_event',
  gold_market_session: 'gold_session',
  large_trade: 'large_trade',
  wall: 'wall',
  feed_health: 'feed',
  practice_order_filled: 'practice',
  practice_exit: 'practice',
  practice_auto_order: 'practice',
  practice_auto_paused: 'practice_pause',
};

/** Rulebook §8 `late_detection`: processed more than 120 s after the deciding candle closed. */
export const LATE_AFTER_MS = 120_000;

/** Whether the source was decided by catch-up processing (criterion 8.5). */
export function isLate(source: AlertSource): boolean {
  switch (source.kind) {
    case 'indicator':
    case 'smc':
    case 'setup':
      return source.processedAt - source.decidedAt > LATE_AFTER_MS;
    case 'large_trade':
    case 'wall':
    case 'feed':
    case 'practice':
    case 'practice_pause':
      return source.processedAt - source.at > LATE_AFTER_MS;
    default:
      // Tickers, the spread and the clock are evaluated as they happen.
      return false;
  }
}
