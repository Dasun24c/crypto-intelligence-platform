import { z } from 'zod';
import { TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, LargeTradeSchema, WallSchema } from './market.js';

/**
 * The Whale Tracker (Phase 11; REQUIREMENTS §7, WH-01 and WH-02; ADR 025). Two tabs that are never
 * mixed (criterion 11.3): **Exchange flow**, from the venues' large trades and order-book walls,
 * and **On-chain**, from the blockchains through the providers chosen in proposal 003.
 */

const ms = z.coerce.number().int().nonnegative();

/** The longest window either tab reads at once. */
export const WHALES_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The window when none is given: the last 24 hours. */
export const WHALES_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Exchange flow (WH-01, criterion 11.1) ───────────────────────────────────────────────────────

/** At most this many large trades are listed; the totals still count every one in the window. */
export const EXCHANGE_FLOW_MAX_TRADES = 200;

/** `GET /whales/exchange?instrumentId&from&to` */
export const ExchangeFlowQuerySchema = z.strictObject({
  instrumentId: UuidSchema.optional(),
  from: ms.optional(),
  to: ms.optional(),
});
export type ExchangeFlowQuery = z.infer<typeof ExchangeFlowQuerySchema>;

/** One instrument's large trades and walls in the window. USD amounts are decimal strings. */
export const ExchangeFlowInstrumentSchema = z.object({
  instrumentId: UuidSchema,
  largeTrades: z.number().int(),
  buys: z.number().int(),
  sells: z.number().int(),
  /** Large taker buys and sells, in USD. */
  boughtUsd: DecimalSchema,
  soldUsd: DecimalSchema,
  /** Bought minus sold. */
  netUsd: DecimalSchema,
  largestUsd: DecimalSchema.nullable(),
  /** Walls first seen in the window. */
  wallsAppeared: z.number().int(),
  /** Walls that ended in the window, by how. */
  wallsFilled: z.number().int(),
  wallsPulled: z.number().int(),
  /** Walls standing in the book now. */
  wallsStanding: z.number().int(),
});
export type ExchangeFlowInstrument = z.infer<typeof ExchangeFlowInstrumentSchema>;

export const ExchangeFlowSchema = z.object({
  from: TsSchema,
  to: TsSchema,
  /** Every instrument in view with anything in the window, by most large-trade USD. */
  instruments: z.array(ExchangeFlowInstrumentSchema),
  /** The window's large trades, newest first, at most EXCHANGE_FLOW_MAX_TRADES. */
  largeTrades: z.array(LargeTradeSchema),
  /** How many large trades the window holds (more than listed when the list is cut). */
  largeTradesTotal: z.number().int(),
  /** Walls standing now, then walls that ended in the window, newest first. */
  walls: z.array(WallSchema),
});
export type ExchangeFlow = z.infer<typeof ExchangeFlowSchema>;

// ── On-chain (WH-02, criteria 11.2 and 11.4) ────────────────────────────────────────────────────

export const CHAINS = ['bitcoin', 'ethereum', 'solana'] as const;
export const ChainSchema = z.enum(CHAINS);
export type Chain = z.infer<typeof ChainSchema>;

export const ONCHAIN_ASSETS = ['BTC', 'ETH', 'SOL', 'PAXG'] as const;
export const OnchainAssetSchema = z.enum(ONCHAIN_ASSETS);
export type OnchainAsset = z.infer<typeof OnchainAssetSchema>;

/** Each asset's chain: PAXG is an ERC-20 token on Ethereum. */
export const ASSET_CHAIN: Record<OnchainAsset, Chain> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  PAXG: 'ethereum',
};

/** PAXG on Ethereum: the proxy everyone interacts with (feasibility §9), 18 decimals. */
export const PAXG_CONTRACT = '0x45804880de22913dafe09f4980848ece6ecbaf78';
export const PAXG_DECIMALS = 18;

/**
 * transfer: a large transfer of the asset. mint and burn: PAXG's supply growing or shrinking
 * (`SupplyIncreased` and `SupplyDecreased`), recorded whatever their size.
 */
