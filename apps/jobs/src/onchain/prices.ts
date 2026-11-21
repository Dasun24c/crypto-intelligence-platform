import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { ONCHAIN_ASSETS, type OnchainAsset, TickerSchema } from '@cip/contracts';
import type { Database } from '@cip/db';
import { mulDecimal } from '@cip/domain';

/** A ticker older than this gives no price: a stale value would mislabel what counts as large. */
const FRESH_MS = 5 * 60_000;
/** Instruments are looked up again this often (an admin may enable one). */
const INSTRUMENTS_EVERY_MS = 10 * 60_000;

interface Pair {
  id: string;
  base: string;
  quote: string;
}

/**
 * USD prices from the platform's own live tickers (ADR 025): a USD pair when one streams, else the
 * USDT pair times USDT's USD price (1 when that is not streamed either).
 */
export class OnchainPrices {
  private pairs: Pair[] = [];
  private loadedAt = 0;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async current(): Promise<Record<OnchainAsset, string | null>> {
    if (this.now() - this.loadedAt > INSTRUMENTS_EVERY_MS) {
      this.pairs = await this.db
        .selectFrom('market.instruments')
        .select(['id', 'base_asset as base', 'quote_asset as quote'])
        .where('enabled', '=', true)
        .where('base_asset', 'in', [...ONCHAIN_ASSETS, 'USDT'])
        .where('quote_asset', 'in', ['USD', 'USDT'])
        .execute();
      this.loadedAt = this.now();
    }
    const out = Object.fromEntries(ONCHAIN_ASSETS.map((a) => [a, null])) as Record<
      OnchainAsset,
      string | null
    >;
    if (this.pairs.length === 0) return out;
    const raw = await this.redis.mget(this.pairs.map((p) => `ticker:${p.id}`));
    const last = new Map<string, string>();
    raw.forEach((value, i) => {
      if (!value) return;
      const t = TickerSchema.safeParse(JSON.parse(value));
      if (t.success && this.now() - t.data.ts <= FRESH_MS) {
        const p = this.pairs[i]!;
        last.set(`${p.base}/${p.quote}`, t.data.last);
      }
    });
    const usdt = last.get('USDT/USD') ?? '1';
    for (const asset of ONCHAIN_ASSETS) {
      const usd = last.get(`${asset}/USD`);
      const viaUsdt = last.get(`${asset}/USDT`);
      out[asset] = usd ?? (viaUsdt ? mulDecimal(viaUsdt, usdt) : null);
    }
    return out;
  }
}
