/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { accessToken, signIn, signInAdmin } from '../support/session.ts';
import { VIEWER } from '../support/users.ts';

/**
 * Phase 7 (charts, Setup Scanner and calendar), criteria 7.1–7.5, against a running stack. The
 * shapes below are the parts of the API this reads; the e2e project does not import @cip/contracts,
 * and builds its expectations from the API's JSON on its own, never with the app's code.
 */
interface Instrument {
  id: string;
  displayName: string;
  underlyingCalendar: 'gold' | null;
  venue: string;
}
interface Run {
  instrumentId: string;
  mode: string;
  status: string;
}
type Rec = Record<string, string | number | boolean | null>;
interface Overlay {
  swings: { id: string; kind: string; price: string; candleTime: number }[];
  structure: { id: string; type: string; breakPrice: string; breakCandleTime: number }[];
  ranges: { id: string; high: string; low: string; windowStart: number }[];
  levels: { id: string; price: string; knownAt: number; status: string }[];
  sweeps: { id: string; extremePrice: string; confirmedAt: number; flags: string[] }[];
  zones: { id: string; top: string; bottom: string; originFrom: number; status: string; fillPct: number }[];
  setups: {
    id: string;
    state: string;
    levels: Record<'entry' | 'invalidation' | 'target1' | 'target2', string | null>;
  }[];
  closures: { from: number; to: number }[];
}
interface Setup {
  id: string;
  pattern: string;
  score: number;
}

/** What the chart must have drawn for an overlay: one record per detection (criterion 7.1). */
function expectedRecords(o: Overlay): Rec[] {
  const out: Rec[] = [
    ...o.closures.map((c) => ({ kind: 'closure', id: `closure:${c.from}`, from: c.from, to: c.to })),
    ...o.ranges.map((r) => ({ kind: 'range', id: r.id, from: r.windowStart, high: r.high, low: r.low })),
    ...o.zones.map((z) => ({
      kind: 'zone',
      id: z.id,
      from: z.originFrom,
      top: z.top,
      bottom: z.bottom,
      status: z.status,
      fillPct: z.fillPct,
    })),
    ...o.levels.map((l) => ({ kind: 'level', id: l.id, from: l.knownAt, price: l.price, status: l.status })),
    ...o.setups.map((s) => ({
      kind: 'setup',
      id: s.id,
      state: s.state,
      entry: s.levels.entry,
      invalidation: s.levels.invalidation,
      target1: s.levels.target1,
      target2: s.levels.target2,
    })),
    ...o.swings.map((s) => ({ kind: 'swing', id: s.id, at: s.candleTime, price: s.price, side: s.kind })),
    ...o.structure.map((e) => ({
      kind: 'structure',
      id: e.id,
      at: e.breakCandleTime,
      price: e.breakPrice,
      type: e.type,
    })),
    ...o.sweeps.map((s) => ({
      kind: 'sweep',
      id: s.id,
      at: s.confirmedAt,
      price: s.extremePrice,
      thinBook: s.flags.includes('thin_book'),
    })),
  ];
  return out.sort((a, b) =>
    a['kind'] === b['kind']
      ? String(a['id']).localeCompare(String(b['id']))
      : String(a['kind']).localeCompare(String(b['kind'])),
  );
}

const canonical = (records: Rec[]) =>
  JSON.stringify(
    [...records]
      .map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))))
      .sort((a, b) => (`${a['kind']}:${a['id']}` < `${b['kind']}:${b['id']}` ? -1 : 1)),
  );

/**
 * Reads what the chart drew and asks the API for the overlay of the window it shows, until both
 * agree (a detection can land between the two reads), and returns the records (criterion 7.1).
 */