export const OnchainEventKindSchema = z.enum(['transfer', 'mint', 'burn']);
export type OnchainEventKind = z.infer<typeof OnchainEventKindSchema>;

/** A transfer's relation to the listed exchange addresses. */
export const OnchainFlowSchema = z.enum(['to_exchange', 'from_exchange', 'between_exchanges', 'other']);
export type OnchainFlow = z.infer<typeof OnchainFlowSchema>;

export const OnchainEventSchema = z.object({
  id: UuidSchema,
  chain: ChainSchema,
  asset: OnchainAssetSchema,
  kind: OnchainEventKindSchema,
  txHash: z.string(),
  /** The event's place in its transaction: the log index on Ethereum, otherwise 0. */
  position: z.number().int(),
  /** Block height, or the slot on Solana. */
  blockNumber: z.number().int(),
  blockTime: TsSchema,
  /** null for a mint. */
  from: z.string().nullable(),
  /** null for a burn. */
  to: z.string().nullable(),
  /** The exchanges that own the addresses, when listed. */
  fromOwner: z.string().nullable(),
  toOwner: z.string().nullable(),
  flow: OnchainFlowSchema,
  /** In the asset's units, as a decimal string. */
  amount: DecimalSchema,
  /** At detection, from the platform's own market prices; null when there was none. */
  usdValue: DecimalSchema.nullable(),
  provider: z.string(),
  /** When the platform received it: minus blockTime, the delivery latency. */
  receivedAt: TsSchema,
});
export type OnchainEvent = z.infer<typeof OnchainEventSchema>;

