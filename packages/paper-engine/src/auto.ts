import type {
  AutoRules,
  AutoSkipReason,
  Pattern,
  SetupResolution,
  SetupState,
  SetupTransitionMessage,
} from '@cip/contracts';
import { dec, type Decimal, type DecimalString, positionSize, riskReward } from '@cip/domain';
import { holdRate, type PaperEngine } from './engine.js';
import type { Book, EngineFill, EngineOrder, Health, InstrumentRules, NewOrder, Outputs } from './types.js';

/** A setup decided for a strategy is remembered this long, so a repeated transition is not decided twice. */
export const DECIDED_TTL_MS = 7 * 86_400_000;
/**
 * A confirmation the broker reads more than this after the analyzer stored it (the broker catching
 * up after a restart) is not a live decision: the moment has passed.
 */
export const AUTO_LIVE_WINDOW_MS = 120_000;

/** The parts of a setup transition the decider reads; the broker journals it with the `setup` input. */
export interface AutoSetup {
  id: string;
  runId: string;
  instrumentId: string;
  pattern: Pattern;
  direction: 'bullish' | 'bearish';
  /** The state it moved to, and how it ended once `resolved`. */
  to: SetupState;
  resolution: SetupResolution | null;
  entry: DecimalString | null;
  invalidation: DecimalString | null;
  target1: DecimalString | null;
  /** The checklist score, 0–100. */
  score: number;
  mandatoryPassed: boolean;
  qualityFlags: readonly string[];
  /** The run's flags on this transition: `warmup`, `late_detection`. */
  flags: readonly string[];
  decidedAt: number;
  /** When the analyzer stored the transition (its clock). */
  processedAt: number;
}

export function autoSetup(m: SetupTransitionMessage): AutoSetup {
  return {
    id: m.id,
    runId: m.runId,
    instrumentId: m.instrumentId,
    pattern: m.pattern,
    direction: m.direction,
    to: m.transition.to,
    resolution: m.resolution,
    entry: m.levels.entry,
    invalidation: m.levels.invalidation,
    target1: m.levels.target1,
    score: m.score,
    mandatoryPassed: m.mandatoryPassed,
    qualityFlags: [...m.qualityFlags],
    flags: [...m.flags],
    decidedAt: m.transition.decidedAt,
    processedAt: m.transition.processedAt,
  };
}

/** A user's automatic trading as the broker read it from `trading.strategies`. */
export interface AutoStrategy {
  id: string;
  userId: string;
  /** The user's practice account on the rules' venue; null while there is none. */
  accountId: string | null;
  enabled: boolean;
  rules: AutoRules;
  version: number;
  /** While the daily loss limit pauses it. */
  pausedUntil: number | null;
}

/** An automatic trade with a live order: its buy, the buy's stop and target, and its fills so far. */
export interface AutoTrade {
  strategyId: string;
  setupId: string;
  runId: string;
  pattern: Pattern;
  accountId: string;
  instrumentId: string;
  buyId: string;
  stopId: string;
  targetId: string;
  /** What the buy bought and cost, and its fees. */
  bought: DecimalString;
  cost: DecimalString;
  buyFees: DecimalString;
  /** What the stop or the target sold, for how much, and their fees. */
  sold: DecimalString;
  proceeds: DecimalString;
  sellFees: DecimalString;
}

/** One account's automatic trading on one UTC day. */
export interface AutoDay {
  accountId: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Automatic buys placed, refused ones included. */
  orders: number;
  /** The realized result of the automatic trades closed that day, in the pair's quote asset. */
  result: DecimalString;
}

/** Everything the decider holds: the broker journals it with its `load` entry. */
export interface AutoSnapshot {
  strategies: AutoStrategy[];
  trades: AutoTrade[];
  days: AutoDay[];
  /** Setups each strategy has decided recently. */
  decided: { strategyId: string; setupId: string; at: number }[];
}

export const EMPTY_AUTO_SNAPSHOT: AutoSnapshot = { strategies: [], trades: [], days: [], decided: [] };

/** An order the decider placed, for the broker to store (as `new`, source `auto`) before the engine's changes. */
export interface AutoOrderRow {
  id: string;
  accountId: string;
  instrumentId: string;
  setupId: string;
  clientOrderId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'stop' | 'target';
  quantity: DecimalString;
  limitPrice: DecimalString | null;
  stopPrice: DecimalString | null;
  parentId: string | null;
  ocoGroup: string | null;
  underlyingClosed: boolean;
}

