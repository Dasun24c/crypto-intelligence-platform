#!/usr/bin/env node
import { createDb } from '@cip/db';
import { BinanceVenue, CoinbaseVenue } from '@cip/exchange-adapters';
import { createLogger, INSTANCE_ID } from '@cip/observability';
import { checkConsistency, previousDay } from './consistency.js';
import { loadJobsConfig } from './config.js';

/**
 * `cip-jobs consistency [YYYY-MM-DD]`  compare a UTC day's stored candles with the venues' REST
 * candles (default: yesterday) and print the report; exit 2 when anything differs.
 */
async function main(command: string | undefined, arg: string | undefined): Promise<number> {
  const config = loadJobsConfig();
  const log = createLogger({ service: 'jobs', instance: INSTANCE_ID, level: config.LOG_LEVEL });
  if (command !== 'consistency') {
    log.error({ command }, 'usage: cip-jobs consistency [YYYY-MM-DD]');
    return 64;
  }
  const range = arg
    ? { from: Date.parse(`${arg}T00:00:00Z`), to: Date.parse(`${arg}T00:00:00Z`) + 86_400_000 }
    : previousDay(Date.now());
  if (Number.isNaN(range.from)) {
    log.error({ arg }, 'the day must be YYYY-MM-DD');
    return 64;
  }
  const db = createDb({ connectionString: config.DATABASE_URL, max: 2, applicationName: 'cip-jobs-cli' });
  const hooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };
  try {
    const report = await checkConsistency(
      { db, log, venues: { binance: new BinanceVenue(hooks), coinbase: new CoinbaseVenue(hooks) } },
      range,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 2;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main(process.argv[2], process.argv[3]);