/** `GET /whales/onchain?asset&kind&from&to&cursor&limit` */
export const OnchainQuerySchema = z.strictObject({
  asset: OnchainAssetSchema.optional(),
  kind: OnchainEventKindSchema.optional(),
  from: ms.optional(),
  to: ms.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type OnchainQuery = z.infer<typeof OnchainQuerySchema>;

/** One asset's on-chain events in the window. */
export const OnchainAssetSummarySchema = z.object({
  asset: OnchainAssetSchema,
  transfers: z.number().int(),
  transferUsd: DecimalSchema,
  toExchangeUsd: DecimalSchema,
  fromExchangeUsd: DecimalSchema,
  /** PAXG only: units minted and burned. */
  minted: DecimalSchema,
  burned: DecimalSchema,
  mints: z.number().int(),
  burns: z.number().int(),
});
export type OnchainAssetSummary = z.infer<typeof OnchainAssetSummarySchema>;

export const OnchainPageSchema = z.object({
  from: TsSchema,
  to: TsSchema,
  items: z.array(OnchainEventSchema),
  nextCursor: z.string().nullable(),
  summary: z.array(OnchainAssetSummarySchema),
});
export type OnchainPage = z.infer<typeof OnchainPageSchema>;

// ── The sources' state (`onchain:status`, kept by the jobs service) ─────────────────────────────

export const ONCHAIN_SOURCE_STATES = [
  /** Connected and receiving. */
  'connected',
  /** Connecting, or reconnecting after a drop. */
  'connecting',
  /** No API key in its file: nothing is requested. */
  'no_key',
  /** The provider could not be reached from this network. */
  'unreachable',
  /** Reached, but failing (a refused key, a spent quota, …). */
  'error',
  /** Another jobs instance runs the watcher. */
  'standby',
  /** Nothing to watch (Solana with no exchange wallet listed). */
  'idle',
  /** Switched off on this stack (`ONCHAIN_ENABLED=false`): nothing connects to the providers. */
  'off',
] as const;
export const OnchainSourceStateSchema = z.enum(ONCHAIN_SOURCE_STATES);
export type OnchainSourceState = z.infer<typeof OnchainSourceStateSchema>;

export const OnchainSourceStatusSchema = z.object({
  chain: ChainSchema,
  /** Who delivers it: `mempool.space`, `alchemy`, … */
  provider: z.string(),
  state: OnchainSourceStateSchema,
  detail: z.string(),
  /** The last block (or slot) processed, and when it was mined. */
  lastBlock: z.number().int().nullable(),
  lastBlockTime: TsSchema.nullable(),
  /** Solana: how many listed exchange wallets are watched. */
  watching: z.number().int().nullable(),
});
export type OnchainSourceStatus = z.infer<typeof OnchainSourceStatusSchema>;

export const OnchainStatusSchema = z.object({
  updatedAt: TsSchema,
  sources: z.array(OnchainSourceStatusSchema),
  /** The smallest transfer recorded, per asset, in USD. */
  thresholdsUsd: z.record(OnchainAssetSchema, DecimalSchema),
});
export type OnchainStatus = z.infer<typeof OnchainStatusSchema>;

/** `GET /whales/onchain/status`: stale when the jobs service has not refreshed it lately. */
export const OnchainStatusResponseSchema = OnchainStatusSchema.extend({ stale: z.boolean() });
export type OnchainStatusResponse = z.infer<typeof OnchainStatusResponseSchema>;

/** Valkey key of the current OnchainStatus (the API marks it stale after ONCHAIN_STATUS_STALE_MS). */
export const ONCHAIN_STATUS_KEY = 'onchain:status';
export const ONCHAIN_STATUS_STALE_MS = 60_000;
/** The BullMQ queue of blocks and transactions to read (architecture §6). */
export const ONCHAIN_QUEUE = 'onchain';

/** Default thresholds (USD) for a large transfer; the jobs service's configuration can change them. */
export const DEFAULT_ONCHAIN_THRESHOLDS_USD: Record<OnchainAsset, string> = {
  BTC: '1000000',
  ETH: '1000000',
  SOL: '1000000',
  PAXG: '250000',
};

// ── Exchange labels (curated by hand; proposal 003) ─────────────────────────────────────────────

export const WALLET_KINDS = ['cold', 'hot', 'reserve', 'unknown'] as const;
export const WalletKindSchema = z.enum(WALLET_KINDS);

/** The address in its canonical form: Ethereum hex lowercased; Bitcoin and Solana as given. */
export function canonicalAddress(chain: Chain, address: string): string {
  const a = address.trim();
  return chain === 'ethereum' ? a.toLowerCase() : a;
}

const ADDRESS_FORMATS: Record<Chain, RegExp> = {
  bitcoin: /^(?:bc1[02-9ac-hj-np-z]{6,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  ethereum: /^0x[0-9a-f]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

/** Whether an address has its chain's format (after canonicalAddress). */
export function isAddressOf(chain: Chain, address: string): boolean {
  return ADDRESS_FORMATS[chain].test(canonicalAddress(chain, address));
}

export const ExchangeLabelSchema = z.object({
  id: UuidSchema,
  chain: ChainSchema,
  address: z.string(),
  owner: z.string(),
  wallet: WalletKindSchema,
  /** Where the exchange published the address. */
  source: z.string(),
  createdAt: TsSchema,
  updatedAt: TsSchema,
});
export type ExchangeLabel = z.infer<typeof ExchangeLabelSchema>;

/** `POST /admin/whales/labels` */
export const CreateExchangeLabelSchema = z
  .strictObject({
    chain: ChainSchema,
    address: z.string().trim().min(1).max(128),
    owner: z.string().trim().min(1).max(60),
    wallet: WalletKindSchema.default('unknown'),
    source: z.string().trim().min(1).max(500),
  })
  .refine((v) => isAddressOf(v.chain, v.address), {
    error: "The address doesn't have its chain's format.",
    path: ['address'],
  })
  .transform((v) => ({ ...v, address: canonicalAddress(v.chain, v.address) }));
export type CreateExchangeLabel = z.infer<typeof CreateExchangeLabelSchema>;

/** `GET /admin/whales/labels?chain` */
export const ExchangeLabelsQuerySchema = z.strictObject({ chain: ChainSchema.optional() });

/** How a transfer relates to the listed exchanges. */
export function flowOf(fromOwner: string | null, toOwner: string | null): OnchainFlow {
  if (fromOwner && toOwner) return 'between_exchanges';
  if (toOwner) return 'to_exchange';
  if (fromOwner) return 'from_exchange';
  return 'other';
}