export type AutoOutcome = 'placed' | 'skipped' | 'refused' | 'cancelled';

/** One decision for `trading.auto_decisions`. */
export interface AutoDecisionRecord {
  id: string;
  strategyId: string;
  userId: string;
  setupId: string;
  runId: string;
  instrumentId: string;
  pattern: Pattern;
  outcome: AutoOutcome;
  /** A skip reason, the engine's refusal reason, or why it was cancelled (the setup's resolution, or `stopped`). */
  reason: string | null;
  orderId: string | null;
  strategyVersion: number;
  decidedAt: number;
}

/** The daily loss limit was reached: the strategy pauses until `until` (the next 00:00 UTC). */
export interface AutoPause {
  strategyId: string;
  userId: string;
  /** When the trade that reached the limit closed. */
  at: number;
  until: number;
  result: DecimalString;
  asset: string;
}

/** What one input made the decider do. */
export interface AutoResult {
  /** The engine's changes from what it placed or cancelled. */
  outputs: Outputs;
  orders: AutoOrderRow[];
  decisions: AutoDecisionRecord[];
  pauses: AutoPause[];
  /** Day figures that changed. */
  days: AutoDay[];
  /** A stop: the strategy was switched off and its live orders cancelled. */
  stopped: { strategyId: string; userId: string; cancelled: number } | null;
}

/** The market when a setup is decided, as for an order placed by hand. */
export interface AutoContext {
  now: number;
  health: Health;
  book: Book | null;
  lastTrade: string;
  /** The pair's underlying market is closed (tokenised gold at the weekend): its fills are flagged. */
  underlyingClosed: boolean;
}

export interface AutoOptions {
  /** A name-based id, so a replay makes the same order and decision ids. */
  nameId: (name: string) => string;
}

/** Lines a replay compares (criterion 16.6): the orders placed, the decisions and the pauses. */
export function autoDigestLines(r: AutoResult): string[] {
  return [
    ...r.orders.map(
      (o) => `order|${o.id}|${o.type}|${o.quantity}|${o.limitPrice ?? ''}|${o.stopPrice ?? ''}`,
    ),
    ...r.decisions.map((d) => `decision|${d.id}|${d.outcome}|${d.reason ?? ''}|${d.orderId ?? ''}`),
    ...r.pauses.map((p) => `pause|${p.strategyId}|${p.until}|${p.result}`),
  ];
}

export const emptyAutoResult = (): AutoResult => ({
  outputs: { orders: [], fills: [], ledger: [] },
  orders: [],
  decisions: [],
  pauses: [],
  days: [],
  stopped: null,
});

export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** The next 00:00 UTC after `at`. */
export function nextUtcMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

const ROUND_DOWN = 0;
const ROUND_HALF_UP = 1;

/**
 * Automatic practice trading (ADR 022): a deterministic decider beside the paper engine. On a
 * confirmed bullish setup it decides, for every user whose automatic trading is on, whether their
 * rules and limits allow a practice limit buy at the entry with a stop at the invalidation and a
 * target at target 1, sized by the position-size calculator; it places it through the engine like
 * any order, and cancels the buy if the setup ends before it fills. It also follows its trades'
 * fills for the day's result and the daily loss limit. Pure: the broker feeds it, stores what it
 * returns, and a replay of the same inputs makes the same decisions. Practice balances only.
 */
export class AutoTrader {
  private readonly strategies = new Map<string, AutoStrategy>();
  private readonly trades = new Map<string, AutoTrade>();
  private readonly byOrder = new Map<string, AutoTrade>();
  private readonly days = new Map<string, AutoDay>();
  private readonly decided = new Map<string, number>();

  constructor(
    private readonly engine: PaperEngine,
    private readonly opts: AutoOptions,
  ) {}

  load(s: AutoSnapshot): void {
    this.strategies.clear();
    this.trades.clear();
    this.byOrder.clear();
    this.days.clear();
    this.decided.clear();
    for (const st of s.strategies) this.strategies.set(st.id, { ...st, rules: { ...st.rules } });
    for (const t of s.trades) this.track({ ...t });
    for (const d of s.days) this.days.set(d.accountId, { ...d });
    for (const d of s.decided) this.decided.set(`${d.strategyId}:${d.setupId}`, d.at);
  }

