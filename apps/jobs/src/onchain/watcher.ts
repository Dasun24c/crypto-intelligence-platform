import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import {
  type Chain,
  ONCHAIN_STATUS_KEY,
  type OnchainAsset,
  type OnchainSourceState,
  type OnchainSourceStatus,
  type OnchainStatus,
  PAXG_CONTRACT,
} from '@cip/contracts';
import { type Database, exchangeLabelRows, onchainCursor } from '@cip/db';
import { ReconnectingSocket, type SocketOptions, type SocketStatus } from '@cip/exchange-adapters';
import { FencedLease, LEASE_RENEW_MS, type Logger } from '@cip/observability';
import { type EthLog, TOPICS } from './detect.js';
import type { EsploraClient } from './http.js';
import { ETH_BLOCK_TIMES_KEY, type OnchainJob, onchainJobId } from './jobs.js';

export const ONCHAIN_LEASE = 'lease:onchain';
/** Ethereum blocks are read this far behind the pushed head, past most reorgs (ADR 025). */
export const ETH_DEPTH = 2;
/** After an outage, at most this many missed blocks are read (older ones are skipped and reported). */
const ETH_CATCH_UP = 300;
const BTC_CATCH_UP = 12;
/** A source that failed this many connection attempts in a row is reported unreachable. */
const UNREACHABLE_AFTER = 3;
/** At most this many Solana exchange wallets are watched (one subscription each). */
const SOL_MAX_WALLETS = 25;
const STATUS_EVERY_MS = 5_000;
const KEY_CHECK_EVERY_MS = 30_000;

export interface WatcherConfig {
  btcWsUrl: string;
  /** With the key appended; null without a key. */
  ethWsUrl: () => string | null;
  solWsUrl: () => string | null;
  thresholdsUsd: Record<OnchainAsset, string>;
}

export interface WatcherDeps {
  db: Kysely<Database>;
  redis: Redis;
  queue: Queue<OnchainJob>;
  esplora: EsploraClient;
  log: Logger;
  instance: string;
  config: WatcherConfig;
  now?: () => number;
  /** The providers' WebSocket: tests inject an in-memory one, so nothing connects out. */
  webSocket?: SocketOptions['WebSocketImpl'];
}

/**
 * The status while the watcher is switched off (`ONCHAIN_ENABLED=false`): nothing connects to the
 * providers, and the Whale Tracker says so instead of waiting for a report.
 */
export function switchedOffStatus(
  thresholdsUsd: Record<OnchainAsset, string>,
  now: number,
  btcProvider: string,
): OnchainStatus {
  const off = (chain: Chain, provider: string): OnchainSourceStatus => ({
    chain,
    provider,
    state: 'off',
    detail: 'switched off on this stack (ONCHAIN_ENABLED=false): nothing connects to the provider',
    lastBlock: null,
    lastBlockTime: null,
    watching: null,
  });
  return {
    updatedAt: now,
    sources: [off('bitcoin', btcProvider), off('ethereum', 'alchemy'), off('solana', 'alchemy')],
    thresholdsUsd,
  };
}

/** One chain's connection and what it last reported. */
class Source {
  state: OnchainSourceState = 'connecting';
  detail = 'starting';
  lastBlock: number | null = null;
  lastBlockTime: number | null = null;
  watching: number | null = null;
  failedAttempts = 0;
  socket: ReconnectingSocket | null = null;

  constructor(
    readonly chain: Chain,
    readonly provider: string,
  ) {}

  /** The socket's status as the source's state: unreachable after repeated failed attempts. */
  onSocket(status: SocketStatus, detail: string): void {
    if (status === 'open') {
      this.failedAttempts = 0;
      this.state = 'connected';
      this.detail = 'connected';
    } else if (status === 'closed') {
      this.failedAttempts++;
      this.state = this.failedAttempts >= UNREACHABLE_AFTER ? 'unreachable' : 'connecting';
      this.detail =
        this.state === 'unreachable'
          ? `${this.provider} cannot be reached from this network (${detail})`
          : `reconnecting (${detail})`;
    } else if (this.state !== 'unreachable') {
      this.state = 'connecting';
      this.detail = detail;
    }
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
  }

  report(): OnchainSourceStatus {
    return {
      chain: this.chain,
      provider: this.provider,
      state: this.state,
      detail: this.detail,
      lastBlock: this.lastBlock,
      lastBlockTime: this.lastBlockTime,
      watching: this.watching,
    };
  }
}

