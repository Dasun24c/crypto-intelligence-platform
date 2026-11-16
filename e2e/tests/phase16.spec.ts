/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { LIVE_ONLY, REPLAY_STACK } from '../support/stack.ts';
import {
  accessToken,
  adminAccessToken,
  ensureTestAdmin,
  othersTradingAutomatically,
  signIn,
  userIdOf,
} from '../support/session.ts';
import { ANALYST } from '../support/users.ts';

/**
 * Phase 16 (automatic practice trading, ADR 022), criteria 16.1, 16.3, 16.5, 16.7 and 16.9, against a
 * running stack with the broker. The analyst switches automatic trading on for their own practice
 * account; confirmed setups then reach the broker on `an:events` and become practice orders.
 *
 * Confirmed setups are rare on live data (a few a day across the pairs), so the specs append setup
 * transitions to the stack's `an:events` themselves, in the analyzer's message shape, for Binance
 * BTC/USDT with an entry at half the price (the buy rests). Everything after that is the stack's own:
 * the broker's decision, the order through the practice engine, the decision log, the alert and the
 * page. Practice balances only: nothing reaches an exchange.
 */
const BANNER = 'Practice trading: simulated orders, no real money.';
const RUN = Date.now().toString(36);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:16379';

interface Instrument {
  id: string;
  venue: string;
  base: string;
  quote: string;
  displayName: string;
  priceTick: string;
}
interface Strategy {
  enabled: boolean;
  version: number;
  rules: Record<string, unknown>;
}
interface Rule {
  id: string;
  enabled: boolean;
  scope: { instrumentIds?: string[]; venues?: string[] };
  condition: { kind: string; on?: string[] };
  cooldownSec: number;
  channels: string[];
}
/** The notifications of automatic trades the card offers (changed 2026-11-16, ADR 022). */
const AUTO_TRADE_KINDS = [
  'practice_auto_order',
  'practice_order_filled',
  'practice_exit',
  'practice_auto_paused',
];

/** A price rounded down to the pair's price step, without floats drifting. */
function onTick(value: number, tick: string): string {
  const places = (tick.split('.')[1] ?? '').length;
  return (Math.floor(value / Number(tick) + 1e-9) * Number(tick)).toFixed(places);
}