  snapshot(): AutoSnapshot {
    return {
      strategies: [...this.strategies.values()].map((s) => ({ ...s, rules: { ...s.rules } })),
      trades: [...this.trades.values()].map((t) => ({ ...t })),
      days: [...this.days.values()].map((d) => ({ ...d })),
      decided: [...this.decided].map(([key, at]) => {
        const [strategyId = '', setupId = ''] = key.split(':');
        return { strategyId, setupId, at };
      }),
    };
  }

  strategy(id: string): AutoStrategy | undefined {
    const s = this.strategies.get(id);
    return s ? { ...s } : undefined;
  }

  /** The strategy's open automatic trades: those with a live order. */
  openTrades(strategyId: string): AutoTrade[] {
    return this.sorted(
      [...this.trades.values()].filter((t) => t.strategyId === strategyId && this.isOpen(t)),
    );
  }

  /** The account's figures for the UTC day of `at`. */
  today(accountId: string, at: number): AutoDay {
    const d = this.days.get(accountId);
    return d && d.day >= utcDay(at) ? { ...d } : { accountId, day: utcDay(at), orders: 0, result: '0' };
  }

  /**
   * Whether a transition can lead to anything, so the broker reads the market and journals it only
   * then: a confirmed bullish setup while a strategy is on, or the end of a setup a trade was placed on.
   */
  wants(s: AutoSetup): boolean {
    if (s.to === 'resolved')
      return [...this.trades.values()].some((t) => t.setupId === s.id && this.engine.isLive(t.buyId));
    return (
      s.to === 'confirmed' &&
      s.direction === 'bullish' &&
      [...this.strategies.values()].some((st) => st.enabled)
    );
  }

  /**
   * A user's rules or switch changed (a `strategy` command). With `stop`, the stop button: it is off
   * now, and every automatic order still live is cancelled; what it bought stays in the balance.
   */
  setStrategy(s: AutoStrategy, stop: boolean, at: number): AutoResult {
    const r = emptyAutoResult();
    const st: AutoStrategy = { ...s, rules: { ...s.rules } };
    this.strategies.set(st.id, st);
    if (!stop) return r;
    let cancelled = 0;
    for (const t of this.sorted([...this.trades.values()].filter((x) => x.strategyId === st.id))) {
      let mine = 0;
      for (const id of [t.buyId, t.stopId, t.targetId]) {
        if (!this.engine.isLive(id)) continue;
        const out = this.engine.cancel(id);
        mine += out.orders.filter((o) => o.status === 'cancelled').length;
        merge(r.outputs, out);
        this.observeInto(out, at, r);
      }
      if (mine) r.decisions.push(this.record(st, t, 'cancelled', 'stopped', t.buyId, at));
      cancelled += mine;
    }
    r.stopped = { strategyId: st.id, userId: st.userId, cancelled };
    return r;
  }

  /** A setup transition from `an:events`. */
  setup(s: AutoSetup, ctx: AutoContext): AutoResult {
    const r = emptyAutoResult();
    this.prune(ctx.now);
    if (s.to === 'resolved') {
      this.endSetup(s, ctx.now, r);
      return r;
    }
    if (s.to !== 'confirmed' || s.direction !== 'bullish') return r;
    for (const st of [...this.strategies.values()].sort((a, b) => cmp(a.id, b.id))) {
      if (!st.enabled) continue;
      const key = `${st.id}:${s.id}`;
      if (this.decided.has(key)) continue;
      this.decided.set(key, ctx.now);
      this.decide(st, s, ctx, r);
    }
    return r;
  }

  /** Follows the engine's changes from any other input: fills of automatic trades, and their ends. */
  observe(outputs: Outputs, at: number): AutoResult {
    const r = emptyAutoResult();
    this.observeInto(outputs, at, r);
    return r;
  }

  // ----- internals -----

