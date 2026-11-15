import { compareDecimal } from '@cip/domain';
import { describe } from './messages.js';
import type { AlertMatch, EvaluableRule, Found } from './types.js';

export type { AlertMatch, EvaluableRule, Found } from './types.js';
import { type AlertSource, isLate, SOURCE_OF } from './sources.js';

const MIN = 60_000;
const IMPACT_RANK = { low: 0, medium: 1, high: 2 } as const;
/** Price history kept per instrument: one day of minutes, the longest `price_change_pct` window. */
const PRICE_MINUTES = 1441;
/** Occurrences remembered per evaluator, so a repeated source does not reach the cooldown again. */
const SEEN_LIMIT = 20_000;

/** What the stateful conditions remember: prices, indicator values, each rule's edge, and what fired. */
export class AlertMemory {
  private readonly prices = new Map<
    string,
    { minutes: Map<number, string>; firstAt: number; last: string }
  >();
  private readonly indicators = new Map<string, number>();
  private readonly edges = new Map<string, boolean>();
  private readonly seen = new Map<string, true>();

  lastPrice(instrumentId: string): string | null {
    return this.prices.get(instrumentId)?.last ?? null;
  }

  /** The first price seen in the minute `windowMin` before `at`, if the history reaches that far back. */
  priceBefore(instrumentId: string, at: number, windowMin: number): string | null {
    const p = this.prices.get(instrumentId);
    const from = at - windowMin * MIN;
    if (!p || p.firstAt > from) return null;
    for (let m = Math.floor(from / MIN) * MIN; m <= at; m += MIN) {
      const v = p.minutes.get(m);
      if (v !== undefined) return v;
    }
    return null;
  }

  indicator(instrumentId: string, tf: string, name: string): number | null {
    return this.indicators.get(`${instrumentId}:${tf}:${name}`) ?? null;
  }

  /** True when `holds` became true: it was false (or unknown) the last time this key was evaluated. */
  rise(key: string, holds: boolean): boolean {
    const before = this.edges.get(key) ?? false;
    this.edges.set(key, holds);
    return holds && !before;
  }

  hasFired(ruleId: string, dedupeKey: string): boolean {
    return this.seen.has(`${ruleId}|${dedupeKey}`);
  }

  markFired(ruleId: string, dedupeKey: string): void {
    this.seen.set(`${ruleId}|${dedupeKey}`, true);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Records a source after every rule has read the state before it. */
  observe(source: AlertSource): void {
    if (source.kind === 'price') {
      let p = this.prices.get(source.instrument.id);
      if (!p) {
        p = { minutes: new Map(), firstAt: source.at, last: source.price };
        this.prices.set(source.instrument.id, p);
      }
      p.last = source.price;
      const minute = Math.floor(source.at / MIN) * MIN;
      if (!p.minutes.has(minute)) p.minutes.set(minute, source.price);
      // Maps iterate in insertion order: drop minutes older than a day.
      for (const m of p.minutes.keys()) {
        if (m >= minute - PRICE_MINUTES * MIN) break;
        p.minutes.delete(m);
      }
    } else if (source.kind === 'indicator') {
      for (const [name, value] of Object.entries(source.values))
        if (value !== null) this.indicators.set(`${source.instrument.id}:${source.tf}:${name}`, value);
    }
  }
}

function inScope(rule: EvaluableRule, source: AlertSource): boolean {
  if (!('instrument' in source)) return true;
  const { instrumentIds, venues } = rule.scope;
  if (instrumentIds && !instrumentIds.includes(source.instrument.id)) return false;
  if (venues && !venues.includes(source.instrument.venue)) return false;
  return true;
}

/**
 * Evaluates rules against source events in order (ADR 020). Stateful conditions (crossings, % change,
 * the spread) read the memory as it was before each source; `evaluate` then records the source.
 */
export class AlertEvaluator {
  constructor(readonly memory = new AlertMemory()) {}

  evaluate(
    rules: readonly EvaluableRule[],
    source: AlertSource,
  ): { rule: EvaluableRule; match: AlertMatch }[] {
    const out: { rule: EvaluableRule; match: AlertMatch }[] = [];
    for (const rule of rules) {
      if (SOURCE_OF[rule.condition.kind] !== source.kind || !inScope(rule, source)) continue;
      const found = this.find(rule, source);
      if (!found) continue;
      const { title, body } = describe(rule, source, found);
      out.push({
        rule,
        match: {
          dedupeKey: found.dedupeKey,
          subject: found.subject,
          at: source.at,
          title,
          body,
          instrumentId: 'instrument' in source ? source.instrument.id : null,
          sourceRefs: found.refs,
          late: isLate(source),
        },
      });
    }
    this.memory.observe(source);
    return out;
  }

