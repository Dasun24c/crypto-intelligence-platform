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
 * One input as the broker journals it (`trading.journal`, ADR 021): everything the engine read, so
 * a fresh engine fed the same entries makes the same fills. `load` is the state the broker loaded
 * when it took the lease; `place` and `reset` carry any account it loaded just before; `config`,
 * the rules and fees from this input on, when they changed.
 */
export type JournalInput = (
  | { kind: 'load'; accounts: EngineAccount[]; orders: EngineOrder[] }
  | {
      kind: 'place';
      order: NewOrder;
      ctx: { now: number; health: Health; book: Book | null; lastTrade: string };
      accounts?: EngineAccount[];
    }
  | { kind: 'cancel'; orderId: string }
  | { kind: 'reset'; accountId: string; starting: Record<string, string>; accounts?: EngineAccount[] }
  | { kind: 'trade'; trade: Trade; ctx: { health: Health; book: Book | null } }
) & { config?: EngineConfig };

export interface JournalEntry {
  input: JournalInput;
  /** The fills' digest lines the broker stored for this input. */
  fills: readonly string[];
}

/** Feeds one journalled input to an engine. */
export function applyInput(engine: PaperEngine, input: JournalInput): Outputs {
  switch (input.kind) {
    case 'load':
      engine.load(input.accounts, input.orders);
      return { orders: [], fills: [], ledger: [] };
    case 'place':
      if (input.accounts?.length) engine.load(input.accounts);
      return engine.place(input.order, input.ctx);
    case 'cancel':
      return engine.cancel(input.orderId);
    case 'reset':
      if (input.accounts?.length) engine.load(input.accounts);
      return engine.reset(input.accountId, input.starting);
    case 'trade':
      return engine.trade(input.trade, input.ctx);
  }
}

/**
 * Replays journal entries on a fresh engine and compares each entry's fills with what was stored
 * (criterion 14.3). Start from a `load` entry. The rules and fees come from the configuration the
 * entries carry; `opts` stands in until the first one (journals written before the broker journalled
 * its configuration). Returns how many entries matched before the first difference, and the replay's
 * digest lines.
 */
export function replayJournal(
  entries: readonly JournalEntry[],
  opts: EngineOptions,
): { checked: number; mismatchAt: number | null; lines: string[] } {
  let config: { rules: Map<string, InstrumentRules>; fees: Map<string, FeeRates> } | null = null;
  const engine = new PaperEngine({
    ...opts,
    rules: (id) => (config ? config.rules.get(id) : opts.rules(id)),
    fees: (venue) => (config ? (config.fees.get(venue) ?? { maker: '0', taker: '0' }) : opts.fees(venue)),
  });
  const lines: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const c = entry.input.config;
    if (c)
      config = {
        rules: new Map(c.rules.map((r) => [r.instrumentId, r])),
        fees: new Map(Object.entries(c.fees)),
      };
    const got = applyInput(engine, entry.input).fills.map(fillDigestLine);
    lines.push(...got);
    if (got.length !== entry.fills.length || got.some((line, j) => line !== entry.fills[j]))
      return { checked: i, mismatchAt: i, lines };
  }
  return { checked: entries.length, mismatchAt: null, lines };
}