  /** ADR 022's checks, in order; the first that fails is the skip reason. */
  private decide(st: AutoStrategy, s: AutoSetup, ctx: AutoContext, r: AutoResult): void {
    const rules = st.rules;
    const skip = (reason: AutoSkipReason) => {
      r.decisions.push(this.record(st, s, 'skipped', reason, null, ctx.now));
    };
    if (st.pausedUntil !== null && ctx.now < st.pausedUntil) return skip('paused');
    const pair = this.engine.rulesOf(s.instrumentId);
    if (
      !pair ||
      pair.venue !== rules.venue ||
      (rules.instrumentIds.length > 0 && !rules.instrumentIds.includes(s.instrumentId))
    )
      return skip('pair');
    if (!rules.patterns.includes(s.pattern)) return skip('pattern');
    if (
      !s.mandatoryPassed ||
      s.flags.includes('warmup') ||
      s.flags.includes('late_detection') ||
      ctx.now - s.processedAt > AUTO_LIVE_WINDOW_MS
    )
      return skip('not_live');
    if (s.qualityFlags.includes('data_gap')) return skip('data_gap');
    if (s.score < rules.minScore) return skip('score');
    const levels = orderLevels(s, pair);
    if (!levels) return skip('reward');
    const rr = riskReward(levels.entry, levels.stop, levels.target);
    if (rr === null || dec(rr).lt(rules.minReward)) return skip('reward');
    const open = this.openTrades(st.id);
    if (open.length >= rules.maxOpenTrades || open.some((t) => t.instrumentId === s.instrumentId))
      return skip('open_limit');
    const accountId = st.accountId;
    if (!accountId || !this.engine.hasAccount(accountId)) return skip('balance');
    const day = this.day(accountId, ctx.now);
    if (day.orders >= rules.maxOrdersPerDay) return skip('daily_orders');

    // The calculator's size at the risk per trade of the free quote balance, capped at what that
    // balance buys with the higher fee: spot, nothing borrowed.
    const free = dec(this.engine.account(accountId).available[pair.quote] ?? '0');
    if (free.lte(0)) return skip('balance');
    const step = dec(pair.qtyStep);
    const wanted = dec(
      positionSize({
        accountSize: free.toString(),
        riskPct: String(rules.riskPct),
        entry: levels.entry,
        invalidation: levels.stop,
        ...(step.gt(0) ? { qtyStep: pair.qtyStep } : {}),
      }).quantity,
    );
    const minimum = dec(pair.minNotional);
    const worth = (q: Decimal) => q.gt(0) && (minimum.lte(0) || q.times(levels.entry).gte(minimum));
    if (!worth(wanted)) return skip('size');
    const affordable = floorTo(
      free.div(dec(levels.entry).times(holdRate(this.engine.feesOf(pair.venue)))),
      step,
    );
    const quantity = wanted.lte(affordable) ? wanted : affordable;
    if (!worth(quantity)) return skip('balance');

    const ids = this.ids(st.id, s.id);
    const q = quantity.toString();
    const base = {
      accountId,
      instrumentId: s.instrumentId,
      setupId: s.id,
      quantity: q,
      underlyingClosed: ctx.underlyingClosed,
    };
    r.orders.push(
      {
        ...base,
        id: ids.buy,
        clientOrderId: `auto:${s.id}`,
        side: 'buy',
        type: 'limit',
        limitPrice: levels.entry,
        stopPrice: null,
        parentId: null,
        ocoGroup: null,
      },
      {
        ...base,
        id: ids.stop,
        clientOrderId: `auto:${s.id}:stop`,
        side: 'sell',
        type: 'stop',
        limitPrice: null,
        stopPrice: levels.stop,
        parentId: ids.buy,
        ocoGroup: ids.group,
      },
      {
        ...base,
        id: ids.target,
        clientOrderId: `auto:${s.id}:target`,
        side: 'sell',
        type: 'target',
        limitPrice: levels.target,
        stopPrice: null,
        parentId: ids.buy,
        ocoGroup: ids.group,
      },
    );
    const order: NewOrder = {
      id: ids.buy,
      accountId,
      instrumentId: s.instrumentId,
      side: 'buy',
      type: 'limit',
      quantity: q,
      limitPrice: levels.entry,
      underlyingClosed: ctx.underlyingClosed,
      stop: { id: ids.stop, price: levels.stop },
      target: { id: ids.target, price: levels.target },
      ocoGroup: ids.group,
    };
    const out = this.engine.place(order, ctx);
    merge(r.outputs, out);
    day.orders += 1;
    touchDay(r, day);
    const buy = out.orders.find((o) => o.id === ids.buy);
    if (!buy || buy.status === 'refused') {
      r.decisions.push(
        this.record(st, s, 'refused', buy?.refusalReason ?? 'not_practice_pair', ids.buy, ctx.now),
      );
      return;
    }
    this.track({
      strategyId: st.id,
      setupId: s.id,
      runId: s.runId,
      pattern: s.pattern,
      accountId,
      instrumentId: s.instrumentId,
      buyId: ids.buy,
      stopId: ids.stop,
      targetId: ids.target,
      bought: '0',
      cost: '0',
      buyFees: '0',
      sold: '0',
      proceeds: '0',
      sellFees: '0',
    });
    r.decisions.push(this.record(st, s, 'placed', null, ids.buy, ctx.now));
    // A buy at or above the market fills at once.
    this.observeInto(out, ctx.now, r);
  }

