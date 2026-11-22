import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { dbQuery, sqlLiteral } from '../support/db.ts';
import { accessToken, adminAccessToken, ensureTestAdmin, signIn, userIdOf } from '../support/session.ts';
import { LIVE_ONLY, REPLAY_STACK } from '../support/stack.ts';
import { ANALYST, VIEWER } from '../support/users.ts';

/**
 * Phase 12 (historical analytics and the replay UI, ADR 026), against a running stack:
 * - 12.1: the statistics the page shows are the API's, and the API's reconcile with direct queries
 *   of the stack's database (`docker compose exec db psql`, read-only), for every dimension;
 * - 12.2: the labels say "historical observations" and nothing implies expected performance;
 * - 12.3 (live stack only: replays need stored history the replay venue lacks): a replay started from
 *   the page matches the live run's digest, and one with changed settings lists them.
 * The tests sign in as the e2e accounts only; replays never publish detections, so nobody's
 * automatic practice trading sees them.
 */

const OUTCOMES = ['target_reached', 'invalidated', 'expired_no_entry', 'expired_open', 'ambiguous'] as const;
const DIMENSIONS = ['pattern', 'variant', 'direction', 'tfPair', 'instrument', 'session', 'rules'] as const;
type Dimension = (typeof DIMENSIONS)[number];

interface Numbers {
  detected: number;
  warmup: number;
  confirmed: number;
  open: number;
  resolved: number;
  entered: number;
  outcomes: Record<(typeof OUTCOMES)[number], number>;
  avgMfeR: number | null;
  avgMaeR: number | null;
}
interface StatsRow extends Numbers {
  key: {
    pattern?: string;
    variant?: string | null;
    direction?: string;
    tfPair?: { context: string; setup: string };
    instrumentId?: string;
    session?: string;
    rules?: { rulesetVersion: string; profile: { name: string; version: number }; paramsHash: string };
  };
}
interface Stats {
  label: string;
  notice: string;
  groupBy: Dimension[];
  from: number | null;
  to: number | null;
  totals: StatsRow;
  rows: StatsRow[];
}
interface Fact {
  pattern: string;
  variant: string | null;
  direction: string;
  tf_pair: string;
  instrument_id: string;
  session: string;
  rules: string;
  warmup: boolean;
  confirmed: boolean;
  result: string | null;
  entered: boolean;
  mfe_r: number | null;
  mae_r: number | null;
}
interface Comparison {
  base: { runId: string; mode: string; digest: string; events: number };
  other: { runId: string; digest: string; events: number };
  equal: boolean;
  incomplete: boolean;
  settings: { path: string; base: unknown; other: unknown }[];
  onlyInBase: number;
  onlyInOther: number;
  changed: number;
}

/** Words that would present history as a promise or a measure of performance (criterion 12.2). */
const IMPLIES_PERFORMANCE =
  /win ?rate|success rate|hit rate|accura|profitab|expected|expectancy|probabilit|chance of|\bedge\b|guarantee|predict|will (reach|hit|win|work)/i;

/**
 * Every setup the live runs started in (from, to], with what the statistics need, computed from
 * the tables here and not by the API's query: the newer of two live runs under the same rules
 * wins (NOT EXISTS rather than DISTINCT ON), and the session comes from the UTC hour (both launch
 * profiles use the default session hours, which the test checks first).
 */
