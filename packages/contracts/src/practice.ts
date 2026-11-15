import { z } from 'zod';
import { PageQuerySchema, TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, VenueSchema } from './market.js';

/**
 * Practice trading (REQUIREMENTS §11, ADR 021): simulated spot orders on practice balances, filled
 * from the venues' live trades and order books. Nothing here reaches an exchange.
 */

/** Broker → api (and the analyzer's alert service): order, fill and account updates, per user. */
export const PRACTICE_EVENTS_STREAM = 'practice:events';
/** Ingestor → broker: every live trade of an instrument, capped. */
export const tradesStream = (instrumentId: string) => `md:trades:${instrumentId}`;

/** The banner every practice screen carries (TRD-06). */
export const PRACTICE_BANNER = 'Practice trading: simulated orders, no real money.';

export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

/** `stop` and `target` are the sells attached to a buy; they cancel each other (one-cancels-other). */
export const PRACTICE_ORDER_TYPES = ['market', 'limit', 'stop', 'target'] as const;
export const PracticeOrderTypeSchema = z.enum(PRACTICE_ORDER_TYPES);
export type PracticeOrderType = z.infer<typeof PracticeOrderTypeSchema>;

/**
 * `new`: accepted by the api, not yet taken up by the broker. `pending`: an attached stop or target
 * waiting for its buy to fill.
 */
export const PRACTICE_ORDER_STATUSES = [
  'new',
  'pending',
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'refused',
] as const;
export const PracticeOrderStatusSchema = z.enum(PRACTICE_ORDER_STATUSES);
export type PracticeOrderStatus = z.infer<typeof PracticeOrderStatusSchema>;

/** Why an order was refused (TRD-07 and the venues' order rules). Shown to the user as the reason. */
export const REFUSAL_REASONS = [
  'data_delayed',
  'data_gap',
  'pair_halted',
  'no_market',
  'insufficient_balance',
  'price_step',
  'quantity_step',
  'min_value',
  'not_practice_pair',
  'too_many_open_orders',
] as const;
export const RefusalReasonSchema = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

/** How each refusal is explained to the user. */
export const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> = {
  data_delayed: 'The pair’s live data is delayed, so the order could not be filled fairly.',
  data_gap: 'The pair’s live data has a gap, so the order could not be filled fairly.',
  pair_halted: 'Trading on the pair is halted or switched off.',
  no_market: 'The order book had nothing to fill the order against.',
  insufficient_balance: 'Not enough practice balance for the order and its fees.',
  price_step: 'A price is not a whole number of the pair’s price steps.',
  quantity_step: 'The quantity is not a whole number of the pair’s quantity steps.',
  min_value: 'The order is worth less than the venue’s minimum order value.',
  not_practice_pair: 'This pair is not available for practice orders.',
  too_many_open_orders: 'The account already has the most open orders allowed (200).',
};

/** Open orders allowed per practice account, attached stops and targets included. */
export const MAX_OPEN_PRACTICE_ORDERS = 200;

export const LiquiditySchema = z.enum(['maker', 'taker']);
/** `thin_book`: the order took a large share of a thin book; `underlying_closed`: PAXG while gold was closed. */
export const FillFlagSchema = z.enum(['thin_book', 'underlying_closed']);
export type FillFlag = z.infer<typeof FillFlagSchema>;

const PositiveDecimalSchema = DecimalSchema.refine((v) => Number(v) > 0, 'must be above zero');

/**
 * `POST /practice/orders`. A market or limit order; a buy may carry a protective `stop` and a
 * `target`, which become sell orders that cancel each other once the buy fills. `clientOrderId`
 * makes a retried submission return the same order.
 */
export const PlacePracticeOrderRequestSchema = z
  .strictObject({
    clientOrderId: z.string().trim().min(8).max(64),
    instrumentId: UuidSchema,
    side: OrderSideSchema,
    type: z.enum(['market', 'limit']),
    quantity: PositiveDecimalSchema,
    limitPrice: PositiveDecimalSchema.optional(),
    stop: PositiveDecimalSchema.optional(),
    target: PositiveDecimalSchema.optional(),
    /** Set when "Practise this setup" filled in the ticket. */
    setupId: UuidSchema.optional(),
  })
  .refine((o) => (o.type === 'limit') === (o.limitPrice !== undefined), {
    message: 'a limit order needs a limit price, and a market order takes none',
    path: ['limitPrice'],
  })
  .refine((o) => o.side === 'buy' || (o.stop === undefined && o.target === undefined), {
    message: 'only a buy can carry a stop or a target',
    path: ['stop'],
  });
export type PlacePracticeOrderRequest = z.infer<typeof PlacePracticeOrderRequestSchema>;

export const PracticeOrderSchema = z.object({
  id: UuidSchema,
  clientOrderId: z.string(),
  venue: VenueSchema,
  instrumentId: UuidSchema,
  side: OrderSideSchema,
  type: PracticeOrderTypeSchema,
  quantity: DecimalSchema,
  limitPrice: DecimalSchema.nullable(),
  stopPrice: DecimalSchema.nullable(),
  filledQuantity: DecimalSchema,
  /** Volume-weighted fill price; null before the first fill. */
  averagePrice: DecimalSchema.nullable(),
  status: PracticeOrderStatusSchema,
  refusalReason: RefusalReasonSchema.nullable(),
  /** The buy a stop or target belongs to, and the pair's shared id. */
  parentId: UuidSchema.nullable(),
  ocoGroup: UuidSchema.nullable(),
  source: z.enum(['manual', 'setup']),
  setupId: UuidSchema.nullable(),
  /** The gold market was closed when a PAXG order was placed. */
  underlyingClosed: z.boolean(),
  createdAt: TsSchema,
  updatedAt: TsSchema,
});
export type PracticeOrder = z.infer<typeof PracticeOrderSchema>;

