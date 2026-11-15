#!/usr/bin/env node
import { createDb } from '@cip/db';
import { createLogger, INSTANCE_ID } from '@cip/observability';
import { type JournalEntry, type JournalInput, replayJournal } from '@cip/paper-engine';
import { fillId, nameId } from './broker.js';
import { loadBrokerConfig } from './config.js';
import { BrokerStore } from './store.js';

/**
 * `cip-broker replay [--since <journal seq>]`: replays the practice journal (criteria 14.3 and 16.6),
 * read-only. Each engine run starts at a `load` entry (a broker taking the lease, or reloading); it is
 * fed to a fresh engine and auto-trader with the rules and fees it journalled, and every fill's and
 * every automatic decision's digest line is compared with what was stored. Prints one line per run;
 * exits 2 when any run differs.
 *
 * Runs journalled before the broker recorded its configuration replay with today's rules and fees,
 * and differ if those changed since.
 */
const USAGE = 'usage: cip-broker replay [--since <journal seq>]';

async function main(argv: string[]): Promise<number> {
  const config = loadBrokerConfig();
  const log = createLogger({ service: 'broker', instance: INSTANCE_ID, level: config.LOG_LEVEL });
  const [command, flag, value] = argv;
  const since = flag === '--since' ? Number(value) : 0;
  if (command !== 'replay' || (flag !== undefined && (flag !== '--since' || !Number.isInteger(since)))) {
    log.error({ argv }, USAGE);
    return 64;
  }
  const db = createDb({ connectionString: config.DATABASE_URL, max: 2, applicationName: 'cip-broker-cli' });
  try {
    const store = new BrokerStore(db);
    const [instruments, settings] = await Promise.all([store.instruments(), store.settings()]);
    const rules = new Map(instruments.filter((i) => i.role === 'monitored').map((i) => [i.instrumentId, i]));
    const opts = {
      rules: (id: string) => rules.get(id),
      fees: (venue: string) =>
        settings.fees[venue as keyof typeof settings.fees] ?? { maker: '0', taker: '0' },
      fillId,
      nameId,
    };
    const rows = await db
      .selectFrom('trading.journal')
      .select(['seq', 'kind', 'input', 'fills', 'decisions'])
      .where('seq', '>=', String(since))
      .orderBy('seq')
      .execute();
    const runs: { from: string; entries: JournalEntry[]; seqs: string[] }[] = [];
    for (const r of rows) {
      const entry = { input: r.input as unknown as JournalInput, fills: r.fills, decisions: r.decisions };
      if (r.kind === 'load') runs.push({ from: r.seq, entries: [entry], seqs: [r.seq] });
      else if (runs.length) {
        runs.at(-1)!.entries.push(entry);
        runs.at(-1)!.seqs.push(r.seq);
      }
    }
    let differ = 0;
    for (const run of runs) {
      const result = replayJournal(run.entries, opts);
      const fills = run.entries.reduce((n, e) => n + e.fills.length, 0);
      const decisions = run.entries.reduce(
        (n, e) => n + (e.decisions ?? []).filter((l) => l.startsWith('decision|')).length,
        0,
      );
      const configured = run.entries.some((e) => e.input.config !== undefined);
      const line = {
        fromSeq: run.from,
        entries: run.entries.length,
        fills,
        decisions,
        configuration: configured ? 'journalled' : "today's",
        result: result.mismatchAt === null ? 'identical' : `differs at seq ${run.seqs[result.mismatchAt]}`,
      };
      if (result.mismatchAt !== null) differ++;
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
    process.stdout.write(
      `${runs.length} run(s), ${rows.length} journal entries: ${differ === 0 ? 'every fill and decision identical' : `${differ} run(s) differ`}\n`,
    );
    return differ === 0 ? 0 : 2;
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`replay failed: ${String(err)}\n`);
    process.exit(1);
  });
