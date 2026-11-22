import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { accessToken, signIn } from '../support/session.ts';
import { VIEWER } from '../support/users.ts';

/**
 * Phase 11 (Whale Tracker, ADR 025), criteria 11.1 and 11.3, against a running stack (live or
 * replay). The test only talks to the platform: the on-chain watcher is switched off on the local
 * and replay stacks, so nothing here reaches a blockchain provider. Criterion 11.2's detection is
 * covered by the jobs service's tests on recorded chain data.
 */

interface LargeTrade {
  id: string;
  instrumentId: string;
  ts: number;
  takerSide: 'buy' | 'sell';
  notionalUsd: string;
}
interface Wall {
  id: string;
  instrumentId: string;
  firstSeen: number;
  endedReason: string | null;
}
interface FlowInstrument {
  instrumentId: string;
  largeTrades: number;
  buys: number;
  sells: number;
  boughtUsd: string;
  soldUsd: string;
  wallsAppeared: number;
  wallsStanding: number;
}
interface ExchangeFlow {
  from: number;
  to: number;
  instruments: FlowInstrument[];
  largeTrades: LargeTrade[];
  largeTradesTotal: number;
  walls: Wall[];
}

const sum = (values: string[]) => values.reduce((s, v) => s + Number(v), 0);

test.describe('Phase 11', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(3 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let headers: Record<string, string>;

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    headers = await accessToken(api, VIEWER);
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, VIEWER);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await ctx?.close();
  });

  /**
   * The walls first seen in [from, to), counted through Market Activity's endpoint. It lists the
   * newest 1,000 walls of a window, so a full answer is counted again in two halves (a busy pair has
   * more than 1,000 walls in a day).
   */
  async function wallsAppeared(instrumentId: string, from: number, to: number): Promise<number> {
    const res = await api.get(`/api/v1/market/${instrumentId}/walls?from=${from}&to=${to}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const walls = (await res.json()) as Wall[];
    if (walls.length < 1_000 || to - from < 2) return walls.length;
    const mid = Math.floor((from + to) / 2);
    return (await wallsAppeared(instrumentId, from, mid)) + (await wallsAppeared(instrumentId, mid, to));
  }

  /** Every large trade of an instrument in [from, to), through the Market Activity endpoint. */
  async function storedTrades(instrumentId: string, from: number, to: number): Promise<LargeTrade[]> {
    const out: LargeTrade[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `from=${from}&to=${to}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await api.get(`/api/v1/market/${instrumentId}/large-trades?${q}`, { headers });
      expect(res.status(), await res.text()).toBe(200);
      const page_ = (await res.json()) as { items: LargeTrade[]; nextCursor: string | null };
      out.push(...page_.items);
      cursor = page_.nextCursor;
    } while (cursor);
    return out;
  }

  test('11.1 the Exchange flow tab shows exactly the stored large trades and walls', async () => {
    const response = page.waitForResponse((r) => r.url().includes('/api/v1/whales/exchange'));
    await page.goto('/whales');
    await expect(page.getByRole('heading', { name: 'Whale Tracker', level: 1 })).toBeVisible();
    const res = await response;
    expect(res.status()).toBe(200);
    const flow = (await res.json()) as ExchangeFlow;
    const shown = new URL(res.url()).searchParams;
    expect(Number(shown.get('to')) - Number(shown.get('from'))).toBe(24 * 3_600_000);

    // The page shows the response: one row per instrument, with its numbers.
    const rows = page.locator('[data-flow-instrument]');
    await expect(rows).toHaveCount(flow.instruments.length);
    for (const s of flow.instruments) {
      const row = page.locator(`[data-flow-instrument="${s.instrumentId}"]`);
      await expect(row).toHaveAttribute('data-large-trades', String(s.largeTrades));
      await expect(row).toHaveAttribute('data-bought-usd', s.boughtUsd);
      await expect(row).toHaveAttribute('data-walls-appeared', String(s.wallsAppeared));
    }
    await expect(page.locator('[data-trade-id]')).toHaveCount(flow.largeTrades.length);
    await expect(page.locator('[data-wall-id]')).toHaveCount(flow.walls.length);

    // The response matches what is stored, as Market Activity's own endpoints read it.
    for (const s of flow.instruments) {
      const trades = await storedTrades(s.instrumentId, flow.from, flow.to);
      expect(trades.length, `${s.instrumentId} large trades`).toBe(s.largeTrades);
      const buys = trades.filter((t) => t.takerSide === 'buy');
      expect(buys.length).toBe(s.buys);
      expect(sum(buys.map((t) => t.notionalUsd))).toBeCloseTo(Number(s.boughtUsd), 2);
      expect(sum(trades.filter((t) => t.takerSide === 'sell').map((t) => t.notionalUsd))).toBeCloseTo(
        Number(s.soldUsd),
        2,
      );
      expect(await wallsAppeared(s.instrumentId, flow.from, flow.to), `${s.instrumentId} walls`).toBe(
        s.wallsAppeared,
      );
      const standing = await api.get(`/api/v1/market/${s.instrumentId}/walls?active=true`, { headers });
      // Walls can end between the two reads: the count is the standing walls seen by either.
      expect(Math.abs(((await standing.json()) as Wall[]).length - s.wallsStanding)).toBeLessThanOrEqual(2);
    }
    expect(flow.largeTradesTotal).toBe(flow.instruments.reduce((n, s) => n + s.largeTrades, 0));
    // Listed newest first, all inside the window.
    for (const [i, t] of flow.largeTrades.entries()) {
      expect(t.ts).toBeGreaterThanOrEqual(flow.from);
      expect(t.ts).toBeLessThan(flow.to);
      if (i > 0) expect(t.ts).toBeLessThanOrEqual(flow.largeTrades[i - 1]!.ts);
    }
  });

  test('11.3 exchange and on-chain data are separate tabs, never one list; both pass axe and work from the keyboard', async () => {
    await page.goto('/whales');
    const exchangeTab = page.getByRole('tab', { name: 'Exchange flow' });
    await expect(exchangeTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-onchain-event], [data-onchain-asset]')).toHaveCount(0);
    const scan = async () => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id);
    };
    await expect(
      page
        .getByRole('table', { name: 'Large trades and walls per instrument in the window' })
        .or(page.getByText('No large trade or wall in this window.')),
    ).toBeVisible();
    expect(await scan()).toEqual([]);

    // Keyboard: the arrow key moves to the On-chain tab.
    await exchangeTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'On-chain' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-trade-id], [data-wall-id], [data-flow-instrument]')).toHaveCount(0);
    const panel = page.getByRole('tabpanel');
    await expect(panel.locator('[data-onchain-asset]')).toHaveCount(4);
    // On the local and replay stacks the watcher is switched off: every source says so.
    const states = await panel
      .locator('[data-source]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-source-state')));
    expect(states).toHaveLength(3);
    if (states.every((s) => s === 'off'))
      await expect(panel.getByText('The on-chain watcher is switched off on this stack')).toBeVisible();
    expect(await scan()).toEqual([]);

    // The API keeps them apart too: the exchange flow carries no on-chain field, and the reverse.
    const exchange = await (await api.get('/api/v1/whales/exchange', { headers })).json();
    expect(Object.keys(exchange).sort()).toEqual([
      'from',
      'instruments',
      'largeTrades',
      'largeTradesTotal',
      'to',
      'walls',
    ]);
    const onchain = await (await api.get('/api/v1/whales/onchain', { headers })).json();
    expect(Object.keys(onchain).sort()).toEqual(['from', 'items', 'nextCursor', 'summary', 'to']);
  });
});
