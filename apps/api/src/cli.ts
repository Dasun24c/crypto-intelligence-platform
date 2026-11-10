import { parseArgs } from 'node:util';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { EmailSchema, PasswordSchema, type Role } from '@cip/contracts';
import { createDb } from '@cip/db';
import { createLogger, INSTANCE_ID, loadEnv, NodeEnvSchema } from '@cip/observability';
import { AuditService } from './audit/audit.service.js';
import { PasswordService } from './auth/password.service.js';
import { UsersRepository } from './users/users.repository.js';

/**
 * Operator commands, run with the api image:
 *   cli create-admin --email <e-mail> --name <name>   password from CIP_ADMIN_PASSWORD(_FILE)
 *   cli seed-dev                                      development only: one user per role
 * New admins enrol TOTP at their first sign-in.
 */
const EnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  DATABASE_URL: z.url(),
  CIP_ADMIN_PASSWORD: z.string().optional(),
  DEV_SEED_PASSWORD: z.string().default('local-dev-password'),
});

const DEV_USERS: { email: string; name: string; role: Role }[] = [
  { email: 'admin@cip.test', name: 'Dev Admin', role: 'admin' },
  { email: 'analyst@cip.test', name: 'Dev Analyst', role: 'analyst' },
  { email: 'viewer@cip.test', name: 'Dev Viewer', role: 'viewer' },
];

async function main(): Promise<number> {
  const env = loadEnv(EnvSchema);
  const log = createLogger({ service: 'api-cli', instance: INSTANCE_ID });
  const db = createDb({ connectionString: env.DATABASE_URL, max: 1, applicationName: 'cip-api-cli' });
  const users = new UsersRepository(db);
  const audit = new AuditService(db);
  const passwords = new PasswordService();

  const createUser = async (email: string, name: string, role: Role, password: string, via: string) => {
    if (await users.findByEmail(email)) {
      log.info({ email }, 'user exists, unchanged');
      return;
    }
    const hash = await passwords.hash(password);
    await db.transaction().execute(async (trx) => {
      const row = await users.insert(
        { id: uuidv7(), email, display_name: name, role, password_hash: hash },
        trx,
      );
      await audit.record(
        {
          actorType: 'system',
          action: 'user.created',
          targetType: 'user',
          targetId: row.id,
          details: { email, role, via },
        },
        trx,
      );
    });
    log.info({ email, role }, 'user created');
  };

  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'create-admin') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, name: { type: 'string' } },
      });
      const email = EmailSchema.parse(values.email);
      const password = PasswordSchema.parse(env.CIP_ADMIN_PASSWORD);
      await createUser(email, values.name ?? 'Administrator', 'admin', password, 'cli');
      return 0;
    }
    if (command === 'seed-dev') {
      if (env.NODE_ENV !== 'development') {
        log.error('seed-dev only runs with NODE_ENV=development');
        return 1;
      }
      for (const u of DEV_USERS) await createUser(u.email, u.name, u.role, env.DEV_SEED_PASSWORD, 'seed-dev');
      return 0;
    }
    log.error({ command }, 'usage: cli create-admin --email <e-mail> --name <name> | seed-dev');
    return 64;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main();
