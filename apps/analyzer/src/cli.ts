#!/usr/bin/env node
import { v7 as uuidv7 } from 'uuid';
import { type ReplaySettings, ReplaySettingsSchema } from '@cip/contracts';
import { createDb } from '@cip/db';
import { createLogger, INSTANCE_ID } from '@cip/observability';
import { AnalysisRepository } from './analysis/repository.js';
import { runReplay } from './analysis/replay.js';
import { SmcStore } from './analysis/smc-store.js';
import { loadAnalyzerConfig } from './config.js';

/**
 * `cip-analyzer replay <instrumentId> <from> <to>`: replay a stored period in this process (as the
 * `replay` queue would) and print its digest beside the live run's over the same period (criterion
 * 4.3); exit 2 when they differ.
 *
 * `cip-analyzer digest <runId> <from> <to>`: a run's digest over (from, to].
 *
 * Times are ISO 8601 (`2026-11-11T00:00:00Z`) or epoch milliseconds. A replay can change settings
 * for itself (Phase 12) with a JSON object as its last argument, e.g. `'{"minRR":3}'`.
 */
const USAGE =
  "usage: cip-analyzer replay <instrumentId> <from> <to> ['<settings JSON>'] | digest <runId> <from> <to>";

const time = (s: string | undefined): number => (s && /^\d+$/.test(s) ? Number(s) : Date.parse(s ?? ''));

/** The optional settings argument; undefined when it is not valid. */
function settingsArg(s: string | undefined): ReplaySettings | null | undefined {
  if (s === undefined) return null;
  try {
    const parsed = ReplaySettingsSchema.safeParse(JSON.parse(s));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const config = loadAnalyzerConfig();
  const log = createLogger({ service: 'analyzer', instance: INSTANCE_ID, level: config.LOG_LEVEL });
  const [command, id, a, b, extra] = argv;
  const from = time(a);
  const to = time(b);
  const settings = command === 'replay' ? settingsArg(extra) : null;
  if (
    (command !== 'replay' && command !== 'digest') ||
    !id ||
    Number.isNaN(from) ||
    Number.isNaN(to) ||
    to <= from ||
    settings === undefined ||
    (command === 'digest' && extra !== undefined)
  ) {
    log.error({ argv }, USAGE);
    return 64;
  }
  const db = createDb({ connectionString: config.DATABASE_URL, max: 2, applicationName: 'cip-analyzer-cli' });
  const store = new SmcStore(db);
  try {
    if (command === 'digest') {
      process.stdout.write(
        `${JSON.stringify({ runId: id, from, to, ...(await store.digest(id, from, to)) }, null, 2)}\n`,
      );
      return 0;
    }
    if (to > Date.now()) {
      log.error({ to: new Date(to) }, 'a replay ends in the past: its candles must be stored');
      return 64;
    }
    const repo = new AnalysisRepository(db);
    const runId = uuidv7();
    let result;
    try {
      result = await runReplay(
        { repo, store, log },
        { runId, instrumentId: id, from, to, requestedBy: null, settings },
      );
    } catch (err) {
      // As the queue's worker does: the run is not left "running".
      await repo.finishReplay(runId, 'failed', null).catch(() => undefined);
      throw err;
    }
    const live = result.liveRunId ? await store.digest(result.liveRunId, from, to) : null;
    const report = {
      ...result,
      from,
      to,
      settings,
      live: live && { runId: result.liveRunId, ...live },
      equal: live ? live.digest === result.digest && live.events === result.events : null,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // With changed settings a difference is what was asked for, not a determinism failure.
    return report.equal === false && !settings ? 2 : 0;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main(process.argv.slice(2));
