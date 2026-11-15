/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { accessToken, signIn } from '../support/session.ts';
import { VIEWER } from '../support/users.ts';

/**
 * Phase 14 (practice trading), criteria 14.1, 14.6, 14.7, 14.9 and 14.12, against a running stack
 * with the broker. Orders are simulated: they fill from the live market data the stack streams (or
 * replays), on the viewer's practice balances. Nothing reaches an exchange.
 *
 * The orders use Binance BTC/USDT. Without its live trades and book (no venue access), every order
 * would be refused as `data_delayed`; the specs then stop with that reason rather than pass.
 */
const BANNER = 'Practice trading: simulated orders, no real money.';
const RUN = Date.now().toString(36);

interface Instrument {
  id: string;
  venue: string;
  base: string;
  quote: string;
  displayName: string;
  role: string;
  priceTick: string;
  qtyStep: string;
  minNotional: string;
}
interface FeedStatus {
  instrumentId: string;
  stream: string;
  state: string;
}
interface Ticker {
  bid: string;
  ask: string;
}

/** Decimal steps without floats: `value` rounded to a whole number of `step`s. */
function onSteps(value: number, step: string, up: boolean): string {
  const places = (step.split('.')[1] ?? '').length;
  const unit = Number(step);
  const n = up ? Math.ceil(value / unit - 1e-9) : Math.floor(value / unit + 1e-9);
  return (n * unit).toFixed(places);
}

