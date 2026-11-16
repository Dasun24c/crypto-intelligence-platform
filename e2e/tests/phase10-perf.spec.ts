/// <reference lib="dom" />
import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from '../support/session.ts';
import { ANALYST } from '../support/users.ts';

/**
 * Phase 10, criterion 10.3: the frame rate of the 3D brain at each quality, from the page's own
 * frame-time telemetry (`data-fps`, averaged over 2 s), on this machine's GPU (ANGLE over Direct3D 11
 * on Windows), at 1× and 2× pixel density (2×: a Retina display, four times the pixels). Run on
 * purpose, against the live stack, with E2E_PERF=1 (and E2E_HEADED=1 to draw in a visible window).
 * The results go to test-results/phase10-perf-{1,2}x.json.
 */
const HEADED = process.env.E2E_HEADED === '1';
test.skip(process.env.E2E_PERF !== '1', 'a measurement, run on purpose with E2E_PERF=1');
test.use({
  viewport: { width: 1440, height: 900 },
  headless: !HEADED,
  launchOptions: {
    args: process.platform === 'win32' ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : [],
  },
});

const WARM_UP_MS = 4_000;
const SAMPLE_MS = 12_000;

async function sample(page: Page): Promise<{ mean: number; min: number; tiers: string[] }> {
  const box = page.locator('[data-brain-view="3d"]');
  await page.waitForTimeout(WARM_UP_MS);
  const fps: number[] = [];
  const tiers = new Set<string>();
  for (let t = 0; t < SAMPLE_MS; t += 500) {
    await page.waitForTimeout(500);
    const v = Number(await box.getAttribute('data-fps'));
    if (v > 0) fps.push(v);
    tiers.add((await box.getAttribute('data-quality')) ?? '');
  }
  return {
    mean: Math.round((fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length)) * 10) / 10,
    min: Math.min(...fps),
    tiers: [...tiers],
  };
}

for (const scale of [1, 2] as const)
  test.describe(`at ${scale}× pixel density`, () => {
    test.use({ deviceScaleFactor: scale });
    test(`10.3 the frame rate at each quality on this machine (${scale}×)`, async ({
      page,
      browserName,
    }, testInfo) => {
      test.setTimeout(5 * 60_000);
      await signIn(page, ANALYST);
      await page.goto('/brain');
      await expect(page.locator('[data-brain-view="3d"]')).toBeVisible({ timeout: 30_000 });
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      });
      const results: Record<string, { mean: number; min: number; tiers: string[] }> = {};
      for (const quality of ['high', 'medium', 'low', 'auto'] as const) {
        await page.getByLabel('Quality').selectOption(quality);
        await expect(page.locator('[data-brain-view="3d"]')).toBeVisible();
        results[quality] = await sample(page);
        if (quality === 'high')
          await page.screenshot({ path: testInfo.outputPath('system-brain-high.png'), fullPage: false });
      }
      const report = {
        at: new Date().toISOString(),
        browser: browserName,
        headed: HEADED,
        scale,
        renderer,
        results,
      };
      writeFileSync(testInfo.outputPath('phase10-perf.json'), JSON.stringify(report, null, 2));
      writeFileSync(`e2e/test-results/phase10-perf-${scale}x.json`, JSON.stringify(report, null, 2));
      testInfo.annotations.push({ type: 'frame rate', description: JSON.stringify(report) });
      // The default quality (Automatic, starting at High) holds 50 fps or more on this machine.
      expect(results['auto']!.mean).toBeGreaterThanOrEqual(50);
    });
  });
