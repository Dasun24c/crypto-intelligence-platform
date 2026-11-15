import { z } from 'zod';
import { PageQuerySchema, TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, VenueSchema } from './market.js';
import { PatternSchema } from './smc.js';
import { PATTERN_NAMES } from './smc-params.js';

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
    /** Any key but one starting `auto:`, which automatic orders use (ADR 022). */
    clientOrderId: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .refine((k) => !k.startsWith('auto:'), 'keys starting "auto:" are kept for automatic orders'),
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
  /** `auto`: placed by the user's automatic practice trading (Phase 16, ADR 022). */
  source: z.enum(['manual', 'setup', 'auto']),
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

// ---------------------------------------------------------------------------------------------
// Automatic practice trading (Phase 16, REQUIREMENTS §11 revision 5, ADR 022)
// ---------------------------------------------------------------------------------------------

/**
 * A user's rules for automatic practice trading. On a confirmed bullish setup that matches them it
 * places a practice limit buy at the entry, with a stop at the invalidation and a target at target 1,
 * sized at `riskPct` of the free quote balance. Practice balances only; the AI never decides.
 */
export const AutoRulesSchema = z.strictObject({
  /** The practice account it trades. */
  venue: VenueSchema,
  /** The pairs it may trade; empty: every monitored pair on the venue. */
  instrumentIds: z.array(UuidSchema).max(50),
  patterns: z.array(PatternSchema).min(1),
  /** The setup's checklist score, 0–100. */
  minScore: z.number().min(0).max(100),
  /** Target 1's distance over the stop's, at least. */
  minReward: z.number().min(0.5).max(10),
  /** Percent of the free quote balance put at risk per trade. */
  riskPct: z.number().min(0.1).max(2),
  maxOpenTrades: z.number().int().min(1).max(10),
  maxOrdersPerDay: z.number().int().min(1).max(50),
  /** Percent of the period's starting quote balance lost in a UTC day before it pauses until 00:00. */
  dailyLossPct: z.number().min(1).max(10),
});
export type AutoRules = z.infer<typeof AutoRulesSchema>;

/** Proposal 002's recommended defaults (decisions A4 and A5). */
export const DEFAULT_AUTO_RULES: AutoRules = {
  venue: 'binance',
  instrumentIds: [],
  patterns: [...PATTERN_NAMES],
  minScore: 70,
  minReward: 2,
  riskPct: 1,
  maxOpenTrades: 3,
  maxOrdersPerDay: 10,
  dailyLossPct: 3,
};

/** Why a confirmed setup was not traded (ADR 022, checked in this order). */
export const AUTO_SKIP_REASONS = [
  'paused',
  'pair',
  'pattern',
  'not_live',
  'data_gap',
  'score',
  'reward',
  'open_limit',
  'daily_orders',
  'size',
  'balance',
] as const;
export const AutoSkipReasonSchema = z.enum(AUTO_SKIP_REASONS);
export type AutoSkipReason = z.infer<typeof AutoSkipReasonSchema>;

export const AUTO_SKIP_TEXT: Readonly<Record<AutoSkipReason, string>> = {
  paused: 'Paused for the day: the daily loss limit was reached.',
  pair: 'Not one of the pairs in your rules.',
  pattern: 'Not one of the patterns in your rules.',
  not_live:
    'Not a live decision: found while the analysis was warming up or catching up, or a mandatory checklist item failed.',
  data_gap: 'The setup was decided over a gap in the market data.',
  score: 'Its checklist score is below your minimum.',
  reward: 'Its reward for the risk at target 1 is below your minimum, or its levels are incomplete.',
  open_limit: 'Already at your limit of open automatic trades, or one is open on this pair.',
  daily_orders: 'Already at your limit of automatic orders today.',
  size: 'At your risk per trade, the quantity is too small for the pair.',
  balance: 'Not enough free practice balance for the order and its fees.',
};

/**
 * `placed`; `skipped` with an AUTO_SKIP_REASONS reason; `refused` by the order checks (a
 * REFUSAL_REASONS reason); `cancelled`: the setup ended before the buy filled.
 */
export const AUTO_DECISION_OUTCOMES = ['placed', 'skipped', 'refused', 'cancelled'] as const;

export const AutoDecisionSchema = z.object({
  id: UuidSchema,
  setupId: UuidSchema,
  instrumentId: UuidSchema,
  pattern: PatternSchema,
  outcome: z.enum(AUTO_DECISION_OUTCOMES),
  reason: z.string().nullable(),
  orderId: UuidSchema.nullable(),
  /** The buy it placed (or that was refused, or cancelled): its size and its three prices. */
  order: z
    .object({
      quantity: DecimalSchema,
      limitPrice: DecimalSchema,
      stop: DecimalSchema.nullable(),
      target: DecimalSchema.nullable(),
    })
    .nullable(),
  /** The rules' version the decision used. */
  strategyVersion: z.number().int().nonnegative(),
  decidedAt: TsSchema,
});
export type AutoDecision = z.infer<typeof AutoDecisionSchema>;

/** `GET /practice/automatic`. */
export const PracticeStrategySchema = z.object({
  enabled: z.boolean(),
  rules: AutoRulesSchema,
  /** Raised by every change; a change names the version it was based on. */
  version: z.number().int().nonnegative(),
  /** Set while the daily loss limit pauses it. */
  pausedUntil: TsSchema.nullable(),
  updatedAt: TsSchema.nullable(),
  /** Since 00:00 UTC: automatic buys placed, and the result of the automatic trades closed. */
  today: z.object({ orders: z.number().int().nonnegative(), result: DecimalSchema, asset: z.string() }),
});
export type PracticeStrategy = z.infer<typeof PracticeStrategySchema>;

/** `PUT /practice/automatic`: the rules, against the version they were read at. */
export const UpdateAutoRulesRequestSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  rules: AutoRulesSchema,
});
export type UpdateAutoRulesRequest = z.infer<typeof UpdateAutoRulesRequestSchema>;

/** `POST /practice/automatic/on`: switching on confirms the rules the user saw, at their version. */
export const AutoSwitchOnRequestSchema = z.strictObject({ version: z.number().int().nonnegative() });
export type AutoSwitchOnRequest = z.infer<typeof AutoSwitchOnRequestSchema>;

export const AutoDecisionsQuerySchema = PageQuerySchema;

/** `practice.automatic` on the `practice` channel: a decision, a pause, or a stop. */
export const PracticeAutomaticMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('decision'), decision: AutoDecisionSchema }),
  /** `at`: when the trade that reached the daily loss limit closed. */
  z.object({
    event: z.literal('paused'),
    at: TsSchema,
    until: TsSchema,
    result: DecimalSchema,
    asset: z.string(),
  }),
  z.object({ event: z.literal('stopped'), cancelled: z.number().int().nonnegative() }),
]);
export type PracticeAutomaticMessage = z.infer<typeof PracticeAutomaticMessageSchema>;