function facts(from: number, to: number): Fact[] {
  const f = sqlLiteral(from);
  const t = sqlLiteral(to);
  return dbQuery<Fact>(`
    WITH s AS (
      SELECT s.id, s.instrument_id, s.pattern, s.variant, s.direction, s.context_tf, s.setup_tf, s.state,
             s.created_candle_time, r.from_time, r.started_at, r.ruleset_version, r.params_hash,
             p.name AS profile_name, p.version AS profile_version
      FROM analysis.setups s
      JOIN analysis.detection_runs r ON r.id = s.run_id AND r.mode = 'live'
      JOIN market.instrument_profiles p ON p.id = r.profile_id
      WHERE s.created_candle_time > to_timestamp(${f} / 1000.0)
        AND s.created_candle_time <= to_timestamp(${t} / 1000.0)
    ),
    c AS (
      SELECT * FROM s WHERE NOT EXISTS (
        SELECT 1 FROM s n
        WHERE n.instrument_id = s.instrument_id AND n.ruleset_version = s.ruleset_version
          AND n.params_hash = s.params_hash AND n.pattern = s.pattern AND n.direction = s.direction
          AND n.context_tf = s.context_tf AND n.setup_tf = s.setup_tf
          AND n.created_candle_time = s.created_candle_time AND n.started_at > s.started_at)
    )
    SELECT c.pattern, c.variant, c.direction, c.context_tf || '/' || c.setup_tf AS tf_pair, c.instrument_id,
           CASE WHEN x.h < 7 THEN 'asia' WHEN x.h < 13 THEN 'london' WHEN x.h < 21 THEN 'new_york'
                ELSE 'outside' END AS session,
           c.ruleset_version || '|' || c.profile_name || '|' || c.profile_version || '|' || c.params_hash AS rules,
           c.created_candle_time <= c.from_time AS warmup,
           (o.setup_id IS NOT NULL OR c.state IN ('confirmed', 'entry_active')) AS confirmed,
           o.result, o.entry_touched_at IS NOT NULL AS entered, o.mfe_r, o.mae_r
    FROM c
    LEFT JOIN analysis.setup_outcomes o ON o.setup_id = c.id
    CROSS JOIN LATERAL (
      SELECT extract(hour FROM (c.created_candle_time - interval '1 millisecond') AT TIME ZONE 'UTC')::int AS h
    ) x`);
}

const factKey = (f: Fact, d: Dimension): string =>
  String(
    {
      pattern: f.pattern,
      variant: f.variant ?? '',
      direction: f.direction,
      tfPair: f.tf_pair,
      instrument: f.instrument_id,
      session: f.session,
      rules: f.rules,
    }[d],
  );

const rowKey = (r: StatsRow, d: Dimension): string => {
  const k = r.key;
  return String(
    {
      pattern: k.pattern,
      variant: k.variant ?? '',
      direction: k.direction,
      tfPair: k.tfPair ? `${k.tfPair.context}/${k.tfPair.setup}` : '',
      instrument: k.instrumentId,
      session: k.session,
      rules: k.rules
        ? `${k.rules.rulesetVersion}|${k.rules.profile.name}|${k.rules.profile.version}|${k.rules.paramsHash}`
        : '',
    }[d],
  );
};

const round = (x: number | null) => (x === null ? null : Number(x.toFixed(9)));

function summarise(fs: Fact[]): Numbers {
  const resolved = fs.filter((f) => f.result !== null);
  const withMfe = resolved.filter((f) => f.mfe_r !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    detected: fs.length,
    warmup: fs.filter((f) => f.warmup).length,
    confirmed: fs.filter((f) => f.confirmed).length,
    open: fs.filter((f) => f.confirmed && f.result === null).length,
    resolved: resolved.length,
    entered: resolved.filter((f) => f.entered).length,
    outcomes: Object.fromEntries(
      OUTCOMES.map((o) => [o, resolved.filter((f) => f.result === o).length]),
    ) as Numbers['outcomes'],
    avgMfeR: round(mean(withMfe.map((f) => f.mfe_r!))),
    avgMaeR: round(mean(withMfe.map((f) => f.mae_r!))),
  };
}

const numbers = (r: Numbers): Numbers => ({
  detected: r.detected,
  warmup: r.warmup,
  confirmed: r.confirmed,
  open: r.open,
  resolved: r.resolved,
  entered: r.entered,
  outcomes: r.outcomes,
  avgMfeR: round(r.avgMfeR),
  avgMaeR: round(r.avgMaeR),
});