export const PracticeFillSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  venue: VenueSchema,
  instrumentId: UuidSchema,
  side: OrderSideSchema,
  price: DecimalSchema,
  quantity: DecimalSchema,
  fee: DecimalSchema,
  feeAsset: z.string(),
  liquidity: LiquiditySchema,
  flags: z.array(FillFlagSchema),
  /** What the fill was based on: the book levels it walked, or the trade that went through the price. */
  basis: z.record(z.string(), z.unknown()),
  filledAt: TsSchema,
});
export type PracticeFill = z.infer<typeof PracticeFillSchema>;

export const PracticeBalanceSchema = z.object({
  asset: z.string(),
  /** Free to use. */
  available: DecimalSchema,
  /** Held by open orders. */
  reserved: DecimalSchema,
});
export type PracticeBalance = z.infer<typeof PracticeBalanceSchema>;

/** One practice balance per venue: a Binance balance cannot pay for a Coinbase order. */
export const PracticeAccountSchema = z.object({
  id: UuidSchema,
  venue: VenueSchema,
  /** The starting balances of the current period, by asset. */
  startingBalances: z.record(z.string(), DecimalSchema),
  /** Raised by each reset; history from earlier periods stays visible. */
  resetEpoch: z.number().int().nonnegative(),
  balances: z.array(PracticeBalanceSchema),
});
export type PracticeAccount = z.infer<typeof PracticeAccountSchema>;

/** Fees as fractions of the traded value: "0.001" is 0.1 %. */
export const FeeRatesSchema = z.strictObject({
  maker: DecimalSchema,
  taker: DecimalSchema,
});
export type FeeRates = z.infer<typeof FeeRatesSchema>;

/** `GET /practice/account`: the user's accounts, and the fees practice orders pay on each venue. */
export const PracticeAccountsSchema = z.object({
  accounts: z.array(PracticeAccountSchema),
  fees: z.record(VenueSchema, FeeRatesSchema),
});
export type PracticeAccounts = z.infer<typeof PracticeAccountsSchema>;

/** A holding of one base asset on one venue, valued at the instrument's last price. */
export const PracticePositionSchema = z.object({
  venue: VenueSchema,
  instrumentId: UuidSchema,
  asset: z.string(),
  quantity: DecimalSchema,
  /** Average cost per unit of what is still held, fees included. */
  averageCost: DecimalSchema,
  lastPrice: DecimalSchema.nullable(),
  marketValue: DecimalSchema.nullable(),
  unrealisedPnl: DecimalSchema.nullable(),
  realisedPnl: DecimalSchema,
  fees: DecimalSchema,
});
export type PracticePosition = z.infer<typeof PracticePositionSchema>;

export const PracticeOrdersQuerySchema = PageQuerySchema.extend({
  status: z.enum(['open', 'done', 'all']).default('all'),
  instrumentId: UuidSchema.optional(),
});
export const PracticeFillsQuerySchema = PageQuerySchema.extend({ orderId: UuidSchema.optional() });

export const PracticeResetRequestSchema = z.strictObject({ venue: VenueSchema });

/** Admin settings (`/admin/settings/practice`): fees per venue and the starting balances. */
export const PracticeSettingsSchema = z.strictObject({
  fees: z.record(VenueSchema, FeeRatesSchema),
  startingBalances: z.record(VenueSchema, z.record(z.string(), PositiveDecimalSchema)),
});
export type PracticeSettings = z.infer<typeof PracticeSettingsSchema>;

/**
 * Defaults until an admin changes them (ADR 021), and 10,000 in each venue's quote currency
 * (decision T4). Fees as reported in November 2026 for the lowest tier: Binance spot 0.1 % maker and
 * taker; Coinbase Advanced 0.5 % maker and 0.9 % taker for US accounts since its September 2026
 * schedule. They vary by region and account.
 */
export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  fees: {
    binance: { maker: '0.001', taker: '0.001' },
    coinbase: { maker: '0.005', taker: '0.009' },
    replay: { maker: '0.001', taker: '0.001' },
  },
  startingBalances: {
    binance: { USDT: '10000' },
    coinbase: { USD: '10000' },
    replay: { USDT: '10000', USD: '10000' },
  },
};

/** Messages on the per-user `practice` channel. */
export const PracticeOrderMessageSchema = z.object({ order: PracticeOrderSchema });
export const PracticeFillMessageSchema = z.object({ fill: PracticeFillSchema, order: PracticeOrderSchema });
export const PracticeAccountMessageSchema = z.object({ account: PracticeAccountSchema });
export const PracticeSnapshotSchema = z.object({
  accounts: z.array(PracticeAccountSchema),
  openOrders: z.array(PracticeOrderSchema),
});
export type PracticeSnapshot = z.infer<typeof PracticeSnapshotSchema>;
