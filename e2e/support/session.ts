import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { freshTotp } from './totp.ts';
import { ADMIN, DEV_PASSWORD } from './users.ts';

/** Signs a seeded user without a second factor in through the UI. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
}

// The seeded admin's TOTP secret, kept between local runs (gitignored); a fresh stack enrols again.
const SECRET_FILE = new URL('../.auth/admin-totp.txt', import.meta.url);

/**
 * Signs the seeded admin in with TOTP, enrolling on a fresh stack. A code is refused if the same
 * time step was used before (another spec may have just signed in), so a refusal waits for the next.
 */
export async function signInAdmin(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(ADMIN);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
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

/** An access token from the login endpoint, for reading the API alongside the page. */
export async function accessToken(
  request: APIRequestContext,
  email: string,
): Promise<Record<string, string>> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password: DEV_PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  return { authorization: `Bearer ${body.accessToken}` };
}
