import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against a running stack (CI: `docker compose up --build --wait`, then `pnpm e2e`).
 * They use the development seed users, which exist only when the stack's migrate step runs with
 * NODE_ENV=development (compose.dev.yaml).
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