  /** The setup ended: a buy that has not filled is cancelled (a partly filled one keeps its stop and target). */
  private endSetup(s: AutoSetup, at: number, r: AutoResult): void {
    for (const t of this.sorted([...this.trades.values()].filter((x) => x.setupId === s.id))) {
      if (!this.engine.isLive(t.buyId)) continue;
      const st = this.strategies.get(t.strategyId);
      const out = this.engine.cancel(t.buyId);
      merge(r.outputs, out);
      if (st) r.decisions.push(this.record(st, t, 'cancelled', s.resolution ?? 'resolved', t.buyId, at));
      this.observeInto(out, at, r);
    }
  }

  private observeInto(outputs: Outputs, at: number, r: AutoResult): void {
    const touched = new Set<AutoTrade>();
    for (const f of outputs.fills) {
      const t = this.byOrder.get(f.orderId);
      if (!t) continue;
      addFill(t, f);
      touched.add(t);
    }
    for (const o of outputs.orders) {
      const t = this.byOrder.get(o.id);
      if (t) touched.add(t);
    }
    for (const t of this.sorted([...touched])) if (!this.isOpen(t)) this.close(t, at, r);
  }

  /**
   * A trade's orders are all finished: its realized result counts on the day it closed. Only what
   * was sold counts, at the buy's average cost; what is left is not marked to market (ADR 022).
   */
  private close(t: AutoTrade, at: number, r: AutoResult): void {
    this.trades.delete(`${t.strategyId}:${t.setupId}`);
    for (const id of [t.buyId, t.stopId, t.targetId]) this.byOrder.delete(id);
    const day = this.day(t.accountId, at);
    day.result = dec(day.result).plus(realized(t)).toString();
    touchDay(r, day);
    const st = this.strategies.get(t.strategyId);
    if (!st || !this.engine.hasAccount(t.accountId)) return;
    const asset = this.engine.rulesOf(t.instrumentId)?.quote ?? '';
    const starting = dec(this.engine.account(t.accountId).starting?.[asset] ?? '0');
    const limit = starting.times(st.rules.dailyLossPct).div(100);
    const result = dec(day.result);
    if (result.gte(0) || result.neg().lt(limit)) return;
    const until = nextUtcMidnight(at);
    if (st.pausedUntil !== null && st.pausedUntil >= until) return;
    st.pausedUntil = until;
    r.pauses.push({ strategyId: st.id, userId: st.userId, at, until, result: day.result, asset });
  }

  /** The account's day for `at`; a timestamp from before the day it holds counts on that day. */
  private day(accountId: string, at: number): AutoDay {
    const key = utcDay(at);
    let d = this.days.get(accountId);
    if (!d || d.day < key) {
      d = { accountId, day: key, orders: 0, result: '0' };
      this.days.set(accountId, d);
    }
    return d;
  }

  private track(t: AutoTrade): void {
    this.trades.set(`${t.strategyId}:${t.setupId}`, t);
    for (const id of [t.buyId, t.stopId, t.targetId]) this.byOrder.set(id, t);
  }

  private isOpen(t: AutoTrade): boolean {
    return [t.buyId, t.stopId, t.targetId].some((id) => this.engine.isLive(id));
  }