test.describe('Phase 16', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(REPLAY_STACK, LIVE_ONLY);
  test.setTimeout(5 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let headers: Record<string, string>;
  let redis: Redis;
  let btc: Instrument;
  let levels: { entry: string; invalidation: string; target1: string };
  let ruleId: string | undefined;
  /** The analyst's alert rules before the spec: only the others are removed after it. */
  let rulesBefore = new Set<string>();
  /** Whether the analyst lacked some notification of automatic trades, so the card offers them. */
  let offered = false;
  /** Past the guard: from then on the spec changes its analyst's account, and cleans up after. */
  let changing = false;
  const runId = randomUUID();

  /** A setup transition as the analyzer appends it to an:events (`SetupTransitionMessage`). */
  async function transition(id: string, o: { to?: 'confirmed' | 'resolved'; score?: number } = {}) {
    const now = Date.now();
    const to = o.to ?? 'confirmed';
    const message = {
      id,
      instrumentId: btc.id,
      runId,
      pattern: 'htf_order_block',
      variant: null,
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '15m',
      state: to,
      resolution: to === 'resolved' ? 'invalidated' : null,
      displayLabel: to === 'resolved' ? 'Resolved' : 'Confirmed',
      levels: { ...levels, target2: null, rr: 5 },
      score: o.score ?? 85,
      mandatoryPassed: true,
      qualityFlags: [],
      flags: [],
      createdAt: now - 3_600_000,
      updatedAt: now,
      resolvedAt: to === 'resolved' ? now : null,
      disclaimer: 'Educational analysis — not financial advice',
      transition: {
        from: to === 'resolved' ? 'confirmed' : 'triggered',
        to,
        reason: `e2e ${RUN}`,
        candleTime: now - 900_000,
        decidedAt: now - 500,
        processedAt: now,
        late: false,
        evidence: {},
      },
    };
    await redis.xadd('an:events', '*', 'type', 'setup', 'data', JSON.stringify(message));
  }

  async function strategy(): Promise<Strategy> {
    const res = await api.get('/api/v1/practice/automatic', { headers });
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()) as Strategy;
  }

  async function rules(): Promise<Rule[]> {
    const res = await api.get('/api/v1/alerts/rules', { headers });
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()) as Rule[];
  }
  /** The kinds the analyst is notified of: rules that are on and watch every pair. */
  const notifiedKinds = (list: Rule[]) =>
    new Set(
      list.filter((r) => r.enabled && !r.scope.instrumentIds && !r.scope.venues).map((r) => r.condition.kind),
    );

  const card = () => page.getByRole('region', { name: 'Automatic trading (simulated)' });
  const decisions = () => page.getByRole('table', { name: 'Automatic trading decisions, newest first' });
  const openOrders = () => page.getByRole('table', { name: 'Open practice orders' });
  /** Automatic buys among the open orders (their stops and targets are sells). */
  const autoBuys = () =>
    openOrders()
      .getByRole('row')
      .filter({ hasText: 'Automatic' })
      .filter({ has: page.getByRole('cell', { name: 'Buy', exact: true }) });

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    headers = await accessToken(api, ANALYST);
    // The confirmed setups this spec appends to an:events reach every account's automatic trading:
    // one switched on with matching rules would trade on them too. So it runs only when no other
    // account has automatic trading on.
    await ensureTestAdmin(browser, baseURL);
    const others = await othersTradingAutomatically(
      api,
      await adminAccessToken(api),
      await userIdOf(api, headers),
    );
    test.skip(
      others.length > 0,
      `automatic trading is on for ${others.length} other account(s): this spec's confirmed setups would trade for them`,
    );
    changing = true;
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    btc = instruments.find((i) => i.venue === 'binance' && i.base === 'BTC' && i.quote === 'USDT')!;
    expect(btc, 'Binance BTC/USDT is enabled').toBeTruthy();
    const ticker = (await (await api.get(`/api/v1/market/${btc.id}/ticker`, { headers })).json()) as {
      ask: string;
    };
    // Half the price: the buy rests for the whole spec. Stop 2 % below, target 10 % above (5 × the risk).
    const entry = Number(ticker.ask) / 2;
    levels = {
      entry: onTick(entry, btc.priceTick),
      invalidation: onTick(entry * 0.98, btc.priceTick),
      target1: onTick(entry * 1.1, btc.priceTick),
    };
    // From the starting balances, automatic trading off, rules for BTC/USDT only.
    const reset = await api.post('/api/v1/practice/account/reset', { headers, data: { venue: 'binance' } });
    expect([200, 202]).toContain(reset.status());
    if ((await strategy()).enabled) await api.post('/api/v1/practice/automatic/stop', { headers });
    const current = await strategy();
    const saved = await api.put('/api/v1/practice/automatic', {
      headers,
      data: {
        version: current.version,
        rules: {
          venue: 'binance',
          instrumentIds: [btc.id],
          patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
          minScore: 70,
          minReward: 2,
          riskPct: 1,
          maxOpenTrades: 3,
          maxOrdersPerDay: 50,
          dailyLossPct: 3,
        },
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const created = await api.post('/api/v1/alerts/rules', {
      headers,
      data: {
        name: `e2e automatic ${RUN}`,
        condition: { kind: 'practice_auto_order' },
        channels: ['in_app', 'web'],
        cooldownSec: 0,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    ruleId = ((await created.json()) as { id: string }).id;
    const listed = await rules();
    rulesBefore = new Set(listed.map((r) => r.id));
    const kinds = notifiedKinds(listed);
    // A stop-only or target-only rule still leaves the other leg to offer; this spec's analyst has neither.
    offered = AUTO_TRADE_KINDS.some((k) => !kinds.has(k));
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, ANALYST);
  });

  test.afterAll(async () => {
    if (api && changing) {
      await api.post('/api/v1/practice/automatic/stop', { headers }).catch(() => undefined);
      // The spec's own rules: its rule, and the notifications switching on made.
      const made = (await rules().catch(() => [])).filter((r) => !rulesBefore.has(r.id)).map((r) => r.id);
      for (const id of [...(ruleId ? [ruleId] : []), ...made])
        await api.delete(`/api/v1/alerts/rules/${id}`, { headers }).catch(() => undefined);
    }
    await api?.dispose();
    redis?.disconnect();
    await ctx?.close();
  });

  test('16.9 the card carries the practice banner, passes axe, and switches on from the keyboard after its confirmation', async () => {
    await page.goto('/practice');
    await expect(card()).toBeVisible();
    await expect(card().getByRole('note').filter({ hasText: BANNER })).toBeVisible();
    await expect(card().getByText('Off', { exact: true })).toBeVisible();
    const scan = async () => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id);
    };
    expect(await scan()).toEqual([]);

    // Keyboard only: Space on the switch asks first; Tab reaches "Switch on"; Enter switches it on.
    const toggle = card().getByRole('switch', { name: 'Automatic practice trading' });
    await toggle.focus();
    await page.keyboard.press('Space');
    const confirm = card().getByRole('group', { name: 'Switch on automatic practice trading' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('each risking 1 % of the free balance');
    expect((await strategy()).enabled).toBe(false);
    expect(await scan()).toEqual([]);
    // Changed 2026-11-16: the confirmation offers notifications of each automatic trade, ticked, unless
    // the analyst already has them.
    const notify = confirm.getByRole('checkbox', { name: /Notify me of each automatic buy and sale/ });
    if (offered) {
      await page.keyboard.press('Tab');
      await expect(notify).toBeFocused();
      await expect(notify).toBeChecked();
    } else await expect(notify).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'Switch on' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card().getByText('On', { exact: true })).toBeVisible();
    expect((await strategy()).enabled).toBe(true);
  });

  test('notifications (changed 2026-11-16): switched on with the box ticked, the analyst is notified of each automatic buy, fill, stop or target sale and pause', async () => {
    await expect(card().getByText(/Notifications are on for each automatic buy placed/)).toBeVisible();
    const after = await rules();
    const kinds = notifiedKinds(after);
    for (const k of AUTO_TRADE_KINDS) expect(kinds.has(k), k).toBe(true);
    // What switching on made: the missing ones, with no cooldown, to the inbox, the desktop and the browser.
    const made = after.filter((r) => !rulesBefore.has(r.id));
    if (offered) expect(made.length).toBeGreaterThan(0);
    for (const r of made) {
      expect(AUTO_TRADE_KINDS).toContain(r.condition.kind);
      expect(r.cooldownSec).toBe(0);
      expect(r.channels).toEqual(['in_app', 'desktop', 'web']);
    }
  });

  test('16.1 and 16.7 a confirmed setup that matches becomes a labelled practice buy with its stop and target, alerted; one that does not is logged as skipped', async () => {
    const setupId = randomUUID();
    await transition(setupId);
    // The broker places it: the buy with its stop and target, labelled Automatic.
    const buy = autoBuys();
    await expect(buy.first()).toBeVisible({ timeout: 15_000 });
    await expect(buy.first()).toContainText(
      Number(levels.entry).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
    await expect(openOrders().getByRole('row').filter({ hasText: 'Waits for its buy' })).toHaveCount(2);
    await expect(decisions().getByRole('row').filter({ hasText: 'Placed' }).first()).toContainText(
      'Matched your rules.',
      { timeout: 15_000 },
    );
    await expect(card()).toContainText(/\d+ automatic buys? placed/);

    // Its alert, for the analyst's rule.
    await expect
      .poll(
        async () => {
          const events = (await (
            await api.get(`/api/v1/alerts/events?ruleId=${ruleId}`, { headers })
          ).json()) as { items: { title: string }[] };
          return events.items.map((e) => e.title);
        },
        { timeout: 60_000 },
      )
      .toEqual(['BTC · Binance BTC/USDT: automatic practice buy placed']);

    // A weak setup: logged as skipped, with the reason, and nothing placed.
    await transition(randomUUID(), { score: 40 });
    await expect(decisions().getByRole('row').filter({ hasText: 'Skipped' }).first()).toContainText(
      'Its checklist score is below your minimum.',
      { timeout: 15_000 },
    );
    await expect(autoBuys()).toHaveCount(1);

    // 16.5: the setup is invalidated before the buy filled: the buy goes, with its stop and target.
    await transition(setupId, { to: 'resolved' });
    await expect(openOrders().getByRole('row').filter({ hasText: 'Automatic' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(decisions().getByRole('row').filter({ hasText: 'Cancelled' }).first()).toContainText(
      'The setup was invalidated before the buy filled.',
    );
  });

  test('16.3 the stop button switches it off and cancels its working orders within 5 s', async () => {
    await transition(randomUUID());
    await expect(autoBuys().first()).toBeVisible({ timeout: 15_000 });
    await card().getByRole('button', { name: 'Stop and cancel its orders' }).click();
    const confirm = card().getByRole('group', { name: 'Stop automatic practice trading' });
    await expect(confirm).toContainText('What it bought stays in your practice balance.');
    const started = Date.now();
    await confirm.getByRole('button', { name: 'Stop it' }).click();
    await expect(openOrders().getByRole('row').filter({ hasText: 'Automatic' })).toHaveCount(0, {
      timeout: 5_000,
    });
    test.info().annotations.push({ type: 'stop', description: `${Date.now() - started} ms to cancelled` });
    await expect(card().getByText('Off', { exact: true })).toBeVisible();
    expect((await strategy()).enabled).toBe(false);
    await expect(decisions().getByRole('row').filter({ hasText: 'Cancelled' }).first()).toContainText(
      'You stopped automatic trading.',
    );
  });

  test('a fixed amount (changed 2026-11-16): with 10 USDT a buy, the automatic buy spends about 10 USDT', async () => {
    const current = await strategy();
    const saved = await api.put('/api/v1/practice/automatic', {
      headers,
      data: { version: current.version, rules: { ...current.rules, sizing: 'fixed', amount: 10 } },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const { version } = (await saved.json()) as Strategy;
    const on = await api.post('/api/v1/practice/automatic/on', { headers, data: { version } });
    expect(on.status(), await on.text()).toBe(200);
    // The card shows the choice and says what each buy spends.
    await page.reload();
    await expect(card().getByLabel('A fixed amount')).toBeChecked();
    await expect(card().getByLabel('Amount per buy (USDT)')).toHaveValue('10');

    const setupId = randomUUID();
    await transition(setupId);
    await expect(autoBuys().first()).toBeVisible({ timeout: 15_000 });
    const orders = (await (await api.get('/api/v1/practice/orders?status=open', { headers })).json()) as {
      items: { setupId: string | null; side: string; quantity: string; limitPrice: string | null }[];
    };
    const buy = orders.items.find((o) => o.setupId === setupId && o.side === 'buy');
    expect(buy, 'the automatic buy').toBeTruthy();
    // 10 ÷ the entry, rounded down to the quantity step: never more than 10 USDT, and within one step of it.
    const spent = Number(buy!.quantity) * Number(buy!.limitPrice);
    expect(spent).toBeLessThanOrEqual(10);
    expect(spent).toBeGreaterThan(10 - 0.00001 * Number(buy!.limitPrice) - 1e-9);

    const stopped = await api.post('/api/v1/practice/automatic/stop', { headers });
    expect([200, 202]).toContain(stopped.status());
    await expect(openOrders().getByRole('row').filter({ hasText: 'Automatic' })).toHaveCount(0, {
      timeout: 5_000,
    });
  });
});