  private find(rule: EvaluableRule, source: AlertSource): Found | null {
    const c = rule.condition;
    const m = this.memory;
    switch (c.kind) {
      case 'price_cross': {
        if (source.kind !== 'price') return null;
        const id = source.instrument.id;
        const prev = m.lastPrice(id);
        if (prev === null) return null;
        const crossed =
          c.direction === 'above'
            ? compareDecimal(prev, c.price) < 0 && compareDecimal(source.price, c.price) >= 0
            : compareDecimal(prev, c.price) > 0 && compareDecimal(source.price, c.price) <= 0;
        if (!crossed) return null;
        return {
          dedupeKey: `price_cross:${id}:${c.direction}:${c.price}:${source.at}`,
          subject: id,
          refs: { instrumentId: id, price: source.price, previous: prev, threshold: c.price },
          facts: { price: source.price },
        };
      }
      case 'price_change_pct': {
        if (source.kind !== 'price') return null;
        const id = source.instrument.id;
        const ref = m.priceBefore(id, source.at, c.windowMin);
        if (ref === null) return null;
        const change = ((Number(source.price) - Number(ref)) / Number(ref)) * 100;
        if (!m.rise(`${rule.id}:${id}`, Math.abs(change) >= c.pct)) return null;
        return {
          dedupeKey: `price_change_pct:${id}:${source.at}`,
          subject: id,
          refs: { instrumentId: id, price: source.price, reference: ref, changePct: round(change, 3) },
          facts: { price: source.price, reference: ref, change },
        };
      }
      case 'indicator_threshold': {
        if (source.kind !== 'indicator' || source.tf !== c.tf) return null;
        const id = source.instrument.id;
        const v = source.values[c.indicator];
        if (v === null) return null;
        const prev = m.indicator(id, source.tf, c.indicator);
        const hit =
          c.op === '>'
            ? v > c.value
            : c.op === '<'
              ? v < c.value
              : c.op === 'cross_above'
                ? prev !== null && prev <= c.value && v > c.value
                : prev !== null && prev >= c.value && v < c.value;
        if (!hit) return null;
        return {
          dedupeKey: `indicator:${id}:${source.tf}:${c.indicator}:${c.op}:${c.value}:${source.candleTime}`,
          subject: id,
          refs: { instrumentId: id, tf: source.tf, candleTime: source.candleTime, [c.indicator]: v },
          facts: { value: v },
        };
      }
      case 'volume_anomaly': {
        if (source.kind !== 'indicator' || source.tf !== c.tf) return null;
        const z = source.values.volume_z;
        if (z === null || z < c.minZ) return null;
        const id = source.instrument.id;
        return {
          dedupeKey: `volume:${id}:${source.tf}:${source.candleTime}`,
          subject: id,
          refs: { instrumentId: id, tf: source.tf, candleTime: source.candleTime, volumeZ: z },
          facts: { z },
        };
      }
      case 'smc_event': {
        if (source.kind !== 'smc' || !c.tfs.includes(source.tf) || !c.events.includes(source.event))
          return null;
        const swept = source.event === 'sweep' || source.event === 'false_breakout';
        if (swept && c.levelTypes && (source.levelType === null || !c.levelTypes.includes(source.levelType)))
          return null;
        if (
          source.event === 'poi_entry' &&
          c.zoneTypes &&
          (source.zoneType === null || !c.zoneTypes.includes(source.zoneType))
        )
          return null;
        return {
          dedupeKey: `smc:${source.event}:${source.id}`,
          subject: source.instrument.id,
          refs: {
            instrumentId: source.instrument.id,
            tf: source.tf,
            event: source.event,
            detectionId: source.id,
            price: source.price,
          },
          facts: { price: source.price },
        };
      }
      case 'setup_transition': {
        if (source.kind !== 'setup' || !c.toStates.includes(source.toState)) return null;
        if (c.patterns && !c.patterns.includes(source.pattern)) return null;
        if (c.directions && !c.directions.includes(source.direction)) return null;
        if (c.minScore !== undefined && source.score < c.minScore) return null;
        return {
          dedupeKey: `setup:${source.setupId}:${source.toState}`,
          subject: source.instrument.id,
          refs: {
            instrumentId: source.instrument.id,
            tf: source.tf,
            setupId: source.setupId,
            toState: source.toState,
            score: source.score,
          },
          facts: { score: source.score },
        };
      }
      case 'spread_threshold': {
        if (source.kind !== 'spread') return null;
        if (!m.rise(`${rule.id}:PAXG`, Math.abs(source.bps) >= c.absBps)) return null;
        return {
          dedupeKey: `spread:${source.at}`,
          subject: 'PAXG',
          refs: { baseAsset: 'PAXG', bps: round(source.bps, 2) },
          facts: { bps: source.bps },
        };
      }
      case 'economic_event_upcoming': {
        if (source.kind !== 'economic_event') return null;
        const e = source.event;
        if (IMPACT_RANK[e.impact] < IMPACT_RANK[c.minImpact]) return null;
        if (source.at < e.scheduledAt - c.minutesBefore * MIN || source.at >= e.scheduledAt) return null;
        return {
          dedupeKey: `economic:${e.id}:${e.scheduledAt}:${c.minutesBefore}`,
          subject: `economic:${e.id}`,
          refs: { economicEventId: e.id, scheduledAt: e.scheduledAt, impact: e.impact },
          facts: { minutes: Math.ceil((e.scheduledAt - source.at) / MIN) },
        };
      }
      case 'gold_market_session': {
        if (source.kind !== 'gold_session' || !c.on.includes(source.change)) return null;
        return {
          dedupeKey: `gold_session:${source.change}:${source.boundaryAt}`,
          subject: 'gold',
          refs: { change: source.change, at: source.boundaryAt },
          facts: {},
        };
      }
      case 'large_trade': {
        if (source.kind !== 'large_trade') return null;
        if (c.sides && !c.sides.includes(source.side)) return null;
        if (c.minUsd && compareDecimal(source.usd, c.minUsd) < 0) return null;
        return {
          dedupeKey: `large_trade:${source.id}`,
          subject: source.instrument.id,
          refs: {
            instrumentId: source.instrument.id,
            tradeId: source.id,
            usd: source.usd,
            price: source.price,
          },
          facts: { usd: source.usd, price: source.price },
        };
      }
      case 'wall': {
        if (source.kind !== 'wall' || !c.events.includes(source.event)) return null;
        if (c.minUsd && compareDecimal(source.usd, c.minUsd) < 0) return null;
        return {
          dedupeKey: `wall:${source.id}:${source.event}`,
          subject: source.instrument.id,
          refs: {
            instrumentId: source.instrument.id,
            wallId: source.id,
            usd: source.usd,
            price: source.price,
          },
          facts: { usd: source.usd, price: source.price },
        };
      }
      case 'feed_health': {
        if (source.kind !== 'feed' || !c.events.includes(source.event)) return null;
        return {
          dedupeKey: `feed:${source.event}:${source.id}`,
          subject: source.instrument.id,
          refs: { instrumentId: source.instrument.id, event: source.event, ref: source.id },
          facts: {},
        };
      }
    }
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** A cooldown per rule and subject; the analyzer's lives in Redis, the dry run's in memory. */
export interface CooldownGate {
  /** True, and the cooldown starts, if none is running for `key` at `at`. */
  tryAcquire(key: string, at: number, ms: number): boolean | Promise<boolean>;
}

export const cooldownKey = (ruleId: string, subject: string) => `${ruleId}:${subject}`;

export class MemoryCooldown implements CooldownGate {
  private readonly until = new Map<string, number>();

  tryAcquire(key: string, at: number, ms: number): boolean {
    const until = this.until.get(key);
    if (until !== undefined && at < until) return false;
    if (ms > 0) this.until.set(key, at + ms);
    return true;
  }
}

/**
 * Whether a match fires (ADR 020): an occurrence already seen never does, and a running cooldown
 * drops it. Live alerts and the dry run decide with this same function, so the dry run lists what
 * the live rule fires (criterion 8.6).
 */
export async function decide(
  rule: EvaluableRule,
  match: AlertMatch,
  memory: AlertMemory,
  gate: CooldownGate,
): Promise<'fire' | 'seen' | 'cooldown'> {
  if (memory.hasFired(rule.id, match.dedupeKey)) return 'seen';
  if (!(await gate.tryAcquire(cooldownKey(rule.id, match.subject), match.at, rule.cooldownSec * 1000)))
    return 'cooldown';
  memory.markFired(rule.id, match.dedupeKey);
  return 'fire';
}
