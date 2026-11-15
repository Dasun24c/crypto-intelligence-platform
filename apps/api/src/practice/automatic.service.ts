import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  type AutoDecision,
  type AutoRules,
  AutoRulesSchema,
  DEFAULT_AUTO_RULES,
  type Page,
  type PageQuery,
  type Pattern,
  type PracticeStrategy,
  type UpdateAutoRulesRequest,
} from '@cip/contracts';
import { PRACTICE_COMMANDS_STREAM, type PracticeCommandType } from '@cip/contracts/practice-commands';
import { type Database, LIVE_ORDER_STATUSES, type TradingStrategyRow } from '@cip/db';
import { dec } from '@cip/domain';
import { utcDay } from '@cip/paper-engine';
import { type AuditEvent, AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { PracticeRepository } from './practice.repository.js';
import type { RequestMeta } from './practice.service.js';

/** `practice:commands` keeps about this many commands; the broker reads them within seconds. */
const COMMANDS_MAXLEN = '100000';
/** How long a stop waits for the broker to cancel the automatic orders before answering 202. */
const SETTLE_WAIT_MS = 2_000;
const SETTLE_POLL_MS = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STALE =
  'Your automatic trading changed since you read it (another tab or device). Reload it and try again.';

/**
 * Automatic practice trading (REQUIREMENTS §11 revision 5, ADR 022): the signed-in user's own rules,
 * their switch, the stop button and the decision log. The api stores the rules and the switch and
 * tells the broker, in order with everything else on `practice:commands`; the broker decides and
 * places practice orders. Practice balances only: nothing here reaches an exchange.
 */
@Injectable()
export class AutomaticService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly repo: PracticeRepository,
    private readonly audit: AuditService,
  ) {}

  /** The user's automatic trading: the recommended rules, switched off, until they save their own. */
  async get(userId: string): Promise<PracticeStrategy> {
    const row = await this.row(this.db, userId);
    const parsed = row ? AutoRulesSchema.safeParse(row.rules) : null;
    const rules = parsed?.success ? parsed.data : DEFAULT_AUTO_RULES;
    const now = this.clock();
    const account = await this.db
      .selectFrom('trading.accounts')
      .select(['id', 'starting_balances'])
      .where('user_id', '=', userId)
      .where('venue_id', '=', rules.venue)
      .executeTakeFirst();
    const day = account
      ? await this.db
          .selectFrom('trading.auto_days')
          .select(['orders', 'result'])
          .where('account_id', '=', account.id)
          .where('day', '=', utcDay(now))
          .executeTakeFirst()
      : undefined;
    const starting = account?.starting_balances ?? (await this.repo.settings()).startingBalances[rules.venue];
    return {
      enabled: Boolean(row?.enabled && parsed?.success),
      rules,
      version: row?.version ?? 0,
      pausedUntil: row?.paused_until && row.paused_until.getTime() > now ? row.paused_until.getTime() : null,
      updatedAt: row?.updated_at.getTime() ?? null,
      today: {
        orders: day?.orders ?? 0,
        result: dec(day?.result ?? '0').toString(),
        asset: Object.keys(starting ?? {})[0] ?? '',
      },
    };
  }

  /** Saves the rules, against the version they were read at (409 when it moved on). */
  async update(
    user: AuthenticatedUser,
    body: UpdateAutoRulesRequest,
    meta: RequestMeta,
  ): Promise<PracticeStrategy> {
    await this.checkPairs(body.rules);
    await this.db.transaction().execute(async (trx) => {
      const row = await this.row(trx, user.id, true);
      if ((row?.version ?? 0) !== body.version) throw new ProblemError('CONFLICT', STALE);
      const strategyId = await this.write(trx, user, row, { rules: body.rules });
      await this.audit.record(
        event(user, meta, 'practice_auto.rules_changed', strategyId, {
          version: body.version + 1,
          rules: body.rules,
          ...(row ? { before: row.rules } : {}),
        }),
        trx,
      );
    });
    await this.command('strategy', user.id);
    return this.get(user.id);
  }

  /**
   * Switches it on, confirming the rules the user saw at `version`. Their practice accounts are
   * opened first if they have none yet.
   */
  async switchOn(user: AuthenticatedUser, version: number, meta: RequestMeta): Promise<PracticeStrategy> {
    await this.repo.accountRows(user.id);
    await this.db.transaction().execute(async (trx) => {
      const row = await this.row(trx, user.id, true);
      if ((row?.version ?? 0) !== version) throw new ProblemError('CONFLICT', STALE);
      const rules = row
        ? AutoRulesSchema.safeParse(row.rules)
        : { success: true as const, data: DEFAULT_AUTO_RULES };
      if (!rules.success)
        throw new ProblemError('VALIDATION_FAILED', 'Save your rules again before switching on.', {
          errors: [{ path: 'rules', message: 'The stored rules are no longer valid.' }],
        });
      await this.checkPairs(rules.data);
      const strategyId = await this.write(trx, user, row, { rules: rules.data, enabled: true });
      await this.audit.record(
        event(user, meta, 'practice_auto.switched_on', strategyId, {
          version: version + 1,
          rules: rules.data,
        }),
        trx,
      );
    });
    await this.command('strategy', user.id);
    return this.get(user.id);
  }

  /** Switches it off: nothing new is placed; its orders already working stay, with their stops and targets. */
  async switchOff(user: AuthenticatedUser, meta: RequestMeta): Promise<PracticeStrategy> {
    const changed = await this.db.transaction().execute(async (trx) => {
      const row = await this.row(trx, user.id, true);
      if (!row?.enabled) return false;
      await this.write(trx, user, row, { enabled: false });
      await this.audit.record(
        event(user, meta, 'practice_auto.switched_off', row.id, { version: row.version + 1 }),
        trx,
      );
      return true;
    });
    if (changed) await this.command('strategy', user.id);
    return this.get(user.id);
  }

  /**
   * The stop button: switched off, and every automatic order still working cancelled by the broker.
   * What it bought stays in the practice balance. Waits briefly for the broker: `settled` is false
   * while its orders are not all cancelled yet.
   */
  async stop(
    user: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<{ strategy: PracticeStrategy; settled: boolean }> {
    const working = await this.liveAutoOrders(user.id);
    const stopped = await this.db.transaction().execute(async (trx) => {
      const row = await this.row(trx, user.id, true);
      if (!row) return false;
      await this.write(trx, user, row, { enabled: false });
      await this.audit.record(
        event(user, meta, 'practice_auto.stopped', row.id, { version: row.version + 1, liveOrders: working }),
        trx,
      );
      return true;
    });
    if (!stopped) return { strategy: await this.get(user.id), settled: true };
    await this.command('stop_auto', user.id);
    let settled = working === 0;
    for (const end = Date.now() + SETTLE_WAIT_MS; !settled && Date.now() < end;) {
      await sleep(SETTLE_POLL_MS);
      settled = (await this.liveAutoOrders(user.id)) === 0;
    }
    return { strategy: await this.get(user.id), settled };
  }

  /** Every setup it considered for the user, and what it did, newest first. */
  async decisions(userId: string, q: PageQuery): Promise<Page<AutoDecision>> {
    let query = this.db.selectFrom('trading.auto_decisions').selectAll().where('user_id', '=', userId);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('decided_at', '<', c.ts), eb.and([eb('decided_at', '=', c.ts), eb('id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const buyIds = page.map((r) => r.order_id).filter((id): id is string => id !== null);
    const orders = buyIds.length
      ? await this.db
          .selectFrom('trading.orders')
          .select(['id', 'parent_id', 'type', 'quantity', 'limit_price', 'stop_price'])
          .where((eb) => eb.or([eb('id', 'in', buyIds), eb('parent_id', 'in', buyIds)]))
          .execute()
      : [];
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        setupId: r.setup_id,
        instrumentId: r.instrument_id,
        pattern: r.pattern as Pattern,
        outcome: r.outcome,
        reason: r.reason,
        orderId: r.order_id,
        order: r.order_id ? orderOf(r.order_id, orders) : null,
        strategyVersion: r.strategy_version,
        decidedAt: r.decided_at.getTime(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.decided_at, last.id) : null,
    };
  }

  // ----- internals -----

  private row(db: Kysely<Database>, userId: string, lock = false): Promise<TradingStrategyRow | undefined> {
    const q = db.selectFrom('trading.strategies').selectAll().where('user_id', '=', userId);
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  }

  /** Creates the user's row on first use, or changes it; every change raises the version. Returns its id. */
  private async write(
    trx: Kysely<Database>,
    user: AuthenticatedUser,
    row: TradingStrategyRow | undefined,
    change: { rules?: AutoRules; enabled?: boolean },
  ): Promise<string> {
    const now = new Date(this.clock());
    if (!row) {
      const id = uuidv7();
      await trx
        .insertInto('trading.strategies')
        .values({
          id,
          user_id: user.id,
          enabled: change.enabled ?? false,
          rules: change.rules ?? DEFAULT_AUTO_RULES,
          version: 1,
          updated_by: user.id,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return id;
    }
    await trx
      .updateTable('trading.strategies')
      .set({
        ...(change.rules ? { rules: change.rules } : {}),
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        version: row.version + 1,
        updated_by: user.id,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .execute();
    return row.id;
  }

  /** The pairs must be practice pairs on the rules' venue. */
  private async checkPairs(rules: AutoRules): Promise<void> {
    if (!rules.instrumentIds.length) return;
    const ok = await this.db
      .selectFrom('market.instruments')
      .select('id')
      .where('id', 'in', rules.instrumentIds)
      .where('venue_id', '=', rules.venue)
      .where('role', '=', 'monitored')
      .execute();
    const known = new Set(ok.map((r) => r.id));
    const unknown = rules.instrumentIds.filter((id) => !known.has(id));
    if (unknown.length)
      throw new ProblemError('VALIDATION_FAILED', `Choose practice pairs on ${rules.venue}.`, {
        errors: unknown.map((id) => ({
          path: `rules.instrumentIds.${rules.instrumentIds.indexOf(id)}`,
          message: 'Not a practice pair on this venue.',
        })),
      });
  }

  private async liveAutoOrders(userId: string): Promise<number> {
    const r = await this.db
      .selectFrom('trading.orders as o')
      .innerJoin('trading.accounts as a', 'a.id', 'o.account_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('a.user_id', '=', userId)
      .where('o.source', '=', 'auto')
      .where('o.status', 'in', [...LIVE_ORDER_STATUSES])
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  private async command(type: PracticeCommandType, userId: string): Promise<void> {
    await this.redis.xadd(
      PRACTICE_COMMANDS_STREAM,
      'MAXLEN',
      '~',
      COMMANDS_MAXLEN,
      '*',
      'type',
      type,
      'user',
      userId,
    );
  }
}

function event(
  user: AuthenticatedUser,
  meta: RequestMeta,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    actorType: 'user',
    actorUserId: user.id,
    action,
    targetType: 'practice_strategy',
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details,
  };
}

/** A buy's size and three prices, from it and its legs. */
function orderOf(
  buyId: string,
  rows: readonly {
    id: string;
    parent_id: string | null;
    type: string;
    quantity: string;
    limit_price: string | null;
    stop_price: string | null;
  }[],
): AutoDecision['order'] {
  const buy = rows.find((r) => r.id === buyId);
  if (!buy?.limit_price) return null;
  const leg = (type: string) => rows.find((r) => r.parent_id === buyId && r.type === type);
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v).toString());
  return {
    quantity: dec(buy.quantity).toString(),
    limitPrice: dec(buy.limit_price).toString(),
    stop: n(leg('stop')?.stop_price),
    target: n(leg('target')?.limit_price),
  };
}
