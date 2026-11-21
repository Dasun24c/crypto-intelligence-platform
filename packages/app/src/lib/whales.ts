import type {
  Chain,
  OnchainEvent,
  OnchainEventKind,
  OnchainFlow,
  OnchainSourceState,
  OnchainStatus,
} from '@cip/contracts';
import type { StatusTone } from '@cip/ui';
import { formatUsd } from './decimal.js';

/** The Whale Tracker's windows (the API serves at most 7 days at once). */
export const WHALE_WINDOWS = [
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
] as const;
export type WhaleWindow = (typeof WHALE_WINDOWS)[number]['id'];

export function windowMs(id: WhaleWindow): number {
  return WHALE_WINDOWS.find((w) => w.id === id)!.ms;
}

/** A long address shortened for a table: the start and the end. */
export function shortAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The exchange that owns an address when listed, else the shortened address; a mint or burn has none. */
export function party(address: string | null, owner: string | null): string {
  if (address === null) return '—';
  return owner ?? shortAddress(address);
}

export const KIND_LABELS: Record<OnchainEventKind, string> = {
  transfer: 'Transfer',
  mint: 'Minted',
  burn: 'Burned',
};

export const FLOW_LABELS: Record<OnchainFlow, string> = {
  to_exchange: 'Into an exchange',
  from_exchange: 'Out of an exchange',
  between_exchanges: 'Between exchanges',
  other: '—',
};

/** A transaction on a public block explorer (opens outside the app). */
export function explorerUrl(chain: Chain, txHash: string): string {
  switch (chain) {
    case 'bitcoin':
      return `https://mempool.space/tx/${txHash}`;
    case 'ethereum':
      return `https://etherscan.io/tx/${txHash}`;
    case 'solana':
      return `https://solscan.io/tx/${txHash}`;
  }
}

export const CHAIN_LABELS: Record<Chain, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum and PAXG',
  solana: 'Solana',
};

export const SOURCE_STATE_LABELS: Record<OnchainSourceState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  no_key: 'Waiting for a key',
  unreachable: 'Unreachable',
  error: 'Failing',
  standby: 'Standby',
  idle: 'Nothing to watch',
  off: 'Switched off',
};

export function sourceTone(state: OnchainSourceState): StatusTone {
  switch (state) {
    case 'connected':
      return 'ok';
    case 'connecting':
    case 'standby':
    case 'idle':
    case 'off':
      return 'info';
    case 'no_key':
      return 'warn';
    case 'unreachable':
    case 'error':
      return 'crit';
  }
}

/** "Transfers of at least $1,000,000 BTC, …; every PAXG mint and burn." */
export function thresholdsSentence(thresholds: OnchainStatus['thresholdsUsd']): string {
  const parts = (['BTC', 'ETH', 'SOL', 'PAXG'] as const).map((a) => `${formatUsd(thresholds[a], 0)} in ${a}`);
  return `Transfers worth at least ${parts.join(', ')}, valued at the platform's own prices when they arrive; every PAXG mint and burn, whatever its size.`;
}

/** How long after its block the platform had the event (null before a block time is known). */
export function deliveryMs(e: Pick<OnchainEvent, 'blockTime' | 'receivedAt'>): number {
  return Math.max(0, e.receivedAt - e.blockTime);
}