test.describe('Phase 14', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(10 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let headers: Record<string, string>;
  let btc: Instrument;
  let qty: string;
  /** For limit buys at half the price: worth as much as `qty` at the market. */
  let qtyAtHalf: string;
  const rules: string[] = [];

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    headers = await accessToken(api, VIEWER);
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    btc = instruments.find((i) => i.venue === 'binance' && i.base === 'BTC' && i.quote === 'USDT')!;
    expect(btc, 'Binance BTC/USDT is enabled').toBeTruthy();
    // Practice orders need the pair's live trades and book (TRD-07).
    await expect
      .poll(
        async () => {
          const feeds = (await (await api.get('/api/v1/system/feeds', { headers })).json()) as FeedStatus[];
          return ['trades', 'depth'].every((s) =>
            feeds.some((f) => f.instrumentId === btc.id && f.stream === s && f.state === 'connected'),
          );
        },
        { timeout: 120_000, message: 'BTC/USDT trades and book streaming (no venue access?)' },
      )
      .toBe(true);
    const ticker = (await (await api.get(`/api/v1/market/${btc.id}/ticker`, { headers })).json()) as Ticker;
    // A small quantity, worth well over the venue minimum (at least 10 USDT, the minimum the pair-status
    // job may not have read yet on a fresh stack).
    qty = onSteps((Math.max(Number(btc.minNotional), 10) * 1.5) / Number(ticker.ask), btc.qtyStep, true);
    qtyAtHalf = onSteps(Number(qty) * 2, btc.qtyStep, true);
    // Start from the starting balances.
    const reset = await api.post('/api/v1/practice/account/reset', { headers, data: { venue: 'binance' } });
    expect([200, 202]).toContain(reset.status());
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, VIEWER);
  });

  test.afterAll(async () => {
    for (const id of rules)
      await api.delete(`/api/v1/alerts/rules/${id}`, { headers }).catch(() => undefined);
    await api?.dispose();
    await ctx?.close();
  });

  const ticket = {
    pair: () => page.getByLabel('Pair'),
    quantity: () => page.getByLabel(`Quantity (BTC)`),
    review: () => page.getByRole('button', { name: 'Review order' }),
    place: () => page.getByRole('button', { name: 'Place practice order' }),
  };
  const fills = () => page.getByRole('table', { name: 'Simulated practice fills' });
  const openOrders = () => page.getByRole('table', { name: 'Open practice orders' });
  const balances = () => page.getByRole('table', { name: 'Binance practice balances' });
  const holdings = () => page.getByRole('table', { name: 'Practice holdings and results, simulated' });

  async function order(side: 'Buy' | 'Sell', type: 'Market' | 'Limit', quantity: string, limit?: string) {
    await page.getByLabel(side, { exact: true }).check();
    await page.getByLabel(type, { exact: true }).check();
    await ticket.quantity().fill(quantity);
    if (limit) await page.getByLabel('Limit price (USDT)').fill(limit);
    await ticket.review().click();
    await expect(page.getByRole('heading', { name: 'Confirm your practice order' })).toBeFocused();
    await ticket.place().click();
    await expect(page.getByText('Practice order submitted')).toBeVisible();
  }

  async function openPractice() {
    await page.goto('/practice');
    await expect(page.getByRole('heading', { name: 'Practice Trading' })).toBeVisible();
    await ticket.pair().selectOption({ label: btc.displayName });
    await expect(page.locator('dt', { hasText: 'Best ask (live)' }).locator('+ dd')).not.toHaveText('—', {
      timeout: 30_000,
    });
  }

  test('14.1 a user buys and sells with market orders, rests and cancels a limit order, and sees balances, holdings and results', async () => {
    await openPractice();
    await order('Buy', 'Market', qty);
    // The broker fills it from the live book and the practice channel brings the result.
    await expect(fills().getByRole('row').filter({ hasText: 'Buy' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(balances().getByRole('row').filter({ hasText: /^BTC/ })).toContainText(
      qty.replace(/0+$/, ''),
    );
    await expect(holdings().getByRole('row').filter({ hasText: 'BTC/USDT' })).toBeVisible({
      timeout: 15_000,
    });

    await order('Sell', 'Market', qty);
    await expect(fills().getByRole('row').filter({ hasText: 'Sell' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      holdings().getByRole('row').filter({ hasText: 'BTC/USDT' }).getByRole('cell').nth(1),
    ).toHaveText('0', { timeout: 15_000 });
    await expect(page.getByRole('list', { name: 'Results by currency' })).toContainText('USDT: realised');

    // Half the best bid: it rests until cancelled.
    const bid = await page.locator('dt', { hasText: 'Best bid (live)' }).locator('+ dd').innerText();
    const limit = onSteps(Number(bid.replaceAll(',', '')) / 2, btc.priceTick, false);
    await order('Buy', 'Limit', qtyAtHalf, limit);
    const row = openOrders().getByRole('row').filter({ hasText: 'Open' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /^Cancel Buy/ }).click();
    await expect(page.getByText('No open practice orders.')).toBeVisible({ timeout: 15_000 });
    await expect(
      page
        .getByRole('table', { name: 'Finished practice orders' })
        .getByRole('row')
        .filter({ hasText: 'Cancelled' })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('14.1 on every monitored pair that streams, a market buy and a market sell fill from its live book', async () => {
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    const feeds = (await (await api.get('/api/v1/system/feeds', { headers })).json()) as FeedStatus[];
    const pairs = instruments.filter((i) => i.role === 'monitored' && i.venue !== 'replay');
    for (const venue of ['binance', 'coinbase']) {
      const reset = await api.post('/api/v1/practice/account/reset', { headers, data: { venue } });
      expect([200, 202]).toContain(reset.status());
    }
    const filled = async (id: string) =>
      expect
        .poll(
          async () =>
            (
              (await (await api.get(`/api/v1/practice/orders/${id}`, { headers })).json()) as {
                status: string;
              }
            ).status,
          { timeout: 15_000 },
        )
        .toBe('filled');
    const outcome: Record<string, string> = {};
    for (const i of pairs) {
      const live = ['trades', 'depth'].every((s) =>
        feeds.some((f) => f.instrumentId === i.id && f.stream === s && f.state === 'connected'),
      );
      if (!live) {
        outcome[i.displayName] = 'not streaming';
        continue;
      }
      const t = (await (await api.get(`/api/v1/market/${i.id}/ticker`, { headers })).json()) as Ticker;
      const quantity = onSteps((Math.max(Number(i.minNotional), 10) * 1.5) / Number(t.ask), i.qtyStep, true);
      for (const side of ['buy', 'sell'] as const) {
        const data = {
          clientOrderId: `e2e-${RUN}-${i.id}-${side}`,
          instrumentId: i.id,
          side,
          type: 'market',
          quantity,
        };
        // Sixteen orders in a few seconds pass the 5-a-second limit: as a client should, wait as long as
        // Retry-After says and send the same order again (the same clientOrderId cannot make two).
        let res = await api.post('/api/v1/practice/orders', { headers, data });
        for (let attempt = 0; res.status() === 429 && attempt < 3; attempt++) {
          await page.waitForTimeout(Number(res.headers()['retry-after'] ?? '1') * 1_000);
          res = await api.post('/api/v1/practice/orders', { headers, data });
        }
        expect([200, 201], `${i.displayName} ${side}: ${await res.text()}`).toContain(res.status());
        await filled(((await res.json()) as { id: string }).id);
      }
      outcome[i.displayName] = 'bought and sold';
    }
    test.info().annotations.push({ type: 'pairs', description: JSON.stringify(outcome) });
    expect(outcome[btc.displayName]).toBe('bought and sold');
    expect(Object.values(outcome).filter((o) => o === 'bought and sold').length).toBeGreaterThanOrEqual(1);
  });

  test('14.7 and 14.12 the page is labelled as simulated, passes axe, and its ticket works from the keyboard, confirmation included', async () => {
    await openPractice();
    // The page's banner, in its header (Phase 16's automatic trading card carries one too).
    await expect(page.getByRole('note').filter({ hasText: BANNER }).first()).toBeVisible();
    for (const title of ['Holdings and results (simulated)', 'Fills (simulated)'])
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const scan = async () => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id);
    };
    expect(await scan()).toEqual([]);

    // Keyboard only: type the quantity, Enter reviews, the confirmation takes the focus, Escape goes
    // back, and Tab and Enter place the order.
    await page.getByLabel('Buy', { exact: true }).check();
    await page.getByLabel('Market', { exact: true }).check();
    await ticket.quantity().focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(qty);
    await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { name: 'Confirm your practice order' });
    await expect(heading).toBeFocused();
    await expect(
      page.getByRole('region', { name: 'Confirm your practice order' }).getByText(BANNER),
    ).toBeVisible();
    expect(await scan()).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(ticket.place()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(ticket.review()).toBeVisible();
    await ticket.review().focus();
    await page.keyboard.press('Enter');
    await expect(heading).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Practice order submitted')).toBeVisible();
    await expect(fills().getByRole('row').filter({ hasText: 'Buy' }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('14.6 "Practise this setup" fills in the ticket and nothing is placed until the user confirms', async () => {
    const posted: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/v1/practice/orders')) posted.push(r.url());
    });
    const res = await api.get(`/api/v1/setups?instrumentId=${btc.id}&direction=bullish&limit=100`, {
      headers,
    });
    expect(res.ok(), await res.text()).toBe(true);
    const setups = (
      (await res.json()) as {
        items: { id: string; levels: { entry: string | null; invalidation: string | null } }[];
      }
    ).items;
    const usable = setups.find((s) => s.levels.entry !== null && s.levels.invalidation !== null);
    if (usable) {
      await page.goto(`/setups/${usable.id}`);
      await page.getByRole('link', { name: 'Practise this setup' }).click();
    } else {
      // No bullish setup on this stack now: the same link the setup page builds.
      test.info().annotations.push({
        type: 'note',
        description: 'No bullish setup with levels: ticket opened by its link',
      });
      await page.goto(
        `/practice?instrument=${btc.id}&setup=${crypto.randomUUID()}&quantity=%22${qty}%22&limit=%221000%22&stop=%22900%22&target=%221200%22`,
      );
    }
    await expect(page.getByText('Filled in from a setup')).toBeVisible();
    await expect(page.getByLabel('Limit', { exact: true })).toBeChecked();
    await expect(ticket.quantity()).not.toHaveValue('');
    await expect(page.getByLabel('Protective stop (USDT, optional)')).not.toHaveValue('');
    await page.waitForTimeout(2_000);
    expect(posted).toEqual([]);
    await ticket.review().click();
    await expect(page.getByRole('heading', { name: 'Confirm your practice order' })).toBeFocused();
    await page.getByRole('button', { name: 'Back to edit' }).click();
    expect(posted).toEqual([]);
  });

  test('14.9 a practice fill arrives as an alert, and open orders resynchronise after the connection drops', async () => {
    const created = await api.post('/api/v1/alerts/rules', {
      headers,
      data: {
        name: `e2e practice ${RUN}`,
        condition: { kind: 'practice_order_filled' },
        channels: ['in_app', 'web'],
        cooldownSec: 0,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const ruleId = ((await created.json()) as { id: string }).id;
    rules.push(ruleId);
    await page.waitForTimeout(7_000); // the analyzer reloads rules every 5 s

    await openPractice();
    await order('Buy', 'Market', qty);
    await expect
      .poll(
        async () => {
          const events = (await (
            await api.get(`/api/v1/alerts/events?ruleId=${ruleId}`, { headers })
          ).json()) as {
            items: { title: string; body: string }[];
          };
          return events.items.map((e) => e.title);
        },
        { timeout: 60_000 },
      )
      .toEqual(['BTC · Binance BTC/USDT: practice buy filled']);
    await page.goto('/alerts');
    await expect(page.getByText('BTC · Binance BTC/USDT: practice buy filled').first()).toBeVisible({
      timeout: 30_000,
    });

    // A resting order; the connection drops; the order is cancelled meanwhile (from another device,
    // here the API); back online, the page shows it gone without a reload.
    await openPractice();
    const bid = await page.locator('dt', { hasText: 'Best bid (live)' }).locator('+ dd').innerText();
    await order(
      'Buy',
      'Limit',
      qtyAtHalf,
      onSteps(Number(bid.replaceAll(',', '')) / 2, btc.priceTick, false),
    );
    const row = openOrders().getByRole('row').filter({ hasText: 'Open' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const orderId = await row.getAttribute('data-order');
    await ctx.setOffline(true);
    const cancel = await api.post(`/api/v1/practice/orders/${orderId}/cancel`, { headers });
    expect([200, 202]).toContain(cancel.status());
    await page.waitForTimeout(3_000);
    await ctx.setOffline(false);
    await expect(page.getByText('No open practice orders.')).toBeVisible({ timeout: 60_000 });
  });
});
