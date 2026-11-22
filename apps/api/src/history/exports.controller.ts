import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  EXPORT_AUDIT_ACTION,
  type ExportKind,
  type Instrument,
  OUTCOME_RESULTS,
  type RunComparisonExportQuery,
  RunComparisonExportQuerySchema,
  SESSION_BUCKETS,
  SETUP_EXPORT_MAX_ROWS,
  type SetupExportQuery,
  SetupExportQuerySchema,
  type SetupSide,
  type SetupStatsQuery,
  SetupStatsQuerySchema,
  type SetupStatsRow,
  type StatsKey,
} from '@cip/contracts';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { ComparisonService } from './comparison.service.js';
import { type CsvValue, isoOrNull, toCsv } from './csv.js';
import { StatsRepository } from './stats.repository.js';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const json = (x: unknown) => (x === null || x === undefined ? '' : JSON.stringify(x));

/** The statistics' columns after the group's own (SetupStatsRow). */
const COUNT_COLUMNS = [
  'detected',
  'found_while_warming_up',
  'confirmed',
  'open',
  'resolved',
  'entry_touched',
  ...OUTCOME_RESULTS,
  'avg_mfe_r',
  'avg_mae_r',
] as const;

const counts = (r: SetupStatsRow): CsvValue[] => [
  r.detected,
  r.warmup,
  r.confirmed,
  r.open,
  r.resolved,
  r.entered,
  ...OUTCOME_RESULTS.map((o) => r.outcomes[o]),
  r.avgMfeR,
  r.avgMaeR,
];

/**
 * CSV exports (Phase 12, ADR 026): the outcome statistics, the setups behind them, and a replay's
 * comparison with another run. Each is written as it is asked for, and audited
 * (`export.downloaded`, architecture §14). File names say "historical-observations" (criterion 12.2).
 */
@Controller('exports')
@Access('dashboards.view')
export class ExportsController {
  constructor(
    private readonly stats: StatsRepository,
    private readonly comparisons: ComparisonService,
    private readonly market: MarketRepository,
    private readonly audit: AuditService,
  ) {}

  private async names(): Promise<Map<string, Instrument>> {
    return new Map((await this.market.instruments({ includeDisabled: true })).map((i) => [i.id, i]));
  }

  private async checkFilter(q: {
    instrumentId?: string | undefined;
    runId?: string | undefined;
  }): Promise<void> {
    if (q.instrumentId) await this.market.requireInstrument(q.instrumentId);
    if (q.runId && !(await this.comparisons.run(q.runId)))
      throw new ProblemError('NOT_FOUND', 'No such run.');
  }