async function expectDrawnEqualsApi(
  chart: Locator,
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<Rec[]> {
  const read: { expected?: Rec[] } = {};
  await expect
    .poll(
      async () => {
        const a = await chart.evaluate((el) => ({ ...el.dataset }));
        if (a['ready'] !== 'true' || !a['drawn']) return 'not drawn yet';
        const res = await request.get(
          `/api/v1/smc/${a['instrument']}/overlay?tf=${a['tf']}&from=${a['from']}&to=${a['to']}`,
          { headers },
        );
        if (!res.ok()) return `API answered ${res.status()}`;
        const drawn = JSON.parse(a['drawn']) as Rec[];
        read.expected = expectedRecords((await res.json()) as Overlay);
        return canonical(drawn) === canonical(read.expected)
          ? 'equal'
          : `drawn ${drawn.length}, API ${read.expected.length}`;
      },
      { message: 'the chart drew exactly the overlay', timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe('equal');
  return read.expected!;
}

/** "288 level, 18 structure, …": how many records of each kind. */
function byKind(records: Rec[]): string {
  const n = new Map<string, number>();
  for (const r of records) n.set(String(r['kind']), (n.get(String(r['kind'])) ?? 0) + 1);
  return [...n].map(([kind, count]) => `${count} ${kind}`).join(', ');
}

async function instrumentsWithRuns(request: APIRequestContext, headers: Record<string, string>) {
  const instruments = (await (await request.get('/api/v1/instruments', { headers })).json()) as Instrument[];
  const runs = (await (await request.get('/api/v1/system/runs?limit=100', { headers })).json()) as Run[];
  const running = new Set(
    runs.filter((r) => r.mode === 'live' && r.status === 'running').map((r) => r.instrumentId),
  );
  return instruments.filter((i) => running.has(i.id));
}

/** Presses Tab until the focused element matches, as a keyboard user would (no focus trap). */
async function tabTo(
  page: Page,
  matches: (el: { id: string; label: string; role: string }) => boolean,
  max = 80,
) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return {
        id: a?.id ?? '',
        label: a?.getAttribute('aria-label') ?? a?.textContent?.trim() ?? '',
        role: a?.getAttribute('role') ?? a?.tagName.toLowerCase() ?? '',
      };
    });
    if (matches(el)) return;
  }
  throw new Error('the control is not reachable with Tab');
}

/**
 * Collects the page's uncaught errors and those its error boundaries catch (React logs them as
 * errors); failed requests are logged as errors too, and are not counted.
 */
function watchErrors(page: Page, sink: string[]) {
  page.on('pageerror', (e) => sink.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /^\w*Error\b/.test(m.text())) sink.push(m.text().split('\n')[0]!);
  });
}