/**
 * The on-chain watcher (ADR 025): one jobs instance holds `lease:onchain` and keeps the providers'
 * WebSocket subscriptions; every pushed block or transaction becomes a job on the `onchain` queue,
 * which any instance reads. Status goes to `onchain:status` for the Whale Tracker.
 */
export class OnchainWatcher {
  private readonly lease: FencedLease;
  private readonly now: () => number;
  private readonly btc: Source;
  private readonly eth = new Source('ethereum', 'alchemy');
  private readonly sol = new Source('solana', 'alchemy');
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private ethCaughtUp = false;
  private solSubs = new Map<number, string>();
  private solWallets: string[] = [];
  lastError: string | null = null;

  constructor(private readonly d: WatcherDeps) {
    this.lease = new FencedLease(d.redis, ONCHAIN_LEASE, d.instance);
    this.now = d.now ?? (() => Date.now());
    // Named after the host it connects to (mempool.space unless configured otherwise).
    this.btc = new Source('bitcoin', new URL(d.config.btcWsUrl).host);
  }

  get holding(): boolean {
    return this.lease.held;
  }

  /** States for the jobs service's own health line. */
  summary(): string {
    if (!this.running) return 'on-chain: standby';
    return `on-chain: ${[this.btc, this.eth, this.sol].map((s) => `${s.chain} ${s.state}`).join(', ')}`;
  }

  async start(): Promise<void> {
    await this.leaseTick();
    this.timers.push(setInterval(() => void this.leaseTick(), LEASE_RENEW_MS));
    this.timers.push(setInterval(() => void this.writeStatus(), STATUS_EVERY_MS));
    this.timers.push(setInterval(() => void this.checkKeysAndWallets(), KEY_CHECK_EVERY_MS));
    for (const t of this.timers) t.unref?.();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopSources();
    await this.lease.release().catch(() => undefined);
  }

  // ── lease ─────────────────────────────────────────────────────────────────────────────────

