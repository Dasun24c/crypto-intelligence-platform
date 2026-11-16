import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import {
  type AiContext,
  channels,
  type ChecklistItem,
  type LevelType,
  type Tf,
  TickerSchema,
} from '@cip/contracts';
import type { Database } from '@cip/db';
import { displayName } from '@cip/domain';
import { shortId, trimContext } from '@cip/ai';

const TFS: Tf[] = ['15m', '1h', '4h', '1d'];
const INDICATORS = [
  ['rsi', 'rsi'],
  ['macd_hist', 'macd_hist'],
  ['atr', 'atr'],
  ['volume_z', 'volume_z'],
  ['ema_fast', 'ema_fast'],
  ['ema_slow', 'ema_slow'],
] as const;
const HOUR = 3_600_000;
const MAX_LEVELS = 20;
const MAX_ZONES = 12;
const MAX_EVENTS = 30;

/** Doubles from the database, at a readable precision: what the model copies is what was sent. */
const round = (v: number) => Number(v.toPrecision(6));

export interface BuiltContext {
  context: AiContext;
  /** Items dropped to fit the token budget. */
  dropped: number;
  /** The analysis run the context came from, if any. */
  runId: string | null;
  /** The setup a review asked about, as the context names it. */
  setupRef: string | null;
}

/**
 * Builds the context the model sees (API contracts §6.1, ADR 023) from the database and Redis:
 * every item with a short stable id, prices as the database's decimal strings. It reads the
 * instrument's live analysis run only.
 */
