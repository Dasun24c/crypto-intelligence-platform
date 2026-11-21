import { canonicalAddress, PAXG_CONTRACT, PAXG_DECIMALS } from '@cip/contracts';
import type { DetectedOnchainEvent } from '@cip/db';
import { dec, divDecimal, mulDecimal, normalizeDecimal, roundDecimal } from '@cip/domain';

/**
 * Detecting the Whale Tracker's on-chain events (ADR 025): pure functions over what the providers
 * return, so each is tested on recorded chain data.
 */

/** keccak-256 of the event signatures (computed once; checked against real logs in the tests). */
export const TOPICS = {
  /** Transfer(address,address,uint256) */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** SupplyIncreased(address indexed to, uint256 value): a PAXG mint. */
  supplyIncreased: '0xf5c174d57843e57fea3c649fdde37f015ef08750759cbee88060390566a98797',
  /** SupplyDecreased(address indexed from, uint256 value): a PAXG burn. */
  supplyDecreased: '0x1b7e18241beced0d7f41fbab1ea8ed468732edbcb74ec4420151654ca71c8a63',
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** An integer amount of base units as a decimal string in the asset's units. */
export function unitsToDecimal(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * The smallest amount, in base units, worth at least `thresholdUsd` at `priceUsd`. Without a price
 * nothing is large enough: null.
 */
export function minUnits(thresholdUsd: string, priceUsd: string | null, decimals: number): bigint | null {
  if (priceUsd === null || dec(priceUsd).lte(0)) return null;
  const units = dec(divDecimal(thresholdUsd, priceUsd, decimals + 2)).times(dec(10).pow(decimals));
  return BigInt(units.round(0, 3 /* up */).toFixed(0));
}

/** The USD value of an amount at a price, to the cent; null without a price. */
export function usdValue(amount: string, priceUsd: string | null): string | null {
  return priceUsd === null ? null : normalizeDecimal(roundDecimal(mulDecimal(amount, priceUsd), 2));
}

export interface DetectContext {
  /** Base units at or above which a transfer is large; null when there is no price. */
  min: bigint | null;
  priceUsd: string | null;
  provider: string;
}

// ── Bitcoin (Esplora's transaction format: mempool.space, blockstream.info) ─────────────────────

export interface EsploraTx {
  txid: string;
  vin: { is_coinbase?: boolean; prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

/**
 * A Bitcoin transaction's transfer: what its outputs pay to addresses other than its inputs' (the
 * change returning to the sender is not transferred). From is the largest input's address, to the
 * largest recipient's; the counts are kept in `details`.
 */
export function bitcoinTransfer(
  tx: EsploraTx,
  block: { height: number; time: number },
  ctx: DetectContext,
): DetectedOnchainEvent | null {
  if (ctx.min === null || tx.vin.some((i) => i.is_coinbase)) return null;
  const inputs = new Map<string, number>();
  for (const i of tx.vin) {
    const a = i.prevout?.scriptpubkey_address;
    if (a) inputs.set(a, (inputs.get(a) ?? 0) + (i.prevout?.value ?? 0));
  }
  let sent = 0n;
  let to: { address: string; value: number } | null = null;
  let recipients = 0;
  for (const o of tx.vout) {
    const a = o.scriptpubkey_address;
    if (!a || inputs.has(a) || o.value <= 0) continue;
    sent += BigInt(o.value);
    recipients++;
    if (!to || o.value > to.value) to = { address: a, value: o.value };
  }
  if (!to || sent < ctx.min) return null;
  const from = [...inputs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const amount = unitsToDecimal(sent, 8);
  return {
    chain: 'bitcoin',
    asset: 'BTC',
    kind: 'transfer',
    txHash: tx.txid,
    position: 0,
    blockNumber: block.height,
    blockTime: block.time,
    from,
    to: to.address,
    amount,
    priceUsd: ctx.priceUsd,
    usdValue: usdValue(amount, ctx.priceUsd),
    provider: ctx.provider,
    details: { inputs: tx.vin.length, outputs: tx.vout.length, recipients, senders: inputs.size },
  };
}

// ── Ethereum: ETH itself, and PAXG's events ─────────────────────────────────────────────────────

export interface EthTx {
  hash: string;
  from: string;
  to: string | null;
  /** Wei, hex. */
  value: string;
}

export interface EthBlock {
  number: string;
  hash: string;
  timestamp: string;
  transactions: (EthTx | string)[];
}

/** Every transaction in a block that moves at least `min` wei of ETH itself (not a token). */
export function ethereumTransfers(block: EthBlock, ctx: DetectContext): DetectedOnchainEvent[] {
  if (ctx.min === null) return [];
  const height = Number(BigInt(block.number));
  const time = Number(BigInt(block.timestamp)) * 1000;
  const out: DetectedOnchainEvent[] = [];
  for (const tx of block.transactions) {
    if (typeof tx === 'string' || !tx.to) continue;
    const wei = BigInt(tx.value);
    if (wei < ctx.min) continue;
    const amount = unitsToDecimal(wei, 18);
    out.push({
      chain: 'ethereum',
      asset: 'ETH',
      kind: 'transfer',
      txHash: tx.hash,
      position: 0,
      blockNumber: height,
      blockTime: time,
      from: canonicalAddress('ethereum', tx.from),
      to: canonicalAddress('ethereum', tx.to),
      amount,
      priceUsd: ctx.priceUsd,
      usdValue: usdValue(amount, ctx.priceUsd),
      provider: ctx.provider,
    });
  }
  return out;
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

/** The address in an indexed topic (the last 20 bytes). */
function topicAddress(topic: string | undefined): string | null {
  return topic ? `0x${topic.slice(-40).toLowerCase()}` : null;
}

/**
 * A PAXG log as an event: a mint (`SupplyIncreased`) or burn (`SupplyDecreased`) whatever its size,
 * or a large `Transfer`. A mint's and a burn's own `Transfer` (from or to the zero address, in the
 * same transaction) is not a second event.
 */
export function paxgEvent(log: EthLog, blockTime: number, ctx: DetectContext): DetectedOnchainEvent | null {
  if (log.address.toLowerCase() !== PAXG_CONTRACT) return null;
  const topic = log.topics[0]?.toLowerCase();
  const units = BigInt(log.data === '0x' ? 0 : log.data);
  if (units <= 0n) return null;
  const amount = unitsToDecimal(units, PAXG_DECIMALS);
  const base = {
    chain: 'ethereum' as const,
    asset: 'PAXG' as const,
    txHash: log.transactionHash,
    position: Number(BigInt(log.logIndex)),
    blockNumber: Number(BigInt(log.blockNumber)),
    blockTime,
    amount,
    priceUsd: ctx.priceUsd,
    usdValue: usdValue(amount, ctx.priceUsd),
    provider: ctx.provider,
  };
  if (topic === TOPICS.supplyIncreased)
    return { ...base, kind: 'mint', from: null, to: topicAddress(log.topics[1]) };
  if (topic === TOPICS.supplyDecreased)
    return { ...base, kind: 'burn', from: topicAddress(log.topics[1]), to: null };
  if (topic !== TOPICS.transfer) return null;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) return null;
  if (ctx.min === null || units < ctx.min) return null;
  return { ...base, kind: 'transfer', from, to };
}

// ── Solana: SOL moving into or out of a watched exchange wallet ─────────────────────────────────

export interface SolanaTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (string | { pubkey: string })[] };
  };
  meta: { err: unknown; preBalances: number[]; postBalances: number[] } | null;
}

/**
 * The SOL a transaction moved into or out of a watched wallet, when large: the account that lost
 * the most sends, the one that gained the most receives, and the amount is what was received.
 */
export function solanaTransfer(
  tx: SolanaTx,
  watched: ReadonlySet<string>,
  ctx: DetectContext,
  receivedAt: number,
): DetectedOnchainEvent | null {
  if (ctx.min === null || !tx.meta || tx.meta.err !== null) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  let sender: { key: string; delta: bigint } | null = null;
  let receiver: { key: string; delta: bigint } | null = null;
  keys.forEach((key, i) => {
    const delta = BigInt(tx.meta!.postBalances[i] ?? 0) - BigInt(tx.meta!.preBalances[i] ?? 0);
    if (delta < 0n && (!sender || delta < sender.delta)) sender = { key, delta };
    if (delta > 0n && (!receiver || delta > receiver.delta)) receiver = { key, delta };
  });
  const s = sender as { key: string; delta: bigint } | null;
  const r = receiver as { key: string; delta: bigint } | null;
  if (!s || !r || (!watched.has(s.key) && !watched.has(r.key))) return null;
  if (r.delta < ctx.min) return null;
  const amount = unitsToDecimal(r.delta, 9);
  return {
    chain: 'solana',
    asset: 'SOL',
    kind: 'transfer',
    txHash: tx.transaction.signatures[0]!,
    position: 0,
    blockNumber: tx.slot,
    blockTime: tx.blockTime !== null ? tx.blockTime * 1000 : receivedAt,
    from: s.key,
    to: r.key,
    amount,
    priceUsd: ctx.priceUsd,
    usdValue: usdValue(amount, ctx.priceUsd),
    provider: ctx.provider,
  };
}
