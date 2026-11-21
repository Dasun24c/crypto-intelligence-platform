import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { type OnchainAsset, PAXG_DECIMALS } from '@cip/contracts';
import {
  advanceOnchainCursor,
  type Database,
  deleteOnchainEvents,
  type DetectedOnchainEvent,
  exchangeLabelRows,
  insertOnchainEvents,
} from '@cip/db';
import type { Logger } from '@cip/observability';
import {
  bitcoinTransfer,
  type DetectContext,
  type EsploraTx,
  type EthBlock,
  type EthLog,
  ethereumTransfers,
  minUnits,
  paxgEvent,
  type SolanaTx,
  solanaTransfer,
} from './detect.js';
import { type EsploraClient, type Fetch, jsonRpc } from './http.js';
import { ETH_BLOCK_TIMES_KEY, type OnchainJob, solCallsKey } from './jobs.js';
import type { OnchainPrices } from './prices.js';

const DECIMALS: Record<OnchainAsset, number> = { BTC: 8, ETH: 18, SOL: 9, PAXG: PAXG_DECIMALS };
/** Esplora lists a block's transactions 25 at a time. */
const ESPLORA_PAGE = 25;
/** Labels for the Solana watched set are read again this often. */
const LABELS_EVERY_MS = 5 * 60_000;

export interface ProcessorDeps {
  db: Kysely<Database>;
  redis: Redis;
  log: Logger;
  prices: OnchainPrices;
  esplora: EsploraClient;
  fetch: Fetch;
  /** The providers' URLs, with the key where they need one; null without a key. */
  ethHttpUrl: () => string | null;
  solHttpUrl: () => string | null;
  thresholdsUsd: Record<OnchainAsset, string>;
  solDailyCalls: number;
  /** The Bitcoin API's host, recorded as each Bitcoin event's provider. */
  btcProvider: string;
  now?: () => number;
  /** Called with each new event (counted for the jobs service's report). */
  onEvent?: (e: DetectedOnchainEvent) => void;
}

/** Reads one queued block or transaction and stores what is large (ADR 025). */
export class OnchainProcessor {
  private readonly now: () => number;
  private solWatched = new Set<string>();
  private solLoadedAt = 0;

