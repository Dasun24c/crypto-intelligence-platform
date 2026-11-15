import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { DEV_PASSWORD, VIEWER } from '../support/users.ts';

/**
 * Criterion 3.5, second part: a script that confirms the indicator values shown in the UI equal the
 * API's. Technical Analysis puts every value of the latest closed candle in a `data-value` attribute
 * exactly as the API sent it (JSON: a number, a string, a boolean or null), next to
 * `data-indicator="<field>"`, with the candle's open time in the table's `data-t`. This compares each
 * one with `GET /indicators/{id}?tf&limit=1` for the same candle: numbers as numbers, nulls as nulls.
 */

/** Every value of an IndicatorPoint (packages/contracts/src/analysis.ts): the page must show them all. */
const FIELDS = [
  'rsi',
  'macd',
  'macdSignal',
  'macdHist',
  'emaFast',
  'emaMid',
  'emaSlow',
  'vwap',
  'atr',
  'volumeZ',
  'volumeAnomaly',
  'trend',
  'trendStrength',
] as const;
type Field = (typeof FIELDS)[number];
type Value = number | boolean | string | null;

/** The parts of the API's shapes this test reads (the e2e project does not import @cip/contracts). */
type ApiPoint = Record<Field, Value> & { t: number; warmup: boolean };
interface ApiSeries {
  instrumentId: string;
  tf: string;
  run: { id: string; status: string } | null;
  points: ApiPoint[];
}
interface ApiRun {
  instrumentId: string;
  mode: 'live' | 'replay';
  status: string;
}

/** What the page shows for the latest closed candle, read in one go. */
interface Shown {
  t: number;
  tf: string | null;
  run: string | null;
  warmup: string | null;
  cells: { field: string; value: string; text: string }[];
}

/** On the CI replay stack the first indicator points appear a minute or two after start. */
const FIRST_POINT_MS = 180_000;
/** 1m candles appear first: the replay venue has no history, so longer timeframes take hours. */
const TF = '1m';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** An access token from the login endpoint (a web login answers TokenResponse; the cookie is unused). */
async function accessToken(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password: DEV_PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { accessToken?: string; mfaRequired?: boolean };
  expect(body.mfaRequired, 'the viewer signs in without a second factor').toBeUndefined();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken!;
}

function readShown(table: Locator): Promise<Shown> {
  return table.evaluate((el) => ({
    t: Number(el.getAttribute('data-t')),
    tf: el.getAttribute('data-tf'),
    run: el.getAttribute('data-run'),
    warmup: el.getAttribute('data-warmup'),
    cells: [...el.querySelectorAll('[data-indicator]')].map((cell) => ({
      field: cell.getAttribute('data-indicator') ?? '',
      value: cell.getAttribute('data-value') ?? '',
      text: cell.textContent ?? '',
    })),
  }));
}

test('Technical Analysis shows exactly the indicator values the API returns', async ({ page, request }) => {
  test.setTimeout(FIRST_POINT_MS + 120_000);
  const token = await accessToken(request, VIEWER);
  const headers = { authorization: `Bearer ${token}` };

  // An instrument with an open live run (the analyzer opens one per analysed instrument on start).
  let instrumentId = '';
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/v1/system/runs?limit=100', { headers });
        if (!res.ok()) return '';
        const open = ((await res.json()) as ApiRun[]).filter(
          (r) => r.mode === 'live' && (r.status === 'running' || r.status === 'warming_up'),
        );
        instrumentId = (open.find((r) => r.status === 'running') ?? open[0])?.instrumentId ?? '';
        return instrumentId;
      },
      {
        message: 'an instrument with an open analysis run',
        timeout: FIRST_POINT_MS,
        intervals: [2_000, 5_000],
      },
    )
    .not.toBe('');

  await signIn(page, VIEWER);
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
  await page.getByRole('link', { name: 'Technical Analysis', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Technical Analysis', level: 1 })).toBeVisible();
  await page.getByLabel('Instrument', { exact: true }).selectOption(instrumentId);
  await page.getByLabel('Timeframe', { exact: true }).selectOption(TF);
  await expect(page).toHaveURL(new RegExp(`[?&]instrument=${instrumentId}(&|$)`));
  await expect(page).toHaveURL(new RegExp(`[?&]tf=${TF}(&|$)`));

  // Wait for the first closed candle's values (live, or from REST on load).
  const table = page.getByRole('table', { name: 'Indicator values of the latest closed candle' });
  await expect(table).toHaveAttribute('data-t', /^\d+$/, { timeout: FIRST_POINT_MS });
  await expect(table).toHaveAttribute('data-instrument', instrumentId);
  const tf = await page.getByLabel('Timeframe', { exact: true }).inputValue();
  expect(tf).toBe(TF);

  // A candle can close between reading the page and asking the API, so the page and the API's
  // latest point are read together until they are about the same candle: the page receives each
  // new point within about a second of the API storing it.
  const read: { pair?: { shown: Shown; series: ApiSeries; api: ApiPoint } } = {};
  await expect
    .poll(
      async () => {
        const shown = await readShown(table);
        const res = await request.get(`/api/v1/indicators/${instrumentId}?tf=${tf}&limit=1`, { headers });
        if (!res.ok()) return `API answered ${res.status()}`;
        const series = (await res.json()) as ApiSeries;
        const api = series.points.at(-1);
        if (!api) return 'the API has no point yet';
        read.pair = { shown, series, api };
        return api.t === shown.t ? 'same candle' : `page at ${shown.t}, API at ${api.t}`;
      },
      {
        message: 'the page shows the latest point the API has',
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toBe('same candle');

  const { shown, series, api } = read.pair!;
  expect(series.instrumentId).toBe(instrumentId);
  expect(series.tf).toBe(tf);
  expect(shown.tf).toBe(tf);
  expect(shown.run, 'the run the values come from').toBe(series.run?.id ?? null);
  expect(shown.warmup).toBe(String(api.warmup));
  // Every indicator is shown, once.
  expect(shown.cells.map((c) => c.field).sort()).toEqual([...FIELDS].sort());
  for (const cell of shown.cells) {
    const field = cell.field as Field;
    const value = JSON.parse(cell.value) as Value;
    // toBe is Object.is: a number must be the same number (not a string of it), null must be null.
    expect.soft(value, `${field} of the candle at ${shown.t}`).toBe(api[field]);
    // A dash is shown exactly where the API has no value (warm-up).
    expect.soft(cell.text.includes('—'), `${field} shown as missing`).toBe(api[field] === null);
  }

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
