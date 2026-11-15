import type { Kysely } from 'kysely';
import { type AlertSource, type InstrumentRef, SOURCE_OF } from '@cip/alerts';
import type { AlertRule, LevelType } from '@cip/contracts';
import { averagePrice, type Database } from '@cip/db';
import { dec, displayName, TF_MS, type Timeframe } from '@cip/domain';

const MIN = 60_000;
const t = (d: Date) => d.getTime();

/**
 * A rule's sources over stored history, for the dry run (`POST /alerts/rules/{id}/test`, criterion
 * 8.6, ADR 020): the same events the live rule reads, from the tables they are stored in. Analysis
 * output counts only from live runs, after their warm-up and while they ran, as it was published.
 * `note` says where history is coarser than the live source.
 */
export async function historySources(
  db: Kysely<Database>,
  rule: AlertRule,
  from: number,
  to: number,
): Promise<{ sources: AlertSource[]; note: string | null }> {
  const instruments = await db
    .selectFrom('market.instruments')
    .select(['id', 'venue_id', 'base_asset', 'quote_asset', 'asset_class'])
    .execute();
  const refs = new Map<string, InstrumentRef>(
    instruments
      .filter(
        (i) =>
          (!rule.scope.instrumentIds || rule.scope.instrumentIds.includes(i.id)) &&
          (!rule.scope.venues || rule.scope.venues.includes(i.venue_id)),
      )
      .map((i) => [
        i.id,
        {
          id: i.id,
          venue: i.venue_id,
          name: displayName({
            venue: i.venue_id,
            base: i.base_asset,
            quote: i.quote_asset,
            assetClass: i.asset_class,
          }),
        },
      ]),
  );
  const ids = [...refs.keys()];
  const c = rule.condition;
  const sources: AlertSource[] = [];
  const kind = SOURCE_OF[c.kind];
  const instrumentScoped = !['spread', 'economic_event', 'gold_session'].includes(kind);
  if (instrumentScoped && !ids.length) return { sources, note: null };
  const inWindow = (ms: number) => ms >= from && ms <= to;
  /** Published while the run was live: after its warm-up, before it ended. */
  const live = (decided: number, run: { from_time: Date; to_time: Date | null }) =>
    decided > t(run.from_time) && (run.to_time === null || decided <= t(run.to_time));

  switch (kind) {
    case 'price': {
      // Prices: the close of each 1m candle (the live rule reads the ticker every second).
      const windowMin = c.kind === 'price_change_pct' ? c.windowMin : 1;
      const rows = await db
        .selectFrom('market.candles')
        .select(['instrument_id', 'open_time', 'close'])
        .where('timeframe', '=', '1m')
        .where('instrument_id', 'in', ids)
        .where('open_time', '>=', new Date(from - (windowMin + 1) * MIN))
        .where('open_time', '<', new Date(to))
        .orderBy('open_time')
        .execute();
      for (const r of rows)
        sources.push({
          kind: 'price',
          instrument: refs.get(r.instrument_id)!,
          at: t(r.open_time) + MIN,
          price: r.close,
        });
      return {
        sources,
        note: 'Prices are the closes of 1m candles; the live rule reads the ticker every second.',
      };
    }
    case 'indicator': {
      if (c.kind !== 'indicator_threshold' && c.kind !== 'volume_anomaly') break;
      const tfMs = TF_MS[c.tf];
      const rows = await db
        .selectFrom('analysis.indicator_values as v')
        .innerJoin('analysis.detection_runs as r', 'r.id', 'v.run_id')
        .select([
          'v.instrument_id',
          'v.open_time',
          'v.rsi',
          'v.macd_hist',
          'v.volume_z',
          'v.atr',
          'r.from_time',
          'r.to_time',
        ])
        .where('r.mode', '=', 'live')
        .where('v.timeframe', '=', c.tf)
        .where('v.instrument_id', 'in', ids)
        // One candle more, for crossings: the previous value.
        .where('v.open_time', '>=', new Date(from - 2 * tfMs))
        .where('v.open_time', '<', new Date(to))
        .orderBy('v.open_time')
        .execute();
      for (const r of rows) {
        const closed = t(r.open_time) + tfMs;
        if (t(r.open_time) < t(r.from_time) || (r.to_time !== null && closed > t(r.to_time))) continue;
        sources.push({
          kind: 'indicator',
          instrument: refs.get(r.instrument_id)!,
          tf: c.tf,
          candleTime: t(r.open_time),
          at: closed,
          values: { rsi: r.rsi, macd_hist: r.macd_hist, volume_z: r.volume_z, atr: r.atr },
          decidedAt: closed,
          processedAt: closed,
        });
      }
      return { sources, note: null };
    }
    case 'smc': {
      if (c.kind !== 'smc_event') break;
      const tfs = c.tfs.filter((tf): tf is Exclude<Timeframe, '1m'> => tf !== '1m');
      if (!tfs.length) return { sources, note: null };
      const earliest = new Date(from - TF_MS['1d']);
      if (c.events.some((e) => e === 'sweep' || e === 'false_breakout')) {
        const rows = await db
          .selectFrom('analysis.sweeps as s')
          .innerJoin('analysis.detection_runs as r', 'r.id', 's.run_id')
          .innerJoin('analysis.liquidity_levels as l', 'l.id', 's.level_id')
          .select([
            's.id',
            's.instrument_id',
            's.timeframe',
            's.kind',
            's.level_price',
            's.confirmed_candle_time',
            'l.type as level_type',
            'r.from_time',
            'r.to_time',
          ])
          .where('r.mode', '=', 'live')
          .where('s.instrument_id', 'in', ids)
          .where('s.timeframe', 'in', tfs)
          .where('s.confirmed_candle_time', '>=', earliest)
          .where('s.confirmed_candle_time', '<', new Date(to))
          .execute();
        for (const r of rows) {
          const decided = t(r.confirmed_candle_time) + TF_MS[r.timeframe];
          if (!inWindow(decided) || !live(decided, r)) continue;
          sources.push({
            kind: 'smc',
            instrument: refs.get(r.instrument_id)!,
            tf: r.timeframe,
            event: r.kind === 'false_breakout' ? 'false_breakout' : 'sweep',
            id: r.id,
            at: decided,
            price: r.level_price,
            direction: null,
            levelType: r.level_type as LevelType,
            zoneType: null,
            decidedAt: decided,
            processedAt: decided,
          });
        }
      }
      if (c.events.some((e) => e === 'bos' || e === 'choch' || e === 'mss')) {
        const rows = await db
          .selectFrom('analysis.structure_events as s')
          .innerJoin('analysis.detection_runs as r', 'r.id', 's.run_id')
          .select([
            's.id',
            's.instrument_id',
            's.timeframe',
            's.type',
            's.direction',
            's.break_price',
            's.break_candle_time',
            'r.from_time',
            'r.to_time',
          ])
          .where('r.mode', '=', 'live')
          .where('s.instrument_id', 'in', ids)
          .where('s.timeframe', 'in', tfs)
          .where('s.break_candle_time', '>=', earliest)
          .where('s.break_candle_time', '<', new Date(to))
          .execute();
        for (const r of rows) {
          const decided = t(r.break_candle_time) + TF_MS[r.timeframe];
          if (!inWindow(decided) || !live(decided, r)) continue;
          sources.push({
            kind: 'smc',
            instrument: refs.get(r.instrument_id)!,
            tf: r.timeframe,
            event: r.type,
            id: r.id,
            at: decided,
            price: r.break_price,
            direction: r.direction,
            levelType: null,
            zoneType: null,
            decidedAt: decided,
            processedAt: decided,
          });
        }
      }
      if (c.events.includes('poi_entry')) {
        const rows = await db
          .selectFrom('analysis.poi_zones as z')
          .innerJoin('analysis.detection_runs as r', 'r.id', 'z.run_id')
          .select([
            'z.id',
            'z.instrument_id',
            'z.timeframe',
            'z.type',
            'z.direction',
            'z.top',
            'z.bottom',
            'z.first_touch_at',
            'r.from_time',
            'r.to_time',
          ])
          .where('r.mode', '=', 'live')
          .where('z.instrument_id', 'in', ids)
          .where('z.timeframe', 'in', tfs)
          .where('z.first_touch_at', '>=', new Date(from))
          .where('z.first_touch_at', '<=', new Date(to))
          .execute();
        for (const r of rows) {
          const decided = t(r.first_touch_at!);
          if (!live(decided, r)) continue;
          sources.push({
            kind: 'smc',
            instrument: refs.get(r.instrument_id)!,
            tf: r.timeframe,
            event: 'poi_entry',
            id: r.id,
            at: decided,
            price: r.direction === 'bullish' ? r.top : r.bottom,
            direction: r.direction,
            levelType: null,
            zoneType: r.type,
            decidedAt: decided,
            processedAt: decided,
          });
        }
      }
      return { sources, note: null };
    }
    case 'setup': {
      const rows = await db
        .selectFrom('analysis.setup_transitions as tr')
        .innerJoin('analysis.setups as s', 's.id', 'tr.setup_id')
        .innerJoin('analysis.detection_runs as r', 'r.id', 's.run_id')
        .select([
          'tr.setup_id',
          'tr.to_state',
          'tr.decided_at',
          'tr.processed_at',
          's.instrument_id',
          's.pattern',
          's.direction',
          's.setup_tf',
          's.confluence_score',
          'r.from_time',
          'r.to_time',
        ])
        .where('r.mode', '=', 'live')
        .where('s.instrument_id', 'in', ids)
        .where('tr.decided_at', '>=', new Date(from))
        .where('tr.decided_at', '<=', new Date(to))
        .orderBy('tr.decided_at')
        .execute();
      const live_ = rows.filter((r) => live(t(r.decided_at), r));
      // The score at each state: the checklist evaluated for it (as the transition carried it live).
      const scores = new Map<string, number>();
      if (live_.length) {
        const sums = await db
          .selectFrom('analysis.setup_checklist_results')
          .select([
            'setup_id',
            'state',
            (eb) => eb.fn.sum<string>(eb('weight', '*', eb.ref('credit'))).as('score'),
          ])
          .where('setup_id', 'in', [...new Set(live_.map((r) => r.setup_id))])
          .groupBy(['setup_id', 'state'])
          .execute();
        for (const s of sums) scores.set(`${s.setup_id}|${s.state}`, Number(s.score));
      }
      for (const r of live_)
        sources.push({
          kind: 'setup',
          instrument: refs.get(r.instrument_id)!,
          tf: r.setup_tf,
          setupId: r.setup_id,
          pattern: r.pattern,
          direction: r.direction,
          toState: r.to_state as Extract<AlertSource, { kind: 'setup' }>['toState'],
          score: scores.get(`${r.setup_id}|${r.to_state}`) ?? Number(r.confluence_score),
          at: t(r.decided_at),
          decidedAt: t(r.decided_at),
          processedAt: t(r.processed_at),
        });
      return { sources, note: null };
    }
    case 'spread': {
      const rows = await db
        .selectFrom('market.cross_venue_spreads')
        .select(['ts', 'spread_bps'])
        .where('base_asset', '=', 'PAXG')
        .where('ts', '>=', new Date(from))
        .where('ts', '<=', new Date(to))
        .orderBy('ts')
        .execute();
      for (const r of rows)
        sources.push({ kind: 'spread', baseAsset: 'PAXG', at: t(r.ts), bps: r.spread_bps });
      return { sources, note: null };
    }
    case 'economic_event': {
      if (c.kind !== 'economic_event_upcoming') break;
      const lead = c.minutesBefore * MIN;
      const rows = await db
        .selectFrom('market.economic_events')
        .select(['id', 'title', 'scheduled_at', 'impact', 'currency'])
        .where('status', '=', 'scheduled')
        .where('scheduled_at', '>', new Date(from))
        .where('scheduled_at', '<=', new Date(to + lead))
        .execute();
      // The live clock ticks every 5 s: the alert fires at the first tick inside the lead time.
      for (const r of rows) {
        const at = Math.max(from, t(r.scheduled_at) - lead);
        if (at > to || at >= t(r.scheduled_at)) continue;
        sources.push({
          kind: 'economic_event',
          at,
          event: {
            id: r.id,
            title: r.title,
            scheduledAt: t(r.scheduled_at),
            impact: r.impact,
            currency: r.currency,
          },
        });
      }
      return { sources, note: null };
    }
    case 'gold_session': {
      const rows = await db
        .selectFrom('market.underlying_market_closures')
        .select(['starts_at', 'ends_at'])
        .where('calendar_id', '=', 'gold')
        .where('ends_at', '>=', new Date(from))
        .where('starts_at', '<=', new Date(to))
        .execute();
      for (const r of rows) {
        if (inWindow(t(r.starts_at)))
          sources.push({
            kind: 'gold_session',
            at: t(r.starts_at),
            change: 'close',
            boundaryAt: t(r.starts_at),
          });
        if (inWindow(t(r.ends_at)))
          sources.push({ kind: 'gold_session', at: t(r.ends_at), change: 'open', boundaryAt: t(r.ends_at) });
      }
      return { sources, note: null };
    }
    case 'large_trade': {
      const rows = await db
        .selectFrom('market.large_trades')
        .select(['id', 'instrument_id', 'ts', 'taker_side', 'avg_price', 'notional_usd'])
        .where('instrument_id', 'in', ids)
        .where('ts', '>=', new Date(from))
        .where('ts', '<=', new Date(to))
        .execute();
      for (const r of rows)
        sources.push({
          kind: 'large_trade',
          instrument: refs.get(r.instrument_id)!,
          id: r.id,
          at: t(r.ts),
          side: r.taker_side,
          price: r.avg_price,
          usd: r.notional_usd,
          processedAt: t(r.ts),
        });
      return { sources, note: null };
    }
    case 'wall': {
      const rows = await db
        .selectFrom('market.orderbook_walls')
        .select([
          'id',
          'instrument_id',
          'side',
          'price',
          'first_seen',
          'last_seen',
          'max_notional_usd',
          'ended_reason',
        ])
        .where('instrument_id', 'in', ids)
        .where('last_seen', '>=', new Date(from))
        .where('first_seen', '<=', new Date(to))
        .execute();
      for (const r of rows) {
        const base = {
          kind: 'wall' as const,
          instrument: refs.get(r.instrument_id)!,
          id: r.id,
          side: r.side,
          price: r.price,
          usd: r.max_notional_usd,
        };
        if (inWindow(t(r.first_seen)))
          sources.push({ ...base, at: t(r.first_seen), event: 'appeared', processedAt: t(r.first_seen) });
        if ((r.ended_reason === 'filled' || r.ended_reason === 'pulled') && inWindow(t(r.last_seen)))
          sources.push({ ...base, at: t(r.last_seen), event: r.ended_reason, processedAt: t(r.last_seen) });
      }
      return { sources, note: null };
    }
    case 'feed': {
      const gaps = await db
        .selectFrom('market.data_gaps')
        .select(['id', 'instrument_id', 'stream', 'gap_start', 'detected_at', 'detected_by'])
        .where('instrument_id', 'in', ids)
        .where('detected_at', '>=', new Date(from))
        .where('detected_at', '<=', new Date(to))
        .execute();
      for (const g of gaps)
        sources.push({
          kind: 'feed',
          instrument: refs.get(g.instrument_id)!,
          id: g.id,
          at: t(g.detected_at),
          event: 'gap',
          detail: `Missing ${g.stream} data from ${g.gap_start.toISOString().slice(0, 16).replace('T', ' ')} UTC (${g.detected_by}).`,
          processedAt: t(g.detected_at),
        });
      // Halts and delistings (the pair-status job's log). Delays and disconnections of a live feed are
      // announced on md:events only, so a dry run cannot list them.
      const statuses = await db
        .selectFrom('market.feed_events')
        .select(['ts', 'instrument_id', 'details'])
        .where('event', '=', 'status_change')
        .where('instrument_id', 'in', ids)
        .where('ts', '>=', new Date(from))
        .where('ts', '<=', new Date(to))
        .execute();
      for (const s of statuses) {
        const status = s.details['to'];
        if ((status !== 'halted' && status !== 'delisted') || !s.instrument_id) continue;
        sources.push({
          kind: 'feed',
          instrument: refs.get(s.instrument_id)!,
          id: `status:${s.instrument_id}:${t(s.ts)}`,
          at: t(s.ts),
          event: status,
          detail: `Venue status ${String(s.details['from'])} → ${status}.`,
          processedAt: t(s.ts),
        });
      }
      return {
        sources,
        note: 'Delays and disconnections of a live feed are not stored, so only gaps, halts and delistings are listed.',
      };
    }
    case 'practice': {
      // The rule owner's own practice orders (ADR 021), as each stands now, at its last change.
      const rows = await db
        .selectFrom('trading.orders as o')
        .innerJoin('trading.accounts as a', 'a.id', 'o.account_id')
        .select([
          'o.id',
          'o.instrument_id',
          'o.side',
          'o.type',
          'o.status',
          'o.filled_quantity',
          'o.filled_value',
          'o.updated_at',
        ])
        .where('a.user_id', '=', rule.ownerId)
        .where('o.instrument_id', 'in', ids)
        .where('o.filled_quantity', '>', '0')
        .where('o.updated_at', '>=', new Date(from))
        .where('o.updated_at', '<=', new Date(to))
        .orderBy('o.updated_at')
        .execute();
      for (const r of rows) {
        const event =
          r.type === 'stop'
            ? 'stop_filled'
            : r.type === 'target'
              ? 'target_filled'
              : r.status === 'filled' || r.status === 'cancelled'
                ? 'order_done'
                : null;
        const price = averagePrice(r.filled_value, r.filled_quantity);
        if (!event || price === null) continue;
        sources.push({
          kind: 'practice',
          userId: rule.ownerId,
          instrument: refs.get(r.instrument_id)!,
          at: t(r.updated_at),
          event,
          orderId: r.id,
          side: r.side,
          quantity: dec(r.filled_quantity).toString(),
          price,
          processedAt: t(r.updated_at),
        });
      }
      return {
        sources,
        note: 'Practice orders as they stand now, each at the time of its last change.',
      };
    }
  }
  return { sources, note: null };
}