test.describe('Phase 12', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(5 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let headers: Record<string, string>;
  let baseURL: string | undefined;

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    headers = await accessToken(api, VIEWER);
    ctx = await browser.newContext({ baseURL, acceptDownloads: true });
    page = await ctx.newPage();
    await signIn(page, VIEWER);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await ctx?.close();
  });

  /** The API's statistics against the database's, for one dimension; live data may move between the two reads. */
  async function reconcile(d: Dimension, from: number, to: number): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await api.get(`/api/v1/setups/stats?groupBy=${d}&from=${from}&to=${to}`, { headers });
      expect(res.status(), await res.text()).toBe(200);
      const stats = (await res.json()) as Stats;
      const all = facts(from, to);
      try {
        expect(numbers(stats.totals), `${d}: every group`).toEqual(summarise(all));
        const groups = new Map<string, Fact[]>();
        for (const f of all) groups.set(factKey(f, d), [...(groups.get(factKey(f, d)) ?? []), f]);
        expect(stats.rows.map((r) => rowKey(r, d)).sort(), `${d}: the groups`).toEqual(
          [...groups.keys()].sort(),
        );
        for (const r of stats.rows)
          expect(numbers(r), `${d} = ${rowKey(r, d)}`).toEqual(summarise(groups.get(rowKey(r, d)) ?? []));
        return stats.rows.length;
      } catch (err) {
        // A setup resolved, or a new outcome was stored, between the two reads: read both again.
        lastError = err;
        await page.waitForTimeout(3_000);
      }
    }
    throw lastError;
  }

  test("12.1 the statistics shown are the database's, for every dimension", async () => {
    // Both launch profiles keep the default session hours, which the direct query assumes.
    const sessions = dbQuery<{ name: string; version: number; sessions: unknown }>(
      `SELECT name, version, params -> 'smc' -> 'sessions' AS sessions FROM market.instrument_profiles WHERE id IN (SELECT profile_id FROM analysis.detection_runs WHERE mode = 'live')`,
    );
    for (const s of sessions)
      expect(s.sessions, `${s.name} v${s.version}`).toEqual([
        { end: '07:00', name: 'asia', start: '00:00' },
        { end: '13:00', name: 'london', start: '07:00' },
        { end: '21:00', name: 'new_york', start: '13:00' },
      ]);

    const response = page.waitForResponse((r) => r.url().includes('/api/v1/setups/stats'));
    await page.goto('/history');
    await expect(page.getByRole('heading', { name: 'Historical Analytics', level: 1 })).toBeVisible();
    const res = await response;
    expect(res.status()).toBe(200);
    const shown = (await res.json()) as Stats;
    const q = new URL(res.url()).searchParams;
    expect(q.get('groupBy')).toBe('pattern');
    const from = Number(q.get('from'));
    const to = Number(q.get('to'));
    expect(to - from).toBe(30 * 86_400_000);

    // The page shows the response: one row per group, with its numbers, and the totals.
    if (shown.totals.detected > 0) {
      await expect(page.locator('[data-stats-row]')).toHaveCount(shown.rows.length);
      for (const r of shown.rows) {
        const row = page.locator(`[data-stats-row="${r.key.pattern}"]`);
        await expect(row).toHaveAttribute('data-detected', String(r.detected));
        await expect(row).toHaveAttribute('data-confirmed', String(r.confirmed));
        await expect(row).toHaveAttribute('data-resolved', String(r.resolved));
        await expect(row).toHaveAttribute('data-target-reached', String(r.outcomes.target_reached));
        await expect(row).toHaveAttribute('data-invalidated', String(r.outcomes.invalidated));
      }
      await expect(page.locator('[data-stats-totals]')).toHaveAttribute(
        'data-detected',
        String(shown.totals.detected),
      );
    } else {
      await expect(page.getByText('No setup started forming in this period.')).toBeVisible();
    }

    // The API reconciles with the database over the same period, for every dimension.
    const groups: Record<string, number> = {};
    for (const d of DIMENSIONS) groups[d] = await reconcile(d, from, to);
    testInfo().annotations.push({
      type: '12.1',
      description: `groups per dimension: ${JSON.stringify(groups)}`,
    });
  });

  test('12.2 the labels say historical observations and never imply expected performance', async () => {
    await page.goto('/history');
    await expect(page.getByRole('heading', { name: 'Historical Analytics', level: 1 })).toBeVisible();
    const notice = page.getByRole('status').filter({ hasText: 'Historical observations' }).first();
    await expect(notice).toContainText('They describe the past only and are not a forecast');
    await expect(page.locator('main')).not.toContainText(IMPLIES_PERFORMANCE);
    const statsScan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(statsScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    // The CSV file says it too, and the download is audited.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Statistics (CSV)' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(
      /^setup-statistics-historical-observations-\d{4}-\d\d-\d\d\.csv$/,
    );
    await ensureTestAdmin(page.context().browser()!, baseURL);
    const admin = await adminAccessToken(api);
    const viewerId = await userIdOf(api, headers);
    const audit = await api.get(`/api/v1/admin/audit?action=export.downloaded&actor=${viewerId}&limit=5`, {
      headers: admin,
    });
    expect(audit.status(), await audit.text()).toBe(200);
    const entries = ((await audit.json()) as { items: { action: string; details: { export?: string } }[] })
      .items;
    expect(entries[0]).toMatchObject({ action: 'export.downloaded', details: { export: 'setup-stats' } });

    await page.getByRole('tab', { name: 'Replays' }).click();
    await expect(page.getByRole('tab', { name: 'Replays' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Replays' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText(IMPLIES_PERFORMANCE);
    const replayScan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(replayScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
      [],
    );
  });

  test('12.3 a replay from the page matches the live digest; changed settings are listed', async ({
    browser,
  }) => {
    test.skip(REPLAY_STACK, LIVE_ONLY);
    test.setTimeout(20 * 60_000);
    const analystCtx = await browser.newContext({ baseURL, acceptDownloads: true });
    try {
      const analyst = await analystCtx.newPage();
      await signIn(analyst, ANALYST);
      const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as {
        id: string;
        venue: string;
        venueSymbol: string;
      }[];
      const btc = instruments.find((i) => i.venue === 'binance' && i.venueSymbol === 'BTCUSDT')!;
      await analyst.goto('/history?tab=replays');
      const form = analyst.getByRole('form', { name: 'Start a replay' });
      await expect(form).toBeVisible();
      await form.getByLabel('Instrument').selectOption(btc.id);

      /** Starts the replay the form describes and waits for it to complete; its status. */
      async function run(): Promise<{ runId: string; comparison: Comparison; from: number; to: number }> {
        const posted = analyst.waitForResponse(
          (r) => r.url().endsWith('/api/v1/replays') && r.request().method() === 'POST',
        );
        await form.getByRole('button', { name: 'Start replay' }).click();
        const res = await posted;
        expect(res.status(), await res.text()).toBe(202);
        const { runId } = (await res.json()) as { runId: string };
        const detail = analyst.locator(`[data-replay-detail="${runId}"]`);
        await expect(detail).toHaveAttribute('data-status', 'completed', { timeout: 15 * 60_000 });
        const status = await api.get(`/api/v1/replays/${runId}`, { headers });
        expect(status.status()).toBe(200);
        const body = (await status.json()) as { comparison: Comparison; from: number; to: number };
        expect(body.comparison, 'a live run covers the period').not.toBeNull();
        expect(body.comparison.incomplete).toBe(false);
        return { runId, ...body };
      }

      // Unchanged: the replay decides exactly what the live run decided over the period.
      const same = await run();
      expect(same.comparison).toMatchObject({
        equal: true,
        settings: [],
        onlyInBase: 0,
        onlyInOther: 0,
        changed: 0,
      });
      expect(same.comparison.base.mode).toBe('live');
      expect(same.comparison.other.digest).toBe(same.comparison.base.digest);
      expect(same.comparison.other.events).toBe(same.comparison.base.events);
      const sameView = analyst.locator(`[data-replay-detail="${same.runId}"] [data-comparison]`);
      await expect(sameView).toHaveAttribute('data-equal', 'true');
      await expect(sameView).toContainText('Matches the live run');
      await expect(sameView.locator('[data-run-side="base"]')).toHaveAttribute(
        'data-digest',
        same.comparison.base.digest,
      );
      await expect(sameView.locator('[data-run-side="other"]')).toHaveAttribute(
        'data-digest',
        same.comparison.other.digest,
      );
      testInfo().annotations.push({
        type: '12.3 unchanged',
        description: `${same.runId}: ${same.comparison.base.events} events, digest ${same.comparison.base.digest}`,
      });

      // Changed: a higher minimum reward-to-risk and without pattern 4; the differences are listed.
      await form.getByText(/Change settings for this replay/).click();
      const minRR = form.getByLabel('Minimum reward-to-risk');
      await expect(minRR).toHaveValue('2');
      await minRR.fill('3');
      await form.getByRole('checkbox', { name: 'P4 · Sweep outside, fill inside' }).uncheck();
      await expect(form.locator('[data-replay-changes]')).toContainText('Minimum reward-to-risk (item 7): 3');
      const changed = await run();
      expect(changed.comparison.settings).toEqual([
        {
          path: 'smc.setups.checklist.minRR',
          base: 2,
          other: 3,
        },
        {
          path: 'smc.setups.patterns',
          base: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
          other: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block'],
        },
      ]);
      const view = analyst.locator(`[data-replay-detail="${changed.runId}"] [data-comparison]`);
      await expect(view).toContainText('Settings differ from the live run');
      await expect(view.locator('[data-setting-path="smc.setups.checklist.minRR"]')).toContainText('2');
      await expect(view.locator('[data-setting-path="smc.setups.checklist.minRR"]')).toContainText('3');
      await expect(view.locator('[data-setting-path="smc.setups.patterns"]')).toContainText('P1, P2, P3, P4');
      // Pattern 4 setups the live run decided in the period are not in the replay: they differ.
      const p4 = dbQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM analysis.detection_events WHERE run_id = ${sqlLiteral(changed.comparison.base.runId)}
           AND type = 'setup_transition' AND payload -> 'data' ->> 'pattern' = 'sweep_outside_fill_inside'
           AND candle_time > to_timestamp(${sqlLiteral(changed.from)} / 1000.0) AND candle_time <= to_timestamp(${sqlLiteral(changed.to)} / 1000.0)`,
      )[0]!.n;
      const differences =
        changed.comparison.onlyInBase + changed.comparison.onlyInOther + changed.comparison.changed;
      if (p4 > 0) {
        expect(changed.comparison.equal).toBe(false);
        expect(changed.comparison.onlyInBase).toBeGreaterThanOrEqual(p4);
      }
      await expect(view.locator('[data-differences]')).toHaveAttribute(
        'data-differences',
        String(differences),
      );
      testInfo().annotations.push({
        type: '12.3 changed',
        description: `${changed.runId}: ${differences} detections differ (${p4} pattern 4 transitions in the live run)`,
      });

      // The comparison exports as CSV, with the changed settings.
      const download = analyst.waitForEvent('download');
      await view.getByRole('button', { name: 'Comparison (CSV)' }).click();
      const csv = await download;
      expect(csv.suggestedFilename()).toBe(`replay-comparison-${changed.runId}.csv`);
      const text = await (await csv.createReadStream()).toArray();
      expect(Buffer.concat(text).toString('utf8')).toContain('setting,smc.setups.checklist.minRR,2,3');
    } finally {
      await analystCtx.close();
    }
  });
});

const testInfo = () => test.info();