  private async leaseTick(): Promise<void> {
    try {
      const held = await this.lease.refresh();
      if (held && !this.running) await this.startSources();
      if (!held && this.running) {
        this.d.log.warn('on-chain lease lost: another jobs instance watches');
        this.stopSources();
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = 'on-chain lease check failed';
      this.d.log.warn({ err }, 'on-chain lease check failed');
    }
  }

  private async startSources(): Promise<void> {
    this.running = true;
    this.startBitcoin();
    this.startEthereum();
    await this.startSolana();
    await this.writeStatus();
  }

  private stopSources(): void {
    this.running = false;
    for (const s of [this.btc, this.eth, this.sol]) s.stop();
  }

  private async checkKeysAndWallets(): Promise<void> {
    if (!this.running) return;
    // A key added to its file later starts the source without a restart.
    if (!this.eth.socket) this.startEthereum();
    const wallets = await this.solanaWallets().catch(() => this.solWallets);
    if (!this.sol.socket || wallets.join() !== this.solWallets.join()) {
      this.sol.stop();
      await this.startSolana(wallets);
    }
  }

  private async enqueue(job: OnchainJob): Promise<void> {
    await this.d.queue.add(job.kind, job, {
      jobId: onchainJobId(job),
      attempts: 6,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 2_000,
      removeOnFail: 2_000,
    });
  }

  // ── Bitcoin: mempool.space's WebSocket pushes each block ─────────────────────────────────────

  private startBitcoin(): void {
    const s = this.btc;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    s.socket = new ReconnectingSocket(
      () => this.d.config.btcWsUrl,
      {
        onOpen: (send) => {
          send(JSON.stringify({ action: 'want', data: ['blocks'] }));
          clearInterval(keepalive);
          keepalive = setInterval(() => s.socket?.send(JSON.stringify({ action: 'ping' })), 30_000);
          keepalive.unref?.();
          void this.bitcoinCatchUp().catch((err: unknown) =>
            this.d.log.warn({ err }, 'Bitcoin catch-up failed'),
          );
        },
        onMessage: (data) => {
          const m = JSON.parse(data) as { block?: { id: string; height: number; timestamp: number } };
          if (!m.block) return;
          s.lastBlock = m.block.height;
          s.lastBlockTime = m.block.timestamp * 1000;
          void this.enqueue({ kind: 'btc-block', hash: m.block.id, height: m.block.height }).catch(
            (err: unknown) => this.d.log.warn({ err }, 'could not queue a Bitcoin block'),
          );
        },
        onStatus: (status, detail) => {
          if (status !== 'open') clearInterval(keepalive);
          s.onSocket(status, detail);
        },
      },
      { idleTimeoutMs: 120_000, WebSocketImpl: this.d.webSocket },
    );
    s.socket.start();
  }

  /** The blocks mined while disconnected (a few at most): read from the REST API by height. */
  private async bitcoinCatchUp(): Promise<void> {
    const tip = Number(await this.d.esplora.get<string>('/blocks/tip/height', 'text'));
    const cursor = await onchainCursor(this.d.db, 'bitcoin');
    if (!Number.isFinite(tip)) return;
    this.btc.lastBlock = Math.max(this.btc.lastBlock ?? 0, tip);
    // First start: begin at the tip (no history is read).
    const from = cursor === null ? tip : Math.max(cursor + 1, tip - BTC_CATCH_UP + 1);
    for (let h = from; h <= tip; h++) {
      const hash = await this.d.esplora.get<string>(`/block-height/${h}`, 'text');
      await this.enqueue({ kind: 'btc-block', hash: hash.trim(), height: h });
    }
  }

  // ── Ethereum and PAXG: Alchemy's WebSocket pushes heads and PAXG's logs ───────────────────────

  private startEthereum(): void {
    const s = this.eth;
    if (!this.d.config.ethWsUrl()) {
      s.state = 'no_key';
      s.detail = 'no Alchemy key in .secrets-jobs/alchemy-api-key';
      return;
    }
    const subs = new Map<string, 'heads' | 'logs'>();
    this.ethCaughtUp = false;
    s.socket = new ReconnectingSocket(
      () => this.d.config.ethWsUrl() ?? '',
      {
        onOpen: (send) => {
          subs.clear();
          this.ethCaughtUp = false;
          send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
          send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'eth_subscribe',
              params: [
                'logs',
                {
                  address: PAXG_CONTRACT,
                  topics: [[TOPICS.transfer, TOPICS.supplyIncreased, TOPICS.supplyDecreased]],
                },
              ],
            }),
          );
        },
        onMessage: (data) => void this.ethereumMessage(data, subs),
        onStatus: (status, detail) => s.onSocket(status, detail),
      },
      { idleTimeoutMs: 60_000, WebSocketImpl: this.d.webSocket },
    );
    s.socket.start();
  }

  private async ethereumMessage(data: string, subs: Map<string, 'heads' | 'logs'>): Promise<void> {
    const m = JSON.parse(data) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription: string; result: unknown };
    };
    try {
      if (m.error) {
        this.eth.state = 'error';
        this.eth.detail = `Alchemy refused the subscription (${m.error.code})`;
        return;
      }
      if (m.id === 1 && typeof m.result === 'string') subs.set(m.result, 'heads');
      if (m.id === 2 && typeof m.result === 'string') subs.set(m.result, 'logs');
      if (m.method !== 'eth_subscription' || !m.params) return;
      const kind = subs.get(m.params.subscription);
      if (kind === 'heads') {
        const head = m.params.result as { number: string; timestamp: string };
        const n = Number(BigInt(head.number));
        const time = Number(BigInt(head.timestamp)) * 1000;
        this.eth.lastBlock = n;
        this.eth.lastBlockTime = time;
        await this.d.redis.hset(ETH_BLOCK_TIMES_KEY, String(n), String(time));
        if (n % 100 === 0) await this.trimBlockTimes(n);
        if (!this.ethCaughtUp) {
          this.ethCaughtUp = true;
          await this.ethereumCatchUp(n);
        }
        await this.enqueue({ kind: 'eth-block', number: n - ETH_DEPTH });
      } else if (kind === 'logs') {
        const log = m.params.result as EthLog;
        if (log.removed)
          await this.enqueue({
            kind: 'paxg-removed',
            txHash: log.transactionHash,
            logIndex: Number(BigInt(log.logIndex)),
          });
        else await this.enqueue({ kind: 'paxg-log', log });
      }
    } catch (err) {
      this.d.log.warn({ err }, 'Ethereum message not handled');
    }
  }

  /** The blocks between the cursor and the head read on reconnect, up to ETH_CATCH_UP of them. */
  private async ethereumCatchUp(head: number): Promise<void> {
    const cursor = await onchainCursor(this.d.db, 'ethereum');
    const last = head - ETH_DEPTH - 1;
    if (cursor === null || cursor >= last) return;
    const from = Math.max(cursor + 1, last - ETH_CATCH_UP + 1);
    if (from > cursor + 1)
      this.d.log.warn(
        { skipped: from - cursor - 1 },
        'Ethereum blocks missed while disconnected are skipped',
      );
    for (let n = from; n <= last; n++) await this.enqueue({ kind: 'eth-block', number: n });
  }

  private async trimBlockTimes(head: number): Promise<void> {
    const keys = await this.d.redis.hkeys(ETH_BLOCK_TIMES_KEY);
    const old = keys.filter((k) => Number(k) < head - 1_000);
    if (old.length > 0) await this.d.redis.hdel(ETH_BLOCK_TIMES_KEY, ...old);
  }

  // ── Solana: Alchemy's WebSocket pushes transactions that mention a listed exchange wallet ─────

  private async solanaWallets(): Promise<string[]> {
    const rows = await exchangeLabelRows(this.d.db, 'solana');
    // Cold and reserve wallets first: they move rarely, and in large amounts.
    const rank = { cold: 0, reserve: 1, unknown: 2, hot: 3 } as const;
    return rows
      .sort((a, b) => rank[a.wallet] - rank[b.wallet] || a.address.localeCompare(b.address))
      .slice(0, SOL_MAX_WALLETS)
      .map((r) => r.address);
  }

  private async startSolana(wallets?: string[]): Promise<void> {
    const s = this.sol;
    if (!this.d.config.solWsUrl()) {
      s.state = 'no_key';
      s.detail = 'no Alchemy key in .secrets-jobs/alchemy-api-key';
      return;
    }
    this.solWallets = wallets ?? (await this.solanaWallets());
    s.watching = this.solWallets.length;
    if (this.solWallets.length === 0) {
      s.state = 'idle';
      s.detail = 'no Solana exchange wallet is listed';
      return;
    }
    s.socket = new ReconnectingSocket(
      () => this.d.config.solWsUrl() ?? '',
      {
        onOpen: (send) => {
          this.solSubs.clear();
          this.solWallets.forEach((address, i) =>
            send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: i + 1,
                method: 'logsSubscribe',
                params: [{ mentions: [address] }, { commitment: 'confirmed' }],
              }),
            ),
          );
        },
        onMessage: (data) => {
          const m = JSON.parse(data) as {
            id?: number;
            result?: unknown;
            error?: { code: number };
            method?: string;
            params?: {
              subscription: number;
              result: { context: { slot: number }; value: { signature: string; err: unknown } };
            };
          };
          if (m.error) {
            s.state = 'error';
            s.detail = `Alchemy refused a Solana subscription (${m.error.code})`;
            return;
          }
          if (typeof m.id === 'number' && typeof m.result === 'number')
            this.solSubs.set(m.result, this.solWallets[m.id - 1] ?? '');
          if (m.method !== 'logsNotification' || !m.params) return;
          const v = m.params.result.value;
          s.lastBlock = m.params.result.context.slot;
          s.lastBlockTime = this.now();
          if (v.err !== null) return;
          void this.enqueue({ kind: 'sol-tx', signature: v.signature }).catch((err: unknown) =>
            this.d.log.warn({ err }, 'could not queue a Solana transaction'),
          );
        },
        onStatus: (status, detail) => s.onSocket(status, detail),
      },
      // Quiet wallets send nothing for long stretches: only a very long silence reconnects.
      { idleTimeoutMs: 15 * 60_000, WebSocketImpl: this.d.webSocket },
    );
    s.socket.start();
  }

  // ── status ────────────────────────────────────────────────────────────────────────────────

  private async writeStatus(): Promise<void> {
    if (!this.running) return;
    const status: OnchainStatus = {
      updatedAt: this.now(),
      sources: [this.btc, this.eth, this.sol].map((s) => s.report()),
      thresholdsUsd: this.d.config.thresholdsUsd,
    };
    await this.d.redis
      .set(ONCHAIN_STATUS_KEY, JSON.stringify(status), 'PX', 120_000)
      .catch((err: unknown) => this.d.log.warn({ err }, 'on-chain status not written'));
  }
}