  constructor(private readonly d: ProcessorDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  async run(job: OnchainJob): Promise<{ events: number; skipped?: string }> {
    switch (job.kind) {
      case 'btc-block':
        return this.bitcoinBlock(job.hash, job.height);
      case 'eth-block':
        return this.ethereumBlock(job.number);
      case 'paxg-log':
        return this.paxgLog(job.log);
      case 'paxg-removed': {
        const n = await deleteOnchainEvents(this.d.db, 'ethereum', job.txHash, job.logIndex);
        if (n > 0) this.d.log.info({ txHash: job.txHash }, 'PAXG event removed: its block was replaced');
        return { events: -n };
      }
      case 'sol-tx':
        return this.solanaTx(job.signature);
    }
  }

  private async context(asset: OnchainAsset, provider: string): Promise<DetectContext> {
    const price = (await this.d.prices.current())[asset];
    return { min: minUnits(this.d.thresholdsUsd[asset], price, DECIMALS[asset]), priceUsd: price, provider };
  }

  /** Stores the events; one already stored adds nothing. Returns how many were new. */
  private async store(events: DetectedOnchainEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const receivedAt = this.now();
    const rows = events.map((e) => ({ ...e, id: uuidv7(), receivedAt }));
    const fresh = new Set(await insertOnchainEvents(this.d.db, rows));
    for (const r of rows) if (fresh.has(r.id)) this.d.onEvent?.(r);
    return fresh.size;
  }

  // ── Bitcoin ─────────────────────────────────────────────────────────────────────────────────

  private async bitcoinBlock(hash: string, height: number): Promise<{ events: number; skipped?: string }> {
    const block = await this.d.esplora.get<{ height: number; timestamp: number; tx_count: number }>(
      `/block/${hash}`,
    );
    const ctx = await this.context('BTC', this.d.btcProvider);
    const events: DetectedOnchainEvent[] = [];
    if (ctx.min !== null) {
      for (let start = 0; start < block.tx_count; start += ESPLORA_PAGE) {
        const txs = await this.d.esplora.get<EsploraTx[]>(`/block/${hash}/txs/${start}`);
        for (const tx of txs) {
          const e = bitcoinTransfer(tx, { height: block.height, time: block.timestamp * 1000 }, ctx);
          if (e) events.push(e);
        }
      }
    }
    const n = await this.store(events);
    await advanceOnchainCursor(this.d.db, 'bitcoin', height);
    return ctx.min === null ? { events: n, skipped: 'no BTC price' } : { events: n };
  }

  // ── Ethereum ────────────────────────────────────────────────────────────────────────────────

  private ethUrl(): string {
    const url = this.d.ethHttpUrl();
    if (!url) throw new Error('no Alchemy key');
    return url;
  }

  private async ethereumBlock(number: number): Promise<{ events: number; skipped?: string }> {
    const block = await jsonRpc<EthBlock | null>(
      this.d.fetch,
      this.ethUrl(),
      'eth_getBlockByNumber',
      [`0x${number.toString(16)}`, true],
      'Ethereum',
    );
    if (!block) throw new Error(`Ethereum block ${number} is not available yet`);
    const ctx = await this.context('ETH', 'alchemy');
    const n = await this.store(ethereumTransfers(block, ctx));
    await advanceOnchainCursor(this.d.db, 'ethereum', number);
    return ctx.min === null ? { events: n, skipped: 'no ETH price' } : { events: n };
  }

  /** A block's time from the pushed heads, or from the provider when it is not cached. */
  private async ethBlockTime(blockNumber: number): Promise<number> {
    const cached = await this.d.redis.hget(ETH_BLOCK_TIMES_KEY, String(blockNumber));
    if (cached) return Number(cached);
    const header = await jsonRpc<{ timestamp: string } | null>(
      this.d.fetch,
      this.ethUrl(),
      'eth_getBlockByNumber',
      [`0x${blockNumber.toString(16)}`, false],
      'Ethereum',
    );
    if (!header) throw new Error(`Ethereum block ${blockNumber} is not available yet`);
    return Number(BigInt(header.timestamp)) * 1000;
  }

  private async paxgLog(log: EthLog): Promise<{ events: number }> {
    const time = await this.ethBlockTime(Number(BigInt(log.blockNumber)));
    const e = paxgEvent(log, time, await this.context('PAXG', 'alchemy'));
    return { events: e ? await this.store([e]) : 0 };
  }

  // ── Solana ──────────────────────────────────────────────────────────────────────────────────

  private async watched(): Promise<Set<string>> {
    if (this.now() - this.solLoadedAt > LABELS_EVERY_MS) {
      this.solWatched = new Set((await exchangeLabelRows(this.d.db, 'solana')).map((r) => r.address));
      this.solLoadedAt = this.now();
    }
    return this.solWatched;
  }

  private async solanaTx(signature: string): Promise<{ events: number; skipped?: string }> {
    const url = this.d.solHttpUrl();
    if (!url) throw new Error('no Alchemy key');
    // A daily cap keeps the free plan's compute units for Ethereum (proposal 003).
    const key = solCallsKey(this.now());
    const calls = await this.d.redis.incr(key);
    if (calls === 1) await this.d.redis.expire(key, 2 * 86_400);
    if (calls > this.d.solDailyCalls) return { events: 0, skipped: 'daily Solana budget reached' };
    const tx = await jsonRpc<SolanaTx | null>(
      this.d.fetch,
      url,
      'getTransaction',
      [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      'Solana',
    );
    if (!tx) throw new Error('Solana transaction not available yet');
    const e = solanaTransfer(tx, await this.watched(), await this.context('SOL', 'alchemy'), this.now());
    return { events: e ? await this.store([e]) : 0 };
  }
}