async function noSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('Phase 7', () => {
  test.setTimeout(240_000);

  // Sign-in is limited to five a minute per address and per account (API contracts §8), so the
  // viewer signs in once for the whole file: one browser session and one API token, shared by the
  // tests in order. A failed test starts a new worker, which signs in again. 7.3 signs the admin in.
  let viewerContext: BrowserContext;
  let viewer: Page;
  let headers: Record<string, string>;
  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const api = await playwright.request.newContext({ baseURL });
    headers = await accessToken(api, VIEWER);
    await api.dispose();
    // A context of its own (axe opens a page beside the one it checks).
    viewerContext = await browser.newContext({ baseURL });
    viewer = await viewerContext.newPage();
    watchErrors(viewer, pageErrors);
    await signIn(viewer, VIEWER);
  });

  test.afterEach(() => {
    expect(pageErrors.splice(0), 'errors on the page').toEqual([]);
  });

  test.afterAll(async () => {
    await viewerContext?.close();
  });

  test('7.1 the Liquidity Map draws exactly the overlay the API gives for its window', async ({
    request,
  }) => {
    const page = viewer;
    let candidates: Instrument[] = [];
    await expect
      .poll(async () => (candidates = await instrumentsWithRuns(request, headers)).length, {
        message: 'an instrument with a running analysis',
        timeout: 180_000,
        intervals: [2_000, 5_000],
      })
      .toBeGreaterThan(0);
    const instrument =
      candidates.find((i) => i.venue !== 'replay' && !i.underlyingCalendar) ?? candidates[0]!;
    // The longest timeframe with detections (the CI replay venue has no history: 5m at first).
    let tf = '5m';
    for (const t of ['1h', '15m', '5m']) {
      const o = (await (
        await request.get(`/api/v1/smc/${instrument.id}/overlay?tf=${t}`, { headers })
      ).json()) as Overlay;
      if (expectedRecords(o).length > 0) {
        tf = t;
        break;
      }
    }

    await page.goto(`/liquidity?instrument=${instrument.id}&tf=${tf}`);
    await expect(page.getByRole('heading', { name: 'Liquidity Map', level: 1 })).toBeVisible();
    const chart = page.locator('[data-chart="liquidity"]');
    await expect(chart).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Fit all' }).click();
    const drawn = await expectDrawnEqualsApi(chart, request, headers);
    test.info().annotations.push({
      type: 'overlay parity',
      description: `${instrument.displayName} ${tf}: ${drawn.length} items drawn = API (${byKind(drawn)})`,
    });
    await expect(page.getByText(/TradingView Lightweight Charts™/)).toBeVisible();

    // Another timeframe with candles, chosen on the page, replaces the chart (a spinner shows while
    // it loads): the page stays up, and the new chart draws its window's overlay exactly too. 5m comes
    // first: it is a setup timeframe, so its overlay has setups.
    let other: string | undefined;
    for (const t of ['5m', '15m', '1h'].filter((t) => t !== tf)) {
      const res = await request.get(`/api/v1/market/${instrument.id}/candles?tf=${t}&limit=1`, { headers });
      if (res.ok() && ((await res.json()) as unknown[]).length > 0) {
        other = t;
        break;
      }
    }
    if (!other) return; // The CI replay stack's first minutes: no other timeframe has a candle yet.
    await page.getByLabel('Timeframe', { exact: true }).selectOption(other);
    await expect(page).toHaveURL(new RegExp(`[?&]tf=${other}(&|$)`));
    await expect(chart).toHaveAttribute('data-tf', other);
    await expect(chart).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Fit all' }).click();
    const again = await expectDrawnEqualsApi(chart, request, headers);
    test.info().annotations.push({
      type: 'overlay parity',
      description: `${instrument.displayName} ${other}, chosen on the page: ${again.length} items drawn = API (${byKind(again)})`,
    });
  });

  test('7.2 the Setup Scanner shows the API’s setups, filters and sorts them, each with its checklist and levels', async ({
    request,
  }) => {
    const page = viewer;
    const open = 'forming,triggered,confirmed,entry_active';
    const api = async (query: string) =>
      (
        (await (await request.get(`/api/v1/setups?${query}&limit=100`, { headers })).json()) as {
          items: Setup[];
        }
      ).items;
    await page.goto('/setups');
    await expect(page.getByRole('heading', { name: 'Setup Scanner', level: 1 })).toBeVisible();
    await expect(
      page.getByText(/All levels are hypothetical\. Educational analysis — not financial advice/),
    ).toBeVisible();
    const rows = page.locator('tr[data-setup-id]');
    const ids = () => rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-setup-id')!));
    await expect
      .poll(
        async () => {
          const [shown, expected] = [await ids(), (await api(`state=${open}`)).map((s) => s.id)];
          return JSON.stringify([...shown].sort()) === JSON.stringify([...expected].sort())
            ? 'same'
            : `${shown.length} vs ${expected.length}`;
        },
        { message: 'the page lists the open setups the API has', timeout: 60_000 },
      )
      .toBe('same');
    const count = await rows.count();
    test.skip(count === 0, 'no open setup on this stack yet');

    // Sorted by score: never increasing.
    await page.getByLabel('Sort by').selectOption('score');
    await expect
      .poll(async () => {
        const scores = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-score'))));
        return scores.every((s, i) => i === 0 || s <= scores[i - 1]!);
      })
      .toBe(true);

    // Filtered to one pattern: exactly what the API gives for that filter.
    const pattern = await rows.first().getAttribute('data-pattern');
    const short = {
      double_liquidity_trap: 'P1',
      eq_near_poi: 'P2',
      htf_order_block: 'P3',
      sweep_outside_fill_inside: 'P4',
    }[pattern!]!;
    await page.getByLabel(short, { exact: true }).check();
    await expect(page).toHaveURL(new RegExp(`pattern=${pattern}`));
    await expect
      .poll(async () => {
        const [shown, expected] = [
          await ids(),
          (await api(`state=${open}&pattern=${pattern}`)).map((s) => s.id),
        ];
        return JSON.stringify([...shown].sort()) === JSON.stringify([...expected].sort());
      })
      .toBe(true);
    expect(new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-pattern'))))).toEqual(
      new Set([pattern]),
    );
    test.info().annotations.push({
      type: 'scanner',
      description: `${count} open setups listed = API; ${await rows.count()} of pattern ${pattern} = API`,
    });

    // Each setup: its checklist (8 items), levels, R:R and the disclaimer.
    const first = rows.first();
    await first.getByRole('button', { name: /^Show the checklist/ }).click();
    const panel = page.locator(`[data-checklist="${await first.getAttribute('data-setup-id')}"]`);
    await expect(panel.locator('[data-item]')).toHaveCount(8);
    await expect(panel.getByText(/Educational analysis — not financial advice/)).toBeVisible();
    await expect(first.locator('[data-level="rr"]')).toBeVisible();
  });

  test('7.3 the calendar shows the API’s events and blackout windows; an admin’s FOMC entry appears and can be removed', async ({
    page,
    request,
  }) => {
    const status = (await (await request.get('/api/v1/calendar/status', { headers })).json()) as {
      sources: { source: string }[];
      blackouts: { profile: string; beforeMin: number; afterMin: number }[];
    };
    expect(status.sources.map((s) => s.source)).toEqual(['fred', 'bea']);

    watchErrors(page, pageErrors);
    await signInAdmin(page);
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Economic Calendar', level: 1 })).toBeVisible();
    await expect(page.getByText(/uses the FRED® API but is not endorsed or certified/)).toBeVisible();
    // Every event the API lists for the page's window is shown.
    const from = Math.floor(Date.now() / 60_000) * 60_000 - 86_400_000;
    const events = (await (
      await request.get(`/api/v1/calendar/events?from=${from}&to=${from + 61 * 86_400_000}`, { headers })
    ).json()) as {
      id: string;
    }[];
    await expect(page.locator('li[data-event-id]')).toHaveCount(events.length, { timeout: 30_000 });
    test.info().annotations.push({
      type: 'calendar',
      description: `${events.length} events listed = API; blackouts ${status.blackouts
        .map((b) => `${b.profile} ${b.beforeMin}/${b.afterMin} min`)
        .join(', ')}`,
    });

    // An FOMC statement 20 days ahead, at 14:00 New York.
    const day = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const title = `FOMC statement (e2e ${Date.now()})`;
    const form = page.getByRole('form', { name: 'Add a calendar entry' });
    await form.getByLabel('Date').fill(day);
    await form.getByLabel('Title').fill(title);
    await form.getByRole('button', { name: 'Add entry' }).click();
    const item = page.locator('li[data-event-id]', { hasText: title });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-release', 'fomc');
    for (const b of status.blackouts)
      await expect(item.locator(`[data-blackout="${b.profile}"]`)).toBeVisible();
    await item.getByRole('button', { name: /^Remove/ }).click();
    await expect(item).toHaveCount(0);
  });

  test('7.4 no page labels anything XAUUSD, and PAXG charts shade gold-market closures', async ({
    request,
  }) => {
    const page = viewer;
    const instruments = (await (
      await request.get('/api/v1/instruments', { headers })
    ).json()) as Instrument[];
    const paxg = instruments.find((i) => i.underlyingCalendar === 'gold');
    const pages = ['/', '/market', '/analysis', '/liquidity', '/setups', '/calendar', '/system', '/profile'];
    if (paxg) pages.push(`/liquidity?instrument=${paxg.id}&tf=1h`, `/analysis?instrument=${paxg.id}&tf=1h`);
    for (const path of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Let the page's requests settle (the live socket stays open, so do not wait for idle long).
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      // "XAUUSD" may appear only inside the PAXG disclaimer, which says how PAXG differs from it.
      const offenders = await page.evaluate(() => {
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          if (
            /XAU\s*\/?\s*USD/i.test(n.textContent ?? '') &&
            !n.parentElement?.closest('[data-paxg-disclaimer]')
          )
            out.push(n.textContent!.trim());
        for (const el of document.querySelectorAll('*'))
          for (const attr of ['title', 'aria-label', 'alt', 'placeholder', 'value'])
            if (/XAU\s*\/?\s*USD/i.test(el.getAttribute(attr) ?? '')) out.push(`${el.tagName}[${attr}]`);
        return out;
      });
      expect(offenders, path).toEqual([]);
    }
    test.info().annotations.push({ type: 'no XAUUSD label', description: `${pages.length} pages scanned` });
    test.skip(!paxg, 'no gold instrument on this stack');
    await page.goto(`/liquidity?instrument=${paxg!.id}&tf=1h`);
    const chart = page.locator('[data-chart="liquidity"]');
    await expect(chart).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Fit all' }).click();
    let shaded = 0;
    await expect
      .poll(
        async () => {
          const a = await chart.evaluate((el) => ({ ...el.dataset }));
          const o = (await (
            await request.get(`/api/v1/smc/${paxg!.id}/overlay?tf=1h&from=${a['from']}&to=${a['to']}`, {
              headers,
            })
          ).json()) as Overlay;
          const drawn = (JSON.parse(a['drawn'] ?? '[]') as Rec[]).filter((r) => r['kind'] === 'closure');
          shaded = drawn.length;
          return o.closures.length > 0 && drawn.length === o.closures.length
            ? 'shaded'
            : `${drawn.length}/${o.closures.length}`;
        },
        { message: 'every closure in the window is shaded', timeout: 60_000 },
      )
      .toBe('shaded');
    test.info().annotations.push({
      type: 'closures',
      description: `${paxg!.displayName} 1h: ${shaded} closures shaded = API`,
    });
  });

  test('7.5 the new pages pass axe and work from the keyboard', async ({ request }) => {
    const page = viewer;

    await page.goto('/liquidity');
    await expect(page.locator('[data-chart="liquidity"]')).toBeVisible({ timeout: 60_000 });
    await noSeriousAxeViolations(page);
    // Keyboard: the layer toggles are reachable and switch with Space.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await tabTo(page, (el) => el.id === 'layer-swing');
    await page.keyboard.press('Space');
    await expect(page.locator('#layer-swing')).not.toBeChecked();

    await page.goto('/setups');
    await expect(page.getByRole('heading', { name: 'Setup Scanner', level: 1 })).toBeVisible();
    await noSeriousAxeViolations(page);
    await tabTo(page, (el) => el.id === 'scanner-sort');
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/sort=score/);
    const setups = (
      (await (await request.get('/api/v1/setups?limit=1', { headers })).json()) as { items: Setup[] }
    ).items;
    if (setups.length) {
      await tabTo(page, (el) => /^Show the checklist/.test(el.label));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-checklist] [data-item]').first()).toBeVisible();
      await page.goto(`/setups/${setups[0]!.id}`);
      await expect(page.locator('[data-setup]')).toBeVisible();
      await noSeriousAxeViolations(page);
      await tabTo(page, (el) => el.id === 'calc-risk');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('0.5');
      await expect(page.locator('#calc-risk')).toHaveValue('0.5');
    }

    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Economic Calendar', level: 1 })).toBeVisible();
    await noSeriousAxeViolations(page);
    await tabTo(page, (el) => el.id === 'calendar-impact');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#calendar-impact')).not.toHaveValue('');
  });
});
