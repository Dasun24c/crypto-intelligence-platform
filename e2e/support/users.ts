/**
 * The tests' own development seed users (apps/api/src/cli.ts `seed-dev`), never the ones people use:
 * the specs reset practice balances, switch automatic trading, make alert rules and use up sign-in
 * attempts. The password comes from DEV_SEED_PASSWORD.
 */
export const DEV_PASSWORD = process.env.DEV_SEED_PASSWORD ?? 'local-dev-password';
export const VIEWER = 'e2e-viewer@cip.test';
export const ANALYST = 'e2e-analyst@cip.test';
export const ADMIN = 'e2e-admin@cip.test';
