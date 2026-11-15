import type {
  FillFlag,
  OrderSide,
  PracticeOrderStatus,
  PracticeOrderType,
  RefusalReason,
} from '@cip/contracts';
import type { DecimalString } from '@cip/domain';

/** The venue's order rules for one instrument. A step or minimum of "0" means none is known. */
export interface InstrumentRules {
  instrumentId: string;
  venue: string;
  base: string;
  quote: string;
  priceTick: DecimalString;
  qtyStep: DecimalString;
  /** The smallest order value in the quote currency. */
  minNotional: DecimalString;
}

/** Fractions of the traded value: "0.001" is 0.1 %. */
export interface FeeRates {
  maker: DecimalString;
  taker: DecimalString;
}

/** Price and quantity, best first: bids descending, asks ascending. */
export type Level = readonly [price: DecimalString, quantity: DecimalString];

/** The latest order book the ingestor keeps for an instrument (`book:{id}`). */
export interface Book {
  instrumentId: string;
  ts: number;
  bids: readonly Level[];
  asks: readonly Level[];
}

/** One live trade from `md:trades:{instrumentId}`. `streamId` orders it against other inputs. */
export interface Trade {
  instrumentId: string;
  /** The venue's trade id. */
  id: string;
  /** The Valkey stream entry id, e.g. "1794591958173-0". */
  streamId: string;
  ts: number;
  price: DecimalString;
  quantity: DecimalString;
}

/** The instrument's market data when an input is processed (TRD-07). Anything but "ok" stops fills. */
export type Health = 'ok' | 'data_delayed' | 'data_gap' | 'pair_halted';

export interface EngineOrder {
  id: string;
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  type: PracticeOrderType;
  /** For a stop or target, the quantity it protects: what its buy has filled, less what was sold. */
  quantity: DecimalString;
  /** Limit orders and targets. */
  limitPrice: DecimalString | null;
  /** Stops. */
  stopPrice: DecimalString | null;
  status: PracticeOrderStatus;
  filled: DecimalString;
  /** Sum of price × quantity over the fills, for the average price. */
  filledValue: DecimalString;
  /** Held for the rest of the order: quote for buys, base for sells (a pair's base is on its target, or its stop). */
  reserved: DecimalString;
  parentId: string | null;
  ocoGroup: string | null;
  /** Trades at or before this stream position were already printed when the order was accepted. */
  acceptedAfterTrade: string;
  /** Arrival order, for time priority. */
  seq: number;
  refusalReason: RefusalReason | null;
  underlyingClosed: boolean;
  /** How many fills it has had, for deterministic fill ids. */
  fillCount: number;
}

/** A reset starts a new period (`epoch`) with `start` entries; earlier periods keep their entries. */
export type LedgerReason = 'start' | 'reserve' | 'release' | 'fill' | 'fee';

/** One change of an available balance. The available balance is the sum of its entries. */
export interface LedgerEntry {
  accountId: string;
  epoch: number;
  asset: string;
  amount: DecimalString;
  reason: LedgerReason;
  orderId: string | null;
  fillId: string | null;
}

export interface EngineFill {
  id: string;
  orderId: string;
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  price: DecimalString;
  quantity: DecimalString;
  fee: DecimalString;
  feeAsset: string;
  liquidity: 'maker' | 'taker';
  flags: FillFlag[];
  basis: Record<string, unknown>;
  at: number;
}

/** What one input changed: the orders as they now are, new fills and ledger entries. */
export interface Outputs {
  orders: EngineOrder[];
  fills: EngineFill[];
  ledger: LedgerEntry[];
}

export interface EngineAccount {
  id: string;
  venue: string;
  epoch: number;
  /** Available balances by asset. */
  available: Record<string, DecimalString>;
  /**
   * The current period's starting balances (Phase 16: the daily loss limit of automatic trading is a
   * share of them). Absent in journals written before Phase 16.
   */
  starting?: Record<string, DecimalString>;
}

/** A new order as the api stored it (status `new`), with its attached stop and target. */
export interface NewOrder {
  id: string;
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  type: 'market' | 'limit';
  quantity: DecimalString;
  limitPrice: DecimalString | null;
  underlyingClosed: boolean;
  stop: { id: string; price: DecimalString } | null;
  target: { id: string; price: DecimalString } | null;
  ocoGroup: string | null;
}

export interface EngineOptions {
  rules: (instrumentId: string) => InstrumentRules | undefined;
  fees: (venue: string) => FeeRates;
  /** A fill's id from its order and its number on that order, so a replay gets the same ids. */
  fillId: (orderId: string, n: number) => string;
  /** Open orders an account may have at once. */
  maxOpenOrders?: number;
}
