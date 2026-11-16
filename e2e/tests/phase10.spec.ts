/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { accessToken, signIn } from '../support/session.ts';
import { ANALYST } from '../support/users.ts';

/**
 * Phase 10 (3D visualization, ADR 024), criteria 10.1 and 10.4, against a running stack (live or
 * replay). The services report their activity every second; the System Brain page shows it in words
 * and in the scene. A pulse is made the way the analyzer would: a setup transition appended to the
 * stack's `an:events`. Criterion 10.3 (the frame rate on reference hardware) is measured by
 * `phase10-perf.spec.ts`, run on purpose with E2E_PERF=1.
 *
 * On Windows the browser draws with the GPU (ANGLE over Direct3D 11); elsewhere (CI) with
 * SwiftShader, in software, where the automatic quality settles low.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:16379';

test.use({
  launchOptions: {
    // Elsewhere SwiftShader draws in software; newer Chromium asks for it by name.
    args:
      process.platform === 'win32'
        ? ['--use-angle=d3d11', '--ignore-gpu-blocklist']
        : ['--enable-unsafe-swiftshader'],
  },
});

interface Instrument {
  id: string;
  venue: string;
  base: string;
  quote: string;
}

const VENUE = { binance: 'Binance', coinbase: 'Coinbase', replay: 'Replay' } as Record<string, string>;

declare function setVisibility(v: 'hidden' | 'visible'): void;

test.describe('Phase 10', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(3 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let redis: Redis;
  let btc: Instrument;

  const status = () => page.getByRole('region', { name: 'Status' });
  const scene = () => page.locator('[data-brain-view="3d"]');
  const frames = async () => Number((await scene().getAttribute('data-frames')) ?? 0);

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    const headers = await accessToken(api, ANALYST);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    const pair = (venue: string) =>
      instruments.find((i) => i.venue === venue && i.base === 'BTC' && i.quote === 'USDT');
    btc = (pair('binance') ?? pair('replay'))!;
    expect(btc, 'a BTC/USDT pair is enabled').toBeTruthy();
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, ANALYST);
  });

  test.afterAll(async () => {
    await api?.dispose();
    redis?.disconnect();
    await ctx?.close();
  });

  test('10.1 the page shows what the services report, in words and in the 3D view, and a setup change pulses', async () => {
    await page.getByRole('link', { name: 'System Brain' }).click();
    await expect(page.getByRole('heading', { name: 'System Brain' })).toBeVisible();
    // The ingestor's own count: venue messages a second, above zero while the venues stream.
    const ingest = status().locator('[data-brain-ingest]');
    await expect(ingest).toHaveText(/venue messages a second/, { timeout: 15_000 });
    await expect
      .poll(async () => Number(((await ingest.textContent()) ?? '').split(' ')[0]!.replace(/,/g, '')), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await expect(status().locator('[data-brain-state]')).not.toHaveText(
      /Waiting for the first activity report/,
    );
    // The 3D view draws, frame after frame.
    await expect(scene()).toBeVisible({ timeout: 30_000 });
    await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(10);
    const fps = Number(await scene().getAttribute('data-fps'));
    test.info().annotations.push({
      type: 'rendering',
      description: `${fps} fps at ${await scene().getAttribute('data-quality')} quality`,
    });
    await expect(scene()).toHaveAttribute('data-frameloop', 'always');

    // A setup transition, as the analyzer appends it: a pattern pulse, named with its pair.
    const now = Date.now();
    await redis.xadd(
      'an:events',
      '*',
      'type',
      'setup',
      'data',
      JSON.stringify({
        id: randomUUID(),
        instrumentId: btc.id,
        runId: randomUUID(),
        pattern: 'htf_order_block',
        variant: null,
        direction: 'bullish',
        contextTf: '1h',
        setupTf: '15m',
        state: 'watching',
        resolution: null,
        displayLabel: 'Watching',
        levels: null,
        score: 40,
        mandatoryPassed: false,
        qualityFlags: [],
        flags: [],
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        disclaimer: 'Educational analysis — not financial advice',
        transition: {
          from: null,
          to: 'watching',
          reason: 'e2e phase 10',
          candleTime: now - 900_000,
          decidedAt: now - 500,
          processedAt: now,
          late: false,
          evidence: {},
        },
      }),
    );
    await expect(status().locator('[data-brain-pulses] li').first()).toHaveText(
      new RegExp(`Setup change on ${VENUE[btc.venue]} BTC/USDT$`),
      { timeout: 10_000 },
    );
    await expect
      .poll(async () => Number(await scene().getAttribute('data-pulses')), { timeout: 5_000 })
      .toBeGreaterThan(0);
  });

  test('10.4 the text status is always there; pausing stops drawing; reduced motion draws a still frame; axe passes', async () => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([]);

    // Pause animation (WCAG 2.2.2): no frame is drawn.
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expect(scene()).toHaveAttribute('data-frameloop', 'never');
    await expect(status()).toContainText('Animation paused.');
    const paused = await frames();
    await page.waitForTimeout(1_500);
    expect(await frames()).toBeLessThanOrEqual(paused + 1);
    await page.getByRole('button', { name: 'Resume animation' }).click();
    await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(paused + 10);

    // Reduced motion: the loop draws on demand only, and the status says why.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(scene()).toHaveAttribute('data-frameloop', 'demand');
    await expect(status()).toContainText('Still image: your system asks for reduced motion.');
    await expect(status().locator('[data-brain-state]')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(scene()).toHaveAttribute('data-frameloop', 'always');
  });

  test('10.4 a hidden tab draws nothing, and the view goes back to drawing when shown', async () => {
    await page.addInitScript(() => {
      // What a browser does when the tab is hidden or shown again.
      (window as unknown as { setVisibility: (v: string) => void }).setVisibility = (v) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });
    await page.reload();
    await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(10);
    const other = await ctx.newPage();
    await other.goto('/');
    await other.bringToFront();
    // Headless Chromium keeps every tab visible: then the page is told so, as a browser tells it.
    const simulated = (await page.evaluate(() => document.visibilityState)) !== 'hidden';
    if (simulated) await page.evaluate(() => setVisibility('hidden'));
    test
      .info()
      .annotations.push({ type: 'hidden tab', description: simulated ? 'signalled to the page' : 'real' });
    await expect(scene()).toHaveAttribute('data-frameloop', 'never');
    const before = await frames();
    await other.waitForTimeout(1_500);
    expect(await frames()).toBeLessThanOrEqual(before + 1);
    await page.bringToFront();
    await other.close();
    if (simulated) await page.evaluate(() => setVisibility('visible'));
    await expect(scene()).toHaveAttribute('data-frameloop', 'always');
    await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(before + 5);
  });

  test('without WebGL2 the 2D view stands in; with the live connection lost it says Disconnected', async () => {
    const plain = await ctx.newPage();
    await plain.addInitScript(() => {
      delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
    });
    await plain.goto('/brain');
    await expect(plain.getByText(/WebGL2 is not available/)).toBeVisible();
    await expect(plain.locator('[data-brain-view="2d"]').getByRole('meter')).toHaveCount(4);
    await expect(plain.locator('canvas')).toHaveCount(0);
    await plain.close();

    await ctx.setOffline(true);
    try {
      await expect(status().getByText('Disconnected', { exact: true })).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx.setOffline(false);
    }
    await expect(status().getByText('Disconnected', { exact: true })).toBeHidden({ timeout: 30_000 });
  });
});
