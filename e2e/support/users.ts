/** Development seed users (apps/api/src/cli.ts `seed-dev`); the password comes from DEV_SEED_PASSWORD. */
export const DEV_PASSWORD = process.env.DEV_SEED_PASSWORD ?? 'local-dev-password';
export const VIEWER = 'viewer@cip.test';
export const ANALYST = 'analyst@cip.test';
export const ADMIN = 'admin@cip.test';
