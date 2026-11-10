import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { freshTotp } from '../support/totp.ts';
import { ADMIN, DEV_PASSWORD } from '../support/users.ts';

// The seeded admin's TOTP secret, kept between local runs (gitignored). A fresh stack enrols again.
const SECRET_FILE = new URL('../.auth/admin-totp.txt', import.meta.url);

test('an admin must use TOTP, then manages users and verifies the audit chain', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(ADMIN);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  let secret: string;
  const setUp = page.getByRole('button', { name: 'Set up authenticator' });
  const codeField = page.getByLabel(/code/i);
  await expect(setUp.or(codeField)).toBeVisible();
  if (await setUp.isVisible()) {
    await setUp.click();
    secret = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
    mkdirSync(new URL('.', SECRET_FILE), { recursive: true });
    writeFileSync(SECRET_FILE, secret);
  } else {
    secret = readFileSync(SECRET_FILE, 'utf8').trim();
  }
  await page.getByLabel(/code/i).fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();

  // Create a user; the change is audited.
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'New user' }).click();
  const email = `e2e-${Date.now()}@cip.test`;
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Display name').fill('E2E Person');
  await page.getByLabel('Initial password').fill('an e2e initial passphrase');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText(email)).toBeVisible();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('cell', { name: 'user.created' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'auth.login.succeeded' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText('Hash chain intact')).toBeVisible();
});
