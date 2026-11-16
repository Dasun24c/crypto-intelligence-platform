/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { LIVE_ONLY, REPLAY_STACK } from '../support/stack.ts';
import { accessToken, signIn } from '../support/session.ts';
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
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, ANALYST);
  });

  test.afterAll(async () => {
    if (api) {
      await api.post('/api/v1/practice/automatic/stop', { headers }).catch(() => undefined);
      if (ruleId) await api.delete(`/api/v1/alerts/rules/${ruleId}`, { headers }).catch(() => undefined);
      await api.dispose();
    }
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
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'Switch on' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card().getByText('On', { exact: true })).toBeVisible();
    expect((await strategy()).enabled).toBe(true);
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
});
