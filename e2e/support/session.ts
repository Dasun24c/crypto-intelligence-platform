import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  type APIResponse,
  type Browser,
  expect,
  type Page,
  type Response,
} from '@playwright/test';
import { freshTotp } from './totp.ts';
import { ADMIN, DEV_PASSWORD } from './users.ts';

/**
 * Sign-ins are limited to 5 a minute per address and per account (a token bucket refilling one every
 * 12 s: `LIMITS.login` in apps/api/src/common/rate-limiter.ts). The specs sign in often, and where
 * they run fast (CI's replay stack) more than 5 fall within a minute. A refused attempt (429) waits
 * as long as its Retry-After says and tries again, rather than failing the test; the limit itself
 * is left as it is.
 */
const LOGIN_PATIENCE_MS = 120_000;
const LOGIN_PATH = '/api/v1/auth/login';

/** How long a 429 asks to wait (its Retry-After, in seconds), and a little more. */
function retryAfterMs(headers: Record<string, string>): number {
  const seconds = Number(headers['retry-after']);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 12_000) + 250;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `POST /auth/login`, waiting out the login limit; the answer is returned whatever it is. */
export async function login(
  request: APIRequestContext,
  email: string,
  password = DEV_PASSWORD,
): Promise<APIResponse> {
  const deadline = Date.now() + LOGIN_PATIENCE_MS;
  for (;;) {
    const res = await request.post(LOGIN_PATH, { data: { email, password } });
    if (res.status() !== 429 || Date.now() >= deadline) return res;
    await sleep(retryAfterMs(res.headers()));
  }
}

/**
 * Presses "Sign in" on the sign-in page (filled in already), waiting out the login limit; returns
 * the API's answer to the last attempt.
 */
export async function submitSignIn(page: Page): Promise<Response> {
  const deadline = Date.now() + LOGIN_PATIENCE_MS;
  for (;;) {
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === LOGIN_PATH,
      ),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    if (res.status() !== 429 || Date.now() >= deadline) return res;
    await page.waitForTimeout(retryAfterMs(res.headers()));
  }
}

/** Signs a seeded user without a second factor in through the UI. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await submitSignIn(page);
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
}

// The test admin's TOTP secret, kept between local runs (gitignored); a fresh stack enrols again.
const SECRET_FILE = new URL('../.auth/e2e-admin-totp.txt', import.meta.url);

/**
 * Signs the seeded admin in with TOTP, enrolling on a fresh stack. A code is refused if the same
 * time step was used before (another spec may have just signed in), so a refusal waits for the next.
 */
export async function signInAdmin(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(ADMIN);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await submitSignIn(page);
  const setUp = page.getByRole('button', { name: 'Set up authenticator' });
  const codeField = page.getByLabel(/code/i);
  await expect(setUp.or(codeField)).toBeVisible();
  let secret: string;
  if (await setUp.isVisible()) {
    await setUp.click();
    secret = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
    mkdirSync(new URL('.', SECRET_FILE), { recursive: true });
    writeFileSync(SECRET_FILE, secret);
  } else {
    secret = readFileSync(SECRET_FILE, 'utf8').trim();
  }
  const home = page.getByRole('heading', { name: 'Command Center' });
  let last: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await freshTotp(secret, last);
    await page.getByLabel(/code/i).fill(last);
    await page.getByRole('button', { name: 'Verify' }).click();
    try {
      // `waitFor` waits (isVisible would not): signed in, or the code was refused.
      await home.waitFor({ state: 'visible', timeout: 8_000 });
      return;
    } catch {
      // A code from a time step already used: try the next step's.
    }
  }
  await expect(home).toBeVisible();
}

/**
 * The seeded admin's access token through the API (password, then TOTP), for admin calls a test
 * makes beside the page. The admin must have enrolled already (admin.spec.ts does on a fresh stack).
 */
export async function adminAccessToken(request: APIRequestContext): Promise<Record<string, string>> {
  const signedIn = await login(request, ADMIN);
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  const { mfaToken } = (await signedIn.json()) as { mfaToken?: string };
  expect(typeof mfaToken).toBe('string');
  const secret = readFileSync(SECRET_FILE, 'utf8').trim();
  const deadline = Date.now() + LOGIN_PATIENCE_MS;
  // The last code the API checked: a code from a time step already used is refused, the next is not.
  let used: string | undefined;
  for (let attempt = 0; attempt < 3;) {
    const code = await freshTotp(secret, used);
    const res = await request.post('/api/v1/auth/mfa', { data: { mfaToken, code } });
    if (res.ok())
      return { authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
    // The second factor shares the limit: a 429 checked no code, so the same one may be tried again.
    if (res.status() === 429 && Date.now() < deadline) {
      await sleep(retryAfterMs(res.headers()));
      continue;
    }
    used = code;
    attempt++;
  }
  throw new Error('the admin could not complete the second factor');
}

/** Enrols the test admin's authenticator through the sign-in page, unless a run has already. */
export async function ensureTestAdmin(browser: Browser, baseURL: string | undefined): Promise<void> {
  if (existsSync(SECRET_FILE)) return;
  const ctx = await browser.newContext(baseURL ? { baseURL } : {});
  try {
    await signInAdmin(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}

/** The signed-in user's id. */
export async function userIdOf(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get('/api/v1/me', { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const SWITCHES = new Set([
  'practice_auto.switched_on',
  'practice_auto.switched_off',
  'practice_auto.stopped',
]);

/**
 * Accounts other than `ownUserId` whose automatic practice trading is on, read from the audit log as
 * an admin: each account's latest switch (newest first). A confirmed setup a spec appends to
 * `an:events` would make any of them trade too (ADR 022), so such a spec does not run then.
 */
export async function othersTradingAutomatically(
  request: APIRequestContext,
  admin: Record<string, string>,
  ownUserId: string,
): Promise<string[]> {
  const latest = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const query: string = `action=practice_auto.&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await request.get(`/api/v1/admin/audit?${query}`, { headers: admin });
    expect(res.status(), await res.text()).toBe(200);
    const page = (await res.json()) as {
      items: { actorUserId: string | null; action: string }[];
      nextCursor: string | null;
    };
    for (const e of page.items)
      if (e.actorUserId && SWITCHES.has(e.action) && !latest.has(e.actorUserId))
        latest.set(e.actorUserId, e.action);
    cursor = page.nextCursor;
  } while (cursor);
  return [...latest]
    .filter(([id, action]) => id !== ownUserId && action === 'practice_auto.switched_on')
    .map(([id]) => id);
}

/** An access token from the login endpoint, for reading the API alongside the page. */
export async function accessToken(
  request: APIRequestContext,
  email: string,
): Promise<Record<string, string>> {
  const res = await login(request, email);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  return { authorization: `Bearer ${body.accessToken}` };
}
