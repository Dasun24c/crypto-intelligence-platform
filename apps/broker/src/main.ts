import { Redis } from 'ioredis';
import { createDb, createPool, pingDb } from '@cip/db';
import { checkDependencies, ConfigError, INSTANCE_ID, runService } from '@cip/observability';
import { Broker } from './broker.js';
import { loadBrokerConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadBrokerConfig();
  await runService('broker', config, async ({ log, redis, meter }) => {
    const pool = createPool({ connectionString: config.DATABASE_URL, max: 4, applicationName: 'cip-broker' });
    const db = createDb({ pool });
    // Blocking stream reads get their own connection, so heartbeats and writes never wait behind them.
    const reader = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-broker-reader',
    });
    const broker = new Broker({ db, redis, reader, log, meter, instance: INSTANCE_ID });
    await broker.start();
    return {
      probe: () => broker.probe(),
      readiness: () => checkDependencies({ database: () => pingDb(pool), redis: () => redis.ping() }),
      stop: async () => {
        await broker.stop();
        reader.disconnect();
        await pool.end();
      },
    };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `broker failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
