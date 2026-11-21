import type { EthLog } from './detect.js';

/** Units of work on the `onchain` queue (ADR 025): the watcher adds them, any jobs instance reads. */
export type OnchainJob =
  /** A Bitcoin block to read for large transfers. */
  | { kind: 'btc-block'; hash: string; height: number }
  /** An Ethereum block to read for large ETH transfers (read 2 blocks behind the head). */
  | { kind: 'eth-block'; number: number }
  /** A PAXG log pushed by the subscription. */
  | { kind: 'paxg-log'; log: EthLog }
  /** A PAXG log whose block was replaced: its event goes. */
  | { kind: 'paxg-removed'; txHash: string; logIndex: number }
  /** A Solana transaction that mentions a watched exchange wallet. */
  | { kind: 'sol-tx'; signature: string };

/** One job per block or transaction: BullMQ ignores a second with the same id while it is kept. */
export function onchainJobId(job: OnchainJob): string {
  switch (job.kind) {
    case 'btc-block':
      return `btc-${job.height}-${job.hash}`;
    case 'eth-block':
      return `eth-${job.number}`;
    case 'paxg-log':
      return `paxg-${job.log.transactionHash}-${Number(BigInt(job.log.logIndex))}`;
    case 'paxg-removed':
      return `paxg-removed-${job.txHash}-${job.logIndex}`;
    case 'sol-tx':
      return `sol-${job.signature}`;
  }
}

/** Valkey hash of recent Ethereum block times (number → epoch ms), filled from the pushed heads. */
export const ETH_BLOCK_TIMES_KEY = 'onchain:eth:block-times';
/** Valkey counter of Solana transactions read today (UTC), against the daily cap. */
export const solCallsKey = (now: number) => `onchain:sol:calls:${new Date(now).toISOString().slice(0, 10)}`;