export class ContextBuilder {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
  ) {}

  async build(
    instrumentId: string,
    now: number,
    opts: { setupId?: string | null } = {},
  ): Promise<BuiltContext> {
    const instrument = await this.db
      .selectFrom('market.instruments')
      .selectAll()
      .where('id', '=', instrumentId)
      .executeTakeFirstOrThrow();
    const run = await this.db
      .selectFrom('analysis.detection_runs')
      .select(['id', 'status'])
      .where('instrument_id', '=', instrumentId)
      .where('mode', '=', 'live')
      .where('status', 'in', ['running', 'warming_up'])
      .orderBy('started_at', 'desc')
      .executeTakeFirst();
    const ids = new Set<string>(['instr', 'mkt', 'gold']);

    // The market, from the ingestor's ticker.
    const raw = await this.redis.get(channels.ticker(instrumentId));
    const ticker = raw ? TickerSchema.safeParse(JSON.parse(raw)) : null;
    const t = ticker?.success ? ticker.data : null;
    const mid = t ? (Number(t.bid) + Number(t.ask)) / 2 : 0;
    const last = t ? Number(t.last) : null;

    const context: AiContext = {
      contextVersion: '1',
      asOf: now,
      instrument: {
        id: 'instr',
        displayName: displayName({
          venue: instrument.venue_id,
          base: instrument.base_asset,
          quote: instrument.quote_asset,
          assetClass: instrument.asset_class,
        }),
        assetClass: instrument.asset_class,
        venue: instrument.venue_id,
      },
      market: {
        id: 'mkt',
        last: t?.last ?? null,
        change24hPct: t ? Math.round(t.change24hPct * 100) / 100 : null,
        // USDT and USD quotes count 1:1 here; the volume is context, not a price.
        volume24hUsd: t ? Math.round(Number(t.volume24hQuote)) : null,
        spreadBps:
          t && mid > 0 ? Math.round(((Number(t.ask) - Number(t.bid)) / mid) * 10_000 * 100) / 100 : null,
      },
      indicators: [],
      structure: [],
      levels: [],
      zones: [],
      setups: [],
      recentEvents: [],
      calendar: [],
      dataQuality: [],
    };

    if (instrument.underlying_calendar_id)
      context.goldMarket = await this.gold(instrument.underlying_calendar_id, instrument.base_asset, now);

    let setupRef: string | null = null;
    if (run) {
      const atr1h = await this.indicators(context, run.id);
      await this.structure(context, run.id);
      await this.levels(context, run.id, last, atr1h, now, ids);
      await this.zones(context, run.id, last, ids);
      setupRef = await this.setups(context, run.id, ids, opts.setupId ?? null);
      await this.events(context, run.id, now, ids);
      if (run.status === 'warming_up')
        context.dataQuality.push({
          id: 'dq:analysis',
          code: 'warming_up',
          detail: 'The analysis is still warming up.',
        });
    } else
      context.dataQuality.push({
        id: 'dq:analysis',
        code: 'no_run',
        detail: 'No live analysis for this instrument.',
      });
    await this.calendar(context, now, ids);
    await this.quality(context, instrumentId, instrument.venue_id);
    if (!t) context.dataQuality.push({ id: 'dq:ticker', code: 'no_ticker', detail: 'No live ticker.' });

    const { context: trimmed, dropped } = trimContext(context);
    return { context: trimmed, dropped, runId: run?.id ?? null, setupRef };
  }

  private async gold(
    calendarId: string,
    base: string,
    now: number,
  ): Promise<NonNullable<AiContext['goldMarket']>> {
    const at = new Date(now);
    const current = await this.db
      .selectFrom('market.underlying_market_closures')
      .select(['starts_at', 'ends_at'])
      .where('calendar_id', '=', calendarId)
      .where('starts_at', '<=', at)
      .where('ends_at', '>', at)
      .orderBy('ends_at', 'desc')
      .executeTakeFirst();
    const next = current
      ? null
      : await this.db
          .selectFrom('market.underlying_market_closures')
          .select('starts_at')
          .where('calendar_id', '=', calendarId)
          .where('starts_at', '>', at)
          .orderBy('starts_at')
          .executeTakeFirst();
    const spread = await this.db
      .selectFrom('market.cross_venue_spreads')
      .select('spread_bps')
      .where('base_asset', '=', base)
      .where('ts', '>=', new Date(now - HOUR))
      .orderBy('ts', 'desc')
      .executeTakeFirst();
    return {
      id: 'gold',
      status: current ? 'closed' : 'open',
      nextChangeAt: current ? current.ends_at.getTime() : (next?.starts_at.getTime() ?? null),
      crossVenueSpreadBps: spread ? Math.round(spread.spread_bps * 100) / 100 : null,
    };
  }

  /** The latest closed candle's indicators per timeframe; returns the 1h ATR. */
  private async indicators(c: AiContext, runId: string): Promise<number | null> {
    let atr1h: number | null = null;
    for (const tf of TFS) {
      const row = await this.db
        .selectFrom('analysis.indicator_values')
        .selectAll()
        .where('run_id', '=', runId)
        .where('timeframe', '=', tf)
        .orderBy('open_time', 'desc')
        .executeTakeFirst();
      if (!row) continue;
      for (const [name, col] of INDICATORS) {
        const v = row[col];
        if (v === null || !Number.isFinite(v)) continue;
        c.indicators.push({ id: `ind:${tf}:${name}`, tf, name, value: round(v) });
      }
      if (tf === '1h') atr1h = row.atr;
    }
    return atr1h;
  }

  private async structure(c: AiContext, runId: string): Promise<void> {
    for (const tf of TFS) {
      const e = await this.db
        .selectFrom('analysis.structure_events')
        .select(['type', 'direction', 'break_price', 'break_candle_time'])
        .where('run_id', '=', runId)
        .where('timeframe', '=', tf)
        .orderBy('break_candle_time', 'desc')
        .executeTakeFirst();
      c.structure.push({
        id: `str:${tf}`,
        tf,
        trend: e ? e.direction : 'undefined',
        lastEvent: e
          ? { type: e.type, direction: e.direction, price: e.break_price, at: e.break_candle_time.getTime() }
          : null,
      });
    }
  }

  private async levels(
    c: AiContext,
    runId: string,
    last: number | null,
    atr: number | null,
    now: number,
    ids: Set<string>,
  ): Promise<void> {
    const rows = await this.db
      .selectFrom('analysis.liquidity_levels')
      .select(['id', 'origin_timeframe', 'type', 'price', 'status', 'status_changed_at'])
      .where('run_id', '=', runId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'active'),
          eb.and([eb('status', '=', 'swept'), eb('status_changed_at', '>=', new Date(now - 6 * HOUR))]),
        ]),
      )
      .execute();
    const distance = (p: string) =>
      last === null || !atr ? null : Math.round((Math.abs(Number(p) - last) / atr) * 10) / 10;
    rows
      .map((r) => ({ r, d: distance(r.price) }))
      .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity))
      .slice(0, MAX_LEVELS)
      .forEach(({ r, d }) =>
        c.levels.push({
          id: shortId('lvl', r.id, ids),
          tf: r.origin_timeframe,
          type: r.type as LevelType,
          price: r.price,
          distanceAtr: d,
          status: r.status,
        }),
      );
  }

  private async zones(c: AiContext, runId: string, last: number | null, ids: Set<string>): Promise<void> {
    const rows = await this.db
      .selectFrom('analysis.poi_zones')
      .select(['id', 'timeframe', 'type', 'direction', 'top', 'bottom', 'status', 'fill_pct'])
      .where('run_id', '=', runId)
      .where('status', 'in', ['untouched', 'partially_filled'])
      .execute();
    const distance = (z: { top: string; bottom: string }) =>
      last === null ? 0 : Math.min(Math.abs(Number(z.top) - last), Math.abs(Number(z.bottom) - last));
    rows
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, MAX_ZONES)
      .forEach((z) =>
        c.zones.push({
          id: shortId('zone', z.id, ids),
          tf: z.timeframe,
          type: z.type,
          direction: z.direction,
          top: z.top,
          bottom: z.bottom,
          status: z.status,
          fillPct: Number(z.fill_pct),
        }),
      );
  }

  /** Live setups, and a reviewed one even if resolved; returns the reviewed one's id in the context. */
  private async setups(
    c: AiContext,
    runId: string,
    ids: Set<string>,
    reviewed: string | null,
  ): Promise<string | null> {
    const rows = await this.db
      .selectFrom('analysis.setups')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb('run_id', '=', runId), eb('state', '!=', 'resolved')]),
          ...(reviewed ? [eb('id', '=', reviewed)] : []),
        ]),
      )
      .orderBy('updated_candle_time', 'desc')
      .limit(10)
      .execute();
    const checklists = rows.length
      ? await this.db
          .selectFrom('analysis.setup_checklist_results')
          .select(['setup_id', 'state', 'item', 'credit'])
          .where(
            'setup_id',
            'in',
            rows.map((r) => r.id),
          )
          .execute()
      : [];
    let ref: string | null = null;
    for (const s of rows) {
      const id = shortId('setup', s.id, ids);
      if (s.id === reviewed) ref = id;
      c.setups.push({
        id,
        pattern: s.pattern,
        direction: s.direction,
        state: s.state,
        entry: s.entry_price,
        invalidation: s.invalidation_price,
        target1: s.target1_price,
        rr: s.rr_target1 === null ? null : round(s.rr_target1),
        score: Number(s.confluence_score),
        checklist: checklists
          .filter((x) => x.setup_id === s.id && x.state === s.state)
          .map((x) => ({ item: x.item as ChecklistItem, credit: x.credit })),
        flags: [...s.quality_flags, ...s.flags],
      });
    }
    return ref;
  }

  /** The last 6 h of structure shifts, sweeps and setup transitions, newest first. */
  private async events(c: AiContext, runId: string, now: number, ids: Set<string>): Promise<void> {
    const since = new Date(now - 6 * HOUR);
    const [structure, sweeps, transitions] = await Promise.all([
      this.db
        .selectFrom('analysis.structure_events')
        .select(['id', 'timeframe', 'type', 'direction', 'break_price', 'break_candle_time'])
        .where('run_id', '=', runId)
        .where('break_candle_time', '>=', since)
        .execute(),
      this.db
        .selectFrom('analysis.sweeps as w')
        .innerJoin('analysis.liquidity_levels as l', 'l.id', 'w.level_id')
        .select(['w.id', 'w.timeframe', 'w.kind', 'w.level_price', 'w.confirmed_candle_time', 'l.type'])
        .where('w.run_id', '=', runId)
        .where('w.confirmed_candle_time', '>=', since)
        .execute(),
      this.db
        .selectFrom('analysis.setup_transitions as t')
        .innerJoin('analysis.setups as s', 's.id', 't.setup_id')
        .select([
          't.id',
          't.from_state',
          't.to_state',
          't.decided_at',
          's.pattern',
          's.direction',
          's.id as setup_id',
        ])
        .where('s.run_id', '=', runId)
        .where('t.decided_at', '>=', since)
        .execute(),
    ]);
    const all: AiContext['recentEvents'] = [
      ...structure.map((e) => ({
        id: shortId('evt', e.id, ids),
        at: e.break_candle_time.getTime(),
        type: 'structure',
        summary: `${e.direction} ${e.type.toUpperCase()} on ${e.timeframe} at ${e.break_price}`,
      })),
      ...sweeps.map((w) => ({
        id: shortId('evt', w.id, ids),
        at: w.confirmed_candle_time.getTime(),
        type: 'sweep',
        summary: `${w.kind === 'wick' ? 'Sweep' : 'False breakout'} of the ${w.type} at ${w.level_price} on ${w.timeframe}`,
      })),
      ...transitions.map((t) => ({
        id: transitionId(t.setup_id, t.id, ids),
        at: t.decided_at.getTime(),
        type: 'setup',
        summary: `${t.direction} ${t.pattern} setup: ${t.from_state ?? 'new'} to ${t.to_state}`,
      })),
    ];
    c.recentEvents = all.sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);
  }

  private async calendar(c: AiContext, now: number, ids: Set<string>): Promise<void> {
    const rows = await this.db
      .selectFrom('market.economic_events')
      .select(['id', 'title', 'impact', 'scheduled_at'])
      .where('status', '=', 'scheduled')
      .where('impact', 'in', ['medium', 'high'])
      .where('scheduled_at', '>=', new Date(now))
      .where('scheduled_at', '<', new Date(now + 48 * HOUR))
      .orderBy('scheduled_at')
      .limit(12)
      .execute();
    for (const e of rows)
      c.calendar.push({
        id: shortId('cal', e.id, ids),
        at: e.scheduled_at.getTime(),
        title: e.title,
        impact: e.impact,
      });
  }

  private async quality(c: AiContext, instrumentId: string, venue: string): Promise<void> {
    const gaps = await this.db
      .selectFrom('market.data_gaps')
      .select(['stream', 'gap_start'])
      .where('instrument_id', '=', instrumentId)
      .where('status', 'in', ['open', 'backfilling'])
      .execute();
    for (const g of gaps)
      c.dataQuality.push({
        id: `dq:gap:${g.stream}`,
        code: 'data_gap',
        detail: `The ${g.stream} stream has a gap since ${new Date(g.gap_start).toISOString().slice(0, 16)}Z.`,
      });
    const status = await this.redis.get(`feed:status:${venue}`);
    try {
      const feeds = (
        JSON.parse(status ?? '{}') as { feeds?: { instrumentId: string; stream: string; state: string }[] }
      ).feeds;
      for (const f of feeds ?? [])
        if (f.instrumentId === instrumentId && f.state !== 'connected')
          c.dataQuality.push({
            id: `dq:feed:${f.stream}`,
            code: 'feed_' + f.state,
            detail: `The ${f.stream} feed is ${f.state}.`,
          });
    } catch {
      // No readable feed status: nothing to report.
    }
  }
}

/** A setup transition's id in the context: the end of its setup's, and its number (`evt:5e6f7a8b:123`). */
function transitionId(setupId: string, n: string, ids: Set<string>): string {
  const id = `evt:${setupId.replace(/-/g, '').slice(-8)}:${n}`;
  ids.add(id);
  return id;
}
