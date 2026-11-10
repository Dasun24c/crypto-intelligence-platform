import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { DEV_PASSWORD, VIEWER } from '../support/users.ts';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('the sign-in page has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => v.id)).toEqual([]);
});

test('a wrong password is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('E-mail').fill(VIEWER);
  await page.getByLabel('Password').fill('definitely not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-in failed');
});

test('a viewer signs in, sees every service healthy, keeps the session on reload and signs out', async ({
  page,
}) => {
  await signIn(page, VIEWER);
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
  await expect(page.getByText('No market data is connected yet')).toBeVisible();

  await page.getByRole('link', { name: 'System Health' }).click();
  await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
  for (const service of ['api', 'ingestor', 'analyzer', 'jobs']) {
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: service, exact: true }) });
    await expect(row.getByText('OK')).toBeVisible({ timeout: 30_000 });
  }

  // A full reload resumes the session from the httpOnly refresh cookie.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();

  // Viewers do not get admin pages, in the menu or by URL.
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