  private prune(now: number): void {
    for (const [key, at] of this.decided) if (at < now - DECIDED_TTL_MS) this.decided.delete(key);
  }

  private ids(strategyId: string, setupId: string) {
    const name = `practice-auto:${strategyId}:${setupId}`;
    return {
      buy: this.opts.nameId(name),
      stop: this.opts.nameId(`${name}:stop`),
      target: this.opts.nameId(`${name}:target`),
      group: this.opts.nameId(`${name}:oco`),
    };
  }

  private record(
    st: AutoStrategy,
    s: { setupId?: string; id?: string; runId: string; instrumentId: string; pattern: Pattern },
    outcome: AutoOutcome,
    reason: string | null,
    orderId: string | null,
    at: number,
  ): AutoDecisionRecord {
    const setupId = s.setupId ?? s.id ?? '';
    return {
      id: this.opts.nameId(`practice-auto-decision:${st.id}:${setupId}:${outcome}:${reason ?? ''}`),
      strategyId: st.id,
      userId: st.userId,
      setupId,
      runId: s.runId,
      instrumentId: s.instrumentId,
      pattern: s.pattern,
      outcome,
      reason,
      orderId,
      strategyVersion: st.version,
      decidedAt: at,
    };
  }

  private sorted(trades: AutoTrade[]): AutoTrade[] {
    return trades.sort((a, b) => cmp(a.strategyId, b.strategyId) || cmp(a.setupId, b.setupId));
  }
}

/** The order's prices: the setup's levels rounded down to the price step, invalidation < entry < target 1. */
export function orderLevels(
  s: Pick<AutoSetup, 'entry' | 'invalidation' | 'target1'>,
  pair: InstrumentRules,
): { entry: DecimalString; stop: DecimalString; target: DecimalString } | null {
  if (!s.entry || !s.invalidation || !s.target1) return null;
  const tick = dec(pair.priceTick);
  const entry = floorTo(dec(s.entry), tick);
  const stop = floorTo(dec(s.invalidation), tick);
  const target = floorTo(dec(s.target1), tick);
  if (!(stop.gt(0) && stop.lt(entry) && entry.lt(target))) return null;
  return { entry: entry.toString(), stop: stop.toString(), target: target.toString() };
}

/** Rounds down to a whole number of steps; a step of 0 (unknown) keeps 8 decimals. */
function floorTo(x: Decimal, step: Decimal): Decimal {
  return step.gt(0) ? x.div(step).round(0, ROUND_DOWN).times(step) : x.round(8, ROUND_DOWN);
}

/** What was sold, less what it cost at the buy's average price, less the fees on both (8 decimals). */
export function realized(t: AutoTrade): Decimal {
  const bought = dec(t.bought);
  if (bought.lte(0)) return dec(0);
  const share = dec(t.sold).div(bought);
  return dec(t.proceeds)
    .minus(dec(t.cost).times(share))
    .minus(dec(t.buyFees).times(share))
    .minus(t.sellFees)
    .round(8, ROUND_HALF_UP);
}

function addFill(t: AutoTrade, f: EngineFill): void {
  const value = dec(f.price).times(f.quantity);
  if (f.side === 'buy') {
    t.bought = dec(t.bought).plus(f.quantity).toString();
    t.cost = dec(t.cost).plus(value).toString();
    t.buyFees = dec(t.buyFees).plus(f.fee).toString();
  } else {
    t.sold = dec(t.sold).plus(f.quantity).toString();
    t.proceeds = dec(t.proceeds).plus(value).toString();
    t.sellFees = dec(t.sellFees).plus(f.fee).toString();
  }
}

/** Adds one engine call's changes to the input's: each order as it ends up, fills and entries in order. */
function merge(into: Outputs, from: Outputs): void {
  const byId = new Map<string, EngineOrder>(into.orders.map((o) => [o.id, o]));
  for (const o of from.orders) byId.set(o.id, o);
  into.orders = [...byId.values()];
  into.fills.push(...from.fills);
  into.ledger.push(...from.ledger);
}

function touchDay(r: AutoResult, d: AutoDay): void {
  const i = r.days.findIndex((x) => x.accountId === d.accountId);
  if (i >= 0) r.days[i] = { ...d };
  else r.days.push({ ...d });
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
