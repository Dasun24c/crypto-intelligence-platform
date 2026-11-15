import {
  type AutoContext,
  autoDigestLines,
  type AutoResult,
  type AutoSetup,
  type AutoSnapshot,
  type AutoStrategy,
  AutoTrader,
  EMPTY_AUTO_SNAPSHOT,
} from './auto.js';
import { fillDigestLine } from './digest.js';
import { PaperEngine } from './engine.js';
import type {
  Book,
  EngineAccount,
  EngineOptions,
  EngineOrder,
  FeeRates,
  Health,
  InstrumentRules,
  NewOrder,
  Outputs,
  Trade,
} from './types.js';

/**
 * The order rules and fees the engine used. The broker journals them with its `load` entry, and
 * again with the first entry after they change (the pair-status job reading a minimum, an admin
 * changing the fees), so a replay uses what the live engine used.
 */
export interface EngineConfig {
  rules: InstrumentRules[];
  /** By venue. */
  fees: Record<string, FeeRates>;
}

/**
 * One input as the broker journals it (`trading.journal`, ADR 021): everything the engine and the
 * auto-trader read, so fresh ones fed the same entries make the same fills and decisions. `load` is
 * the state the broker loaded when it took the lease (with the auto-trader's, from Phase 16);
 * `place`, `reset`, `setup` and `strategy` carry any account it loaded just before; `config`, the
 * rules and fees from this input on, when they changed. `at` (Phase 16) dates what an input closes
 * for the automatic trades' daily figures; trades use their own time.
 */
export type JournalInput = (
  | { kind: 'load'; accounts: EngineAccount[]; orders: EngineOrder[]; auto?: AutoSnapshot }
  | {
      kind: 'place';
      order: NewOrder;
      ctx: { now: number; health: Health; book: Book | null; lastTrade: string };
      accounts?: EngineAccount[];
    }
  | { kind: 'cancel'; orderId: string; at?: number }
  | {
      kind: 'reset';
      accountId: string;
      starting: Record<string, string>;
      accounts?: EngineAccount[];
      at?: number;
    }
  | { kind: 'trade'; trade: Trade; ctx: { health: Health; book: Book | null } }
  | { kind: 'setup'; setup: AutoSetup; ctx: AutoContext; accounts?: EngineAccount[] }
  | { kind: 'strategy'; strategy: AutoStrategy; stop: boolean; at: number; accounts?: EngineAccount[] }
) & { config?: EngineConfig };

export interface JournalEntry {
  input: JournalInput;
  /** The fills' digest lines the broker stored for this input. */
  fills: readonly string[];
  /** The auto-trader's digest lines (orders placed, decisions, pauses); absent before Phase 16. */
  decisions?: readonly string[];
}

/**
 * Feeds one journalled input to an engine, and to the auto-trader beside it: the trader decides on
 * `setup` and `strategy` inputs, and follows every other input's changes to its trades. Without a
 * trader, `setup` and `strategy` inputs change nothing.
 */
export function applyInput(
  engine: PaperEngine,
  input: JournalInput,
  trader?: AutoTrader,
): Outputs & { auto: AutoResult | null } {
  const observed = (outputs: Outputs, at: number) => ({
    ...outputs,
    auto: trader ? trader.observe(outputs, at) : null,
  });
  switch (input.kind) {
    case 'load':
      engine.load(input.accounts, input.orders);
      trader?.load(input.auto ?? EMPTY_AUTO_SNAPSHOT);
      return { orders: [], fills: [], ledger: [], auto: null };
    case 'place':
      if (input.accounts?.length) engine.load(input.accounts);
      return observed(engine.place(input.order, input.ctx), input.ctx.now);
    case 'cancel':
      return observed(engine.cancel(input.orderId), input.at ?? 0);
    case 'reset':
      if (input.accounts?.length) engine.load(input.accounts);
      return observed(engine.reset(input.accountId, input.starting), input.at ?? 0);
    case 'trade':
      return observed(engine.trade(input.trade, input.ctx), input.trade.ts);
    case 'setup': {
      if (input.accounts?.length) engine.load(input.accounts);
      if (!trader) return { orders: [], fills: [], ledger: [], auto: null };
      const auto = trader.setup(input.setup, input.ctx);
      return { ...auto.outputs, auto };
    }
    case 'strategy': {
      if (input.accounts?.length) engine.load(input.accounts);
      if (!trader) return { orders: [], fills: [], ledger: [], auto: null };
      const auto = trader.setStrategy(input.strategy, input.stop, input.at);
      return { ...auto.outputs, auto };
    }
  }
}

/**
 * Replays journal entries on a fresh engine and auto-trader, and compares each entry's fills (and,
 * from Phase 16, its decisions) with what was stored (criteria 14.3 and 16.6). Start from a `load`
 * entry. The rules and fees come from the configuration the entries carry; `opts` stands in until
 * the first one (journals written before the broker journalled its configuration). Returns how many
 * entries matched before the first difference, and the replay's digest lines.
 */
export function replayJournal(
  entries: readonly JournalEntry[],
  opts: EngineOptions & { nameId?: (name: string) => string },
): { checked: number; mismatchAt: number | null; lines: string[] } {
  let config: { rules: Map<string, InstrumentRules>; fees: Map<string, FeeRates> } | null = null;
  const engine = new PaperEngine({
    ...opts,
    rules: (id) => (config ? config.rules.get(id) : opts.rules(id)),
    fees: (venue) => (config ? (config.fees.get(venue) ?? { maker: '0', taker: '0' }) : opts.fees(venue)),
  });
  const trader = new AutoTrader(engine, { nameId: opts.nameId ?? ((name) => name) });
  const lines: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const c = entry.input.config;
    if (c)
      config = {
        rules: new Map(c.rules.map((r) => [r.instrumentId, r])),
        fees: new Map(Object.entries(c.fees)),
      };
    const out = applyInput(engine, entry.input, trader);
    const got = out.fills.map(fillDigestLine);
    const decided = out.auto ? autoDigestLines(out.auto) : [];
    lines.push(...got, ...decided);
    const want = entry.decisions ?? [];
    if (
      got.length !== entry.fills.length ||
      got.some((line, j) => line !== entry.fills[j]) ||
      (entry.decisions !== undefined &&
        (decided.length !== want.length || decided.some((line, j) => line !== want[j])))
    )
      return { checked: i, mismatchAt: i, lines };
  }
  return { checked: entries.length, mismatchAt: null, lines };
}