  private async send(
    req: ApiRequest,
    res: Response,
    kind: ExportKind,
    file: string,
    csv: string,
    details: Record<string, unknown>,
  ): Promise<string> {
    await this.audit.record({
      actorType: 'user',
      actorUserId: req.user!.id,
      action: EXPORT_AUDIT_ACTION,
      targetType: 'export',
      targetId: kind,
      ip: clientIp(req),
      userAgent: userAgent(req),
      details: { export: kind, file, ...details },
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${file}"`);
    res.setHeader('cache-control', 'no-store');
    return csv;
  }

  /** The statistics as the page shows them: one line per group, then `all` for every group together. */
  @Get('setup-stats.csv')
  async setupStats(
    @Query(new ZodPipe(SetupStatsQuerySchema)) q: SetupStatsQuery,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    await this.checkFilter(q);
    const [stats, names] = await Promise.all([this.stats.stats(q), this.names()]);
    const keyColumns = q.groupBy.flatMap((d) =>
      d === 'tfPair'
        ? ['context_tf', 'setup_tf']
        : d === 'rules'
          ? ['rules_version', 'profile', 'params_hash', 'changed_settings']
          : [d],
    );
    const keyValues = (k: StatsKey): CsvValue[] =>
      q.groupBy.flatMap((d): CsvValue[] => {
        switch (d) {
          case 'pattern':
            return [k.pattern];
          case 'variant':
            return [k.variant ?? ''];
          case 'direction':
            return [k.direction];
          case 'tfPair':
            return [k.tfPair?.context, k.tfPair?.setup];
          case 'instrument': {
            const i = k.instrumentId ? names.get(k.instrumentId) : undefined;
            return [i ? `${i.venue}:${i.venueSymbol}` : k.instrumentId];
          }
          case 'session':
            return [k.session];
          case 'rules':
            return [
              k.rules?.rulesetVersion,
              k.rules ? `${k.rules.profile.name} v${k.rules.profile.version}` : '',
              k.rules?.paramsHash,
              k.rules?.changedSettings,
            ];
        }
      });
    const header = ['group', ...keyColumns, ...COUNT_COLUMNS];
    const lines: CsvValue[][] = [
      ...stats.rows.map((r) => ['group', ...keyValues(r.key), ...counts(r)]),
      ['all', ...keyColumns.map(() => ''), ...counts(stats.totals)],
    ];
    const file = `setup-statistics-historical-observations-${day(Date.now())}.csv`;
    return this.send(req, res, 'setup-stats', file, toCsv(header, lines), {
      query: q,
      rows: stats.rows.length,
    });
  }

  /** One line per setup the statistics count, oldest first, with its outcome. */
  @Get('setups.csv')
  async setups(
    @Query(new ZodPipe(SetupExportQuerySchema)) q: SetupExportQuery,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    await this.checkFilter(q);
    const n = await this.stats.countSetups(q);
    if (n > SETUP_EXPORT_MAX_ROWS)
      throw new ProblemError(
        'VALIDATION_FAILED',
        `That is ${n} setups; an export holds at most ${SETUP_EXPORT_MAX_ROWS}. Narrow the period or the filters.`,
      );
    const rows = await this.stats.setups(q);
    const header = [
      'setup_id',
      'run_id',
      'run_mode',
      'venue',
      'symbol',
      'pattern',
      'variant',
      'direction',
      'context_tf',
      'setup_tf',
      'session',
      'found',
      'rules_version',
      'profile',
      'params_hash',
      'changed_settings',
      'created_at',
      'state',
      'resolution',
      'confirmed',
      'result',
      'entry_touched_at',
      'resolved_at',
      'mfe_r',
      'mae_r',
      'bars_held',
      'resolved_with_tf',
      'score',
      'mandatory_passed',
      'entry',
      'invalidation',
      'target1',
      'rr_target1',
      'quality_flags',
    ];
    const lines = rows.map((r): CsvValue[] => [
      r.id,
      r.run_id,
      r.run_mode,
      r.venue_id,
      r.venue_symbol,
      r.pattern,
      r.variant,
      r.direction,
      r.context_tf,
      r.setup_tf,
      SESSION_BUCKETS.includes(r.session) ? r.session : 'outside',
      r.warmup ? 'while_warming_up' : 'live',
      r.ruleset_version,
      `${r.profile_name} v${r.profile_version}`,
      r.params_hash,
      r.changed,
      isoOrNull(r.created_candle_time.getTime()),
      r.state,
      r.resolution,
      r.confirmed,
      r.result,
      isoOrNull(r.entry_touched_at?.getTime()),
      isoOrNull(r.resolved_at?.getTime()),
      r.mfe_r,
      r.mae_r,
      r.bars_held,
      r.resolved_with_tf,
      Number(r.confluence_score),
      r.mandatory_passed,
      r.entry_price,
      r.invalidation_price,
      r.target1_price,
      r.rr_target1,
      r.quality_flags.join(' '),
    ]);
    const file = `setups-historical-observations-${day(Date.now())}.csv`;
    return this.send(req, res, 'setups', file, toCsv(header, lines), { query: q, rows: rows.length });
  }

  /**
   * A replay compared with the live run it started from (or the run `compareWith` names): the two
   * runs, the settings that differ, the events per type, and every setup that differs.
   */
  @Get('run-comparison.csv')
  async runComparison(
    @Query(new ZodPipe(RunComparisonExportQuerySchema)) q: RunComparisonExportQuery,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const other = await this.comparisons.run(q.runId);
    if (!other || other.mode !== 'replay') throw new ProblemError('NOT_FOUND', 'No such replay.');
    if (other.status !== 'completed') throw new ProblemError('CONFLICT', 'The replay has not completed yet.');
    const baseId = q.compareWith ?? other.source_run_id;
    if (!baseId)
      throw new ProblemError(
        'VALIDATION_FAILED',
        'No live run covered the replay: name a run to compare with.',
      );
    if (baseId === other.id)
      throw new ProblemError('VALIDATION_FAILED', 'Compare a replay with another run.');
    const base = await this.comparisons.run(baseId);
    if (!base) throw new ProblemError('NOT_FOUND', 'No such run to compare with.');
    const c = await this.comparisons.compare(base, other);
    const setups = await this.comparisons.setupDifferences(base, other, c.from, c.to, null);
    const side = (s: SetupSide | null) =>
      s ? `${s.state}${s.resolution ? ` (${s.resolution})` : ''}, score ${s.score}` : 'not found';
    const lines: CsvValue[][] = [
      ['run', 'run_id', c.base.runId, c.other.runId],
      ['run', 'mode', c.base.mode, c.other.mode],
      [
        'run',
        'profile',
        `${c.base.profile.name} v${c.base.profile.version}`,
        `${c.other.profile.name} v${c.other.profile.version}`,
      ],
      ['run', 'rules_version', c.base.rulesetVersion, c.other.rulesetVersion],
      ['run', 'changed_settings', json(c.base.settings), json(c.other.settings)],
      ['run', 'period_from', isoOrNull(c.from), isoOrNull(c.from)],
      ['run', 'period_to', isoOrNull(c.to), isoOrNull(c.to)],
      ['run', 'digest', c.base.digest, c.other.digest],
      ['run', 'events', c.base.events, c.other.events],
      ['run', 'digests_equal', c.equal, c.equal],
      ...c.settings.map((s): CsvValue[] => ['setting', s.path, json(s.base), json(s.other)]),
      ...c.eventTypes.map((t): CsvValue[] => ['events', t.type, t.base, t.other]),
      ['events', 'only_in_one_run', c.onlyInBase, c.onlyInOther],
      ['events', 'same_event_different_contents', c.changed, c.changed],
      ...setups.map((s): CsvValue[] => [
        'setup',
        `${s.pattern}${s.variant ? ` ${s.variant}` : ''} ${s.direction} ${s.contextTf}/${s.setupTf} ${isoOrNull(s.createdAt)}`,
        side(s.base),
        side(s.other),
      ]),
    ];
    const file = `replay-comparison-${other.id}.csv`;
    return this.send(req, res, 'run-comparison', file, toCsv(['section', 'item', 'base', 'other'], lines), {
      runId: other.id,
      compareWith: base.id,
      rows: lines.length,
    });
  }
}
