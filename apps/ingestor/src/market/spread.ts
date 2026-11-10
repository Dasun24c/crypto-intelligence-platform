import type { Kysely } from 'kysely';
import { channels, type CrossVenueSpread } from '@cip/contracts';
import type { Database } from '@cip/db';
import { crossVenueSpread } from '@cip/market-data';
import type { Logger } from '@cip/observability';
import type { LivePublisher } from './live.js';
import type { InstrumentPipeline } from './pipelines.js';

export interface SpreadLegs {
  /** The primary venue's instrument, quoted in USDT or USD (Binance PAXG/USDT). */
  primary: InstrumentPipeline;
  /** The other venue's USD instrument (Coinbase PAXG-USD). */
  secondary: InstrumentPipeline;
  /** USDT-USD, the conversion for a USDT-quoted primary. */
  usdt: InstrumentPipeline | null;
}

/** Bases whose cross-venue spread is tracked (GLD-04: PAXG). */
export const SPREAD_BASES = ['PAXG'] as const;

/**
 * Cross-venue spread (architecture §5.5, GLD-04): computed every second from the venues' book mids,
 * published at 1 Hz on both instruments' `market:{id}` channels, and stored every 10 s. Nothing is
 * produced while any leg is stale: a spread from a dead feed would be misleading.
 */
export class SpreadMonitor {
  latest: CrossVenueSpread | null = null;
  stored = 0;
  private lastStoredSlot = 0;

  constructor(
    private readonly baseAsset: string,
    private readonly db: Kysely<Database>,
    private readonly live: LivePublisher,
    private readonly log: Logger,
  ) {}

  tick(now: number, legs: SpreadLegs | null): void {
    const primary = legs?.primary.mid(now) ?? null;
    const secondary = legs?.secondary.mid(now) ?? null;
    const usdt = legs?.primary.instrument.quote === 'USD' ? 1 : (legs?.usdt?.mid(now) ?? null);
    if (!legs || primary === null || secondary === null || usdt === null) {
      this.latest = null;
      return;
    }
    const { primaryUsd, spreadBps } = crossVenueSpread(primary, usdt, secondary);
    const spread: CrossVenueSpread = {
      baseAsset: this.baseAsset,
      ts: now,
      primaryInstrumentId: legs.primary.instrument.id,
      secondaryInstrumentId: legs.secondary.instrument.id,
      primaryUsd: decimal(primaryUsd, 8),
      secondaryUsd: decimal(secondary, 8),
      usdtUsd: decimal(usdt, 8),
      spreadBps: Number(spreadBps.toFixed(4)),
    };
    this.latest = spread;
    for (const id of [spread.primaryInstrumentId, spread.secondaryInstrumentId])
      this.live.publish(channels.market(id), 'spread', spread, now);

    const slot = Math.floor(now / 10_000) * 10_000;
    if (slot === this.lastStoredSlot) return;
    this.lastStoredSlot = slot;
    void this.db
      .insertInto('market.cross_venue_spreads')
      .values({
        base_asset: this.baseAsset,
        ts: new Date(slot),
        primary_instrument_id: spread.primaryInstrumentId,
        secondary_instrument_id: spread.secondaryInstrumentId,
        primary_usd: spread.primaryUsd,
        secondary_usd: spread.secondaryUsd,
        usdt_usd: spread.usdtUsd,
        spread_bps: spread.spreadBps,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
      .then(() => void this.stored++)
      .catch((err: unknown) => this.log.warn({ err, base: this.baseAsset }, 'spread insert failed'));
  }
}

/** Finds the legs among the streamed instruments: primary venue, a USD venue, and USDT-USD. */
export function spreadLegs(baseAsset: string, pipelines: Iterable<InstrumentPipeline>): SpreadLegs | null {
  const all = [...pipelines];
  const primary = all.find((p) => p.instrument.base === baseAsset && p.instrument.isPrimaryVenue);
  const secondary = all.find(
    (p) => p.instrument.base === baseAsset && p.instrument.quote === 'USD' && p !== primary,
  );
  const usdt = all.find((p) => p.instrument.base === 'USDT' && p.instrument.quote === 'USD') ?? null;
  if (!primary || !secondary) return null;
  if (primary.instrument.quote === 'USDT' && !usdt) return null;
  return { primary, secondary, usdt };
}

/** A float as a plain decimal string with at most `dp` places (no exponent for price magnitudes). */
export function decimal(x: number, dp: number): string {
  return String(Number(x.toFixed(dp)));
}
