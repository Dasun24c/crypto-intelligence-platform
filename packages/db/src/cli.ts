#!/usr/bin/env node
import { z } from 'zod';
import { createLogger, INSTANCE_ID, loadEnv } from '@cip/observability';
import { createDb } from './client.js';
import { verifyAuditChain } from './audit.js';
import { migrateToLatest } from './migrator.js';
import { configureServiceRoles } from './roles.js';

/**
 * `cip-db migrate`      apply pending migrations as the owner role, then set service-role passwords
 * `cip-db verify-audit` walk the audit hash chain and exit non-zero if it is broken
 */
const EnvSchema = z.object({
  /** Owner credentials: used for migrations only, never by a running service. */
  DATABASE_OWNER_URL: z.url(),
  DB_PASSWORD_SVC_API: z.string().optional(),
  DB_PASSWORD_SVC_INGESTOR: z.string().optional(),
  DB_PASSWORD_SVC_ANALYZER: z.string().optional(),
  DB_PASSWORD_SVC_JOBS: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

async function main(command: string | undefined): Promise<number> {
  const env = loadEnv(EnvSchema);
  const log = createLogger({ service: 'db', instance: INSTANCE_ID, level: env.LOG_LEVEL });
  const db = createDb({ connectionString: env.DATABASE_OWNER_URL, max: 1, applicationName: 'cip-db' });
  try {
    switch (command) {
      case 'migrate': {
        const { applied, error } = await migrateToLatest(db);
        for (const name of applied) log.info({ migration: name }, 'applied');
        if (error) {
          log.error({ err: error }, 'migration failed');
          return 1;
        }
        const roles = await configureServiceRoles(db, {
          svc_api: env.DB_PASSWORD_SVC_API,
          svc_ingestor: env.DB_PASSWORD_SVC_INGESTOR,
          svc_analyzer: env.DB_PASSWORD_SVC_ANALYZER,
          svc_jobs: env.DB_PASSWORD_SVC_JOBS,
        });
        log.info({ applied: applied.length, loginRoles: roles }, 'database is up to date');
        return 0;
      }
      case 'verify-audit': {
        const result = await verifyAuditChain(db);
        log[result.ok ? 'info' : 'error'](result, result.ok ? 'audit chain verified' : 'audit chain BROKEN');
        return result.ok ? 0 : 2;
      }
      default:
        log.error({ command }, 'usage: cip-db migrate | verify-audit');
        return 64;
    }
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main(process.argv[2]);
