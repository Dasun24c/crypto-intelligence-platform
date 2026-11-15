import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb } from './client.js';
import { migrateToLatest } from './migrator.js';
import { configureServiceRoles, SERVICE_ROLES, type ServiceRole } from './roles.js';

/** Same image as production (feasibility §7.2). */
export const TIMESCALE_IMAGE = 'timescale/timescaledb:2.31.0-pg18';

export interface TestDatabase {
  ownerUrl: string;
  /** Connection string for a service role (password set by the migration step). */
  roleUrls: Record<ServiceRole, string>;
  stop(): Promise<void>;
}

/**
 * Starts TimescaleDB in a throwaway container, applies every migration and enables the service roles,
 * exactly as `cip-db migrate` does in a deployment. Used by integration tests (architecture §19).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(TIMESCALE_IMAGE)
    .withDatabase('cip')
    .withUsername('cip_owner')
    .withPassword(randomBytes(12).toString('hex'))
    .start();
  const ownerUrl = container.getConnectionUri();
  const passwords = Object.fromEntries(
    SERVICE_ROLES.map((r) => [r, randomBytes(16).toString('hex')]),
  ) as Record<ServiceRole, string>;

  const db = createDb({ connectionString: ownerUrl, max: 1 });
  try {
    const { error } = await migrateToLatest(db);
    if (error) throw error instanceof Error ? error : new Error('migration failed', { cause: error });
    await configureServiceRoles(db, passwords);
  } finally {
    await db.destroy();
  }

  const roleUrls = Object.fromEntries(
    SERVICE_ROLES.map((role) => {
      const url = new URL(ownerUrl);
      url.username = role;
      url.password = passwords[role];
      return [role, url.toString()];
    }),
  ) as Record<ServiceRole, string>;

  return { ownerUrl, roleUrls, stop: async () => void (await container.stop()) };
}
