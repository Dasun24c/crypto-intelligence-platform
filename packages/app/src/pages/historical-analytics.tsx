import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import {
  can,
  CHECKLIST_ITEM_NAMES,
  type DetectionRun,
  FOUND_FILTERS,
  type FoundFilter,
  HISTORICAL_NOTICE,
  HISTORICAL_OBSERVATIONS,
  type Instrument,
  OUTCOME_RESULTS,
  PATTERN_NAMES,
  type ReplayBaseSettings,
  type ReplaySettingValues,
  type ReplayStatus,
  type ReplaySummary,
  type RunComparison,
  SETUP_DIFFERENCES_SHOWN,
  type SetupStats,
  type SetupStatsRow,
  STATS_DIMENSIONS,
  type StatsDimension,
} from '@cip/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  Spinner,
  StatusBadge,
  type StatusTone,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { useInstruments } from '../api/queries.js';
import { formatAge, formatInstant } from '../lib/format.js';
import {
  changedSettings,
  comparisonVerdict,
  countAndShare,
  DIMENSION_LABELS,
  fewObservations,
  FOUND_LABELS,
  formatR,
  fromUtcInput,
  keyText,
  OUTCOME_LABELS,
  rowId,
  saveFile,
  settingLabel,
  settingsSummary,
  settingValue,
  sideText,
  STATS_PERIODS,
  type StatsPeriod,
  toUtcInput,
} from '../lib/history.js';
import { type HistorySearch, readHistorySearch } from '../lib/search.js';
import { CHECKLIST_LABELS, PATTERN_SHORT, PATTERN_TITLE } from '../lib/setups.js';
import { useCurrentUser, useDisplayTimeZone, useNow, useSession } from '../session.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** The replay list and an unfinished replay are read again this often. */
const POLL_MS = 3_000;

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-fg-muted">{children}</p>;
}

function useHistorySearch(): [HistorySearch, (next: HistorySearch) => void] {
  const search = readHistorySearch(useSearch({ strict: false }) as unknown);
  const navigate = useNavigate();
  return [search, (next) => void navigate({ to: '/history', search: next })];
}

/** Downloads one of the CSV exports, saying so if the server refuses it. */
function DownloadButton({
  path,
  label,
  fallbackName,
}: {
  path: string;
  label: string;
  fallbackName: string;
}) {
  const { client } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await client.file(path);
      saveFile(blob, filename ?? fallbackName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" variant="secondary" size="sm" onClick={() => void download()} disabled={busy}>
        <Download className="size-4" aria-hidden />
        {label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-crit">
          {error}
        </span>
      ) : null}
    </span>
  );
}

// ── Outcome statistics ──────────────────────────────────────────────────────────────────────────

function StatsTable({
  stats,
  instrumentName,
}: {
  stats: SetupStats;
  instrumentName: (id: string) => string;
}) {
  const dims = stats.groupBy;
  const numbers = (r: SetupStatsRow) => (
    <>
      <Td className="text-right tabular-nums">{r.detected}</Td>
      <Td className="text-right tabular-nums">{r.warmup}</Td>
      <Td className="text-right tabular-nums">{r.confirmed}</Td>
      <Td className="text-right tabular-nums">{r.open}</Td>
      <Td className="text-right tabular-nums">{r.resolved}</Td>
      {OUTCOME_RESULTS.map((o) => (
        <Td key={o} className="text-right tabular-nums" data-outcome={o}>
          {countAndShare(r.outcomes[o], r.resolved)}
        </Td>
      ))}
      <Td className="text-right tabular-nums">{formatR(r.avgMfeR)}</Td>
      <Td className="text-right tabular-nums">{formatR(r.avgMaeR)}</Td>
    </>
  );
  const attrs = (r: SetupStatsRow) => ({
    'data-detected': r.detected,
    'data-warmup': r.warmup,
    'data-confirmed': r.confirmed,
    'data-open': r.open,
    'data-resolved': r.resolved,
    'data-entered': r.entered,
    'data-target-reached': r.outcomes.target_reached,
    'data-invalidated': r.outcomes.invalidated,
    'data-expired-no-entry': r.outcomes.expired_no_entry,
    'data-expired-open': r.outcomes.expired_open,
    'data-ambiguous': r.outcomes.ambiguous,
    'data-avg-mfe-r': r.avgMfeR ?? '',
    'data-avg-mae-r': r.avgMaeR ?? '',
  });
  return (
    <Table>
      <caption className="sr-only">
        {HISTORICAL_OBSERVATIONS}: setups by {dims.map((d) => DIMENSION_LABELS[d].toLowerCase()).join(', ')}
      </caption>
      <thead>
        <tr>
          {dims.map((d) => (
            <Th key={d}>{DIMENSION_LABELS[d]}</Th>
          ))}
          <Th className="text-right">Detected</Th>
          <Th className="text-right">Found on history</Th>
          <Th className="text-right">Confirmed</Th>
          <Th className="text-right">Open</Th>
          <Th className="text-right">Resolved</Th>
          {OUTCOME_RESULTS.map((o) => (
            <Th key={o} className="text-right">
              {OUTCOME_LABELS[o]}
            </Th>
          ))}
          <Th className="text-right">Avg MFE (R)</Th>
          <Th className="text-right">Avg MAE (R)</Th>
        </tr>
      </thead>
      <tbody>
        {stats.rows.map((r) => (
          <tr key={rowId(r.key, dims)} data-stats-row={rowId(r.key, dims)} {...attrs(r)}>
            {dims.map((d, i) => (
              <Td key={d} className="whitespace-nowrap">
                {keyText(r.key, d, instrumentName)}
                {i === 0 && fewObservations(r) ? (
                  <Badge
                    tone="neutral"
                    className="ml-2"
                    title="Fewer than 20 resolved setups: the shares say little"
                  >
                    few observations
                  </Badge>
                ) : null}
              </Td>
            ))}
            {numbers(r)}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-stats-totals="" {...attrs(stats.totals)} className="border-t border-border font-medium">
          <Td colSpan={dims.length}>All groups</Td>
          {numbers(stats.totals)}
        </tr>
      </tfoot>
    </Table>
  );
}

function StatsTab({ search, setSearch }: { search: HistorySearch; setSearch: (s: HistorySearch) => void }) {
  const { client } = useSession();
  const instruments = useInstruments();
  const timeZone = useDisplayTimeZone();
  const [groupBy, setGroupBy] = useState<StatsDimension[]>(['pattern']);
  const [period, setPeriod] = useState<StatsPeriod>('30d');
  const [instrumentId, setInstrumentId] = useState('');
  const [found, setFound] = useState<FoundFilter>('all');
  const runId = search.run;
  const names = useMemo(
    () => new Map<string, Instrument>((instruments.data ?? []).map((i) => [i.id, i])),
    [instruments.data],
  );
  const instrumentName = (id: string) => names.get(id)?.displayName ?? 'Unknown instrument';

  // The period ends at the start of the current minute, so the request and its CSV agree.
  const [asOf, setAsOf] = useState(() => Math.floor(Date.now() / MINUTE) * MINUTE);
  const ms = STATS_PERIODS.find((p) => p.id === period)!.ms;
  const query = new URLSearchParams({ groupBy: groupBy.join(','), found });
  if (ms !== null) {
    query.set('from', String(asOf - ms));
    query.set('to', String(asOf));
  }
  if (instrumentId) query.set('instrumentId', instrumentId);
  if (runId) query.set('runId', runId);
  const qs = query.toString();
  const stats = useQuery({
    queryKey: ['setup-stats', qs],
    queryFn: () => client.request<SetupStats>('GET', `/api/v1/setups/stats?${qs}`),
  });
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('groupBy');

  const toggle = (d: StatsDimension, on: boolean) =>
    setGroupBy((g) => {
      const next = on ? STATS_DIMENSIONS.filter((x) => x === d || g.includes(x)) : g.filter((x) => x !== d);
      return next.length ? next : g;
    });

  let body: ReactNode;
  if (stats.isPending) body = <Spinner label="Loading the statistics" />;
  else if (stats.isError)
    body = (
      <Alert tone="crit" title="The statistics could not be loaded">
        {stats.error.message}
      </Alert>
    );
  else if (stats.data.totals.detected === 0) body = <Empty>No setup started forming in this period.</Empty>;
  else body = <StatsTable stats={stats.data} instrumentName={instrumentName} />;

  return (
    <div className="space-y-6">
      <Alert tone="info" title={HISTORICAL_OBSERVATIONS}>
        <p>{HISTORICAL_NOTICE}</p>
        <p className="mt-1">
          Outcomes are those of the hypothetical levels the rules set (rulebook §8): only setups that
          confirmed have one. MFE and MAE are the largest move for and against a setup after its entry, in R
          (the distance from entry to invalidation).
        </p>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>What to show</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Group by</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {STATS_DIMENSIONS.map((d) => (
                <label key={d} className="inline-flex items-center gap-2 text-sm">
                  <Checkbox checked={groupBy.includes(d)} onChange={(e) => toggle(d, e.target.checked)} />
                  {DIMENSION_LABELS[d]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="stats-period">Setups that started forming</Label>
              <Select
                id="stats-period"
                value={period}
                onChange={(e) => {
                  setPeriod(e.target.value as StatsPeriod);
                  setAsOf(Math.floor(Date.now() / MINUTE) * MINUTE);
                }}
              >
                {STATS_PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="stats-instrument">Instrument</Label>
              <Select
                id="stats-instrument"
                value={instrumentId}
                onChange={(e) => setInstrumentId(e.target.value)}
              >
                <option value="">Every instrument</option>
                {(instruments.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="stats-found">Found</Label>
              <Select
                id="stats-found"
                value={found}
                onChange={(e) => setFound(e.target.value as FoundFilter)}
              >
                {FOUND_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {FOUND_LABELS[f]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-xs text-fg-muted">
            {runId ? (
              <>
                The setups of one replay run, not the live analysis.{' '}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setSearch({ tab: 'stats' })}
                >
                  Show the live analysis
                </button>
              </>
            ) : (
              <>
                From the live analysis of every instrument: setups it found on stored history while warming
                up, and setups it found live. A setup two runs under the same rules found counts once.
              </>
            )}{' '}
            {ms !== null ? `Up to ${formatInstant(asOf, timeZone)}.` : null}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Outcome statistics</CardTitle>
          <div className="flex flex-wrap gap-2">
            <DownloadButton
              path={`/api/v1/exports/setup-stats.csv?${qs}`}
              label="Statistics (CSV)"
              fallbackName="setup-statistics-historical-observations.csv"
            />
            <DownloadButton
              path={`/api/v1/exports/setups.csv?${exportQuery.toString()}`}
              label="Setups (CSV)"
              fallbackName="setups-historical-observations.csv"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">{body}</CardContent>
      </Card>
    </div>
  );
}

// ── Replays ─────────────────────────────────────────────────────────────────────────────────────

const STATUS: Record<ReplaySummary['status'], { tone: StatusTone; label: string }> = {
  queued: { tone: 'info', label: 'Queued' },
  warming_up: { tone: 'info', label: 'Running' },
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'ok', label: 'Completed' },
  failed: { tone: 'crit', label: 'Failed' },
};

/**
 * A number input that keeps what is typed (so it can be cleared and typed again) and reports each
 * value that parses; the settings it edits never hold a half-typed number.
 */
function NumberField({
  id,
  label,
  value,
  onValue,
  min,
  max,
  step = 1,
  integer = false,
}: {
  id: string;
  label: string;
  value: number;
  onValue: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
}) {
  const [text, setText] = useState(String(value));
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onValue(integer ? Math.round(n) : n);
        }}
      />
    </div>
  );
}

function StartReplay({ onStarted }: { onStarted: (runId: string) => void }) {
  const { client } = useSession();
  const instruments = useInstruments();
  const list = (instruments.data ?? []).filter((i) => i.enabled);
  const [instrumentId, setInstrumentId] = useState('');
  const chosen = instrumentId || list[0]?.id || '';
  // By default the six hours that ended ten minutes ago (the live run has analysed them).
  const [end] = useState(() => Math.floor((Date.now() - 10 * MINUTE) / MINUTE) * MINUTE);
  const [from, setFrom] = useState(() => toUtcInput(end - 6 * 3_600_000));
  const [to, setTo] = useState(() => toUtcInput(end));
  const base = useQuery({
    queryKey: ['replay-settings', chosen],
    queryFn: () =>
      client.request<ReplayBaseSettings>('GET', `/api/v1/replays/settings?instrumentId=${chosen}`),
    enabled: chosen !== '',
  });
  // The form starts from the instrument's settings, and starts again when another instrument is chosen.
  const baseKey = base.data
    ? `${base.data.instrumentId}|${base.data.profile.name}|${base.data.profile.version}`
    : '';
  const [edits, setEdits] = useState<{ key: string; values: ReplaySettingValues } | null>(null);
  const form = edits?.key === baseKey ? edits.values : (base.data?.settings ?? null);
  const changes = base.data && form ? changedSettings(base.data.settings, form) : null;
  const now = useNow(15_000);

  const start = useMutation({
    mutationFn: (body: object) => client.request<{ runId: string }>('POST', '/api/v1/replays', body),
    onSuccess: (r) => onStarted(r.runId),
  });
  const fromMs = fromUtcInput(from);
  const toMs = fromUtcInput(to);
  const problem =
    fromMs === null || toMs === null
      ? 'Enter a full date and time for the start and the end.'
      : toMs <= fromMs
        ? 'The end must be after the start.'
        : toMs > now
          ? 'A replay reads stored history: the end cannot be in the future.'
          : toMs - fromMs > 31 * DAY
            ? 'A replay covers at most 31 days.'
            : form && form.patterns.length === 0
              ? 'Keep at least one pattern.'
              : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !chosen) return;
    start.mutate({ instrumentId: chosen, from: fromMs, to: toMs, ...(changes ? { settings: changes } : {}) });
  };
  const set = <K extends keyof ReplaySettingValues>(k: K, v: ReplaySettingValues[K]) => {
    if (form) setEdits({ key: baseKey, values: { ...form, [k]: v } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a replay</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit} aria-label="Start a replay">
          <p className="text-sm text-fg-muted">
            Runs the analysis again over stored candles, with the same code as the live analysis. Unchanged,
            it must decide exactly what the live run decided; with changed settings, the comparison lists what
            differs. The live analysis is never changed.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="replay-instrument">Instrument</Label>
              <Select id="replay-instrument" value={chosen} onChange={(e) => setInstrumentId(e.target.value)}>
                {list.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="replay-from">From (UTC)</Label>
              <Input
                id="replay-from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="replay-to">To (UTC)</Label>
              <Input
                id="replay-to"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Change settings for this replay{changes ? ` (${Object.keys(changes).length} changed)` : ''}
            </summary>
            {base.isError ? (
              <p className="mt-3 text-sm text-crit">The instrument's settings could not be loaded.</p>
            ) : !form || !base.data ? (
              <Spinner label="Loading the instrument's settings" />
            ) : (
              <div key={baseKey} className="mt-3 space-y-4">
                <p className="text-xs text-fg-muted">
                  Starting from {base.data.profile.name} v{base.data.profile.version}, the instrument's
                  profile.
                </p>
                <fieldset>
                  <legend className="text-sm font-medium">Patterns</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {PATTERN_NAMES.map((p) => (
                      <label key={p} className="inline-flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={form.patterns.includes(p)}
                          onChange={(e) =>
                            set(
                              'patterns',
                              e.target.checked ? [...form.patterns, p] : form.patterns.filter((x) => x !== p),
                            )
                          }
                        />
                        {PATTERN_SHORT[p]} · {PATTERN_TITLE[p]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium">Mandatory checklist items</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {CHECKLIST_ITEM_NAMES.map((i) => (
                      <label key={i} className="inline-flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={form.mandatory.includes(i)}
                          onChange={(e) =>
                            set(
                              'mandatory',
                              e.target.checked
                                ? [...form.mandatory, i]
                                : form.mandatory.filter((x) => x !== i),
                            )
                          }
                        />
                        {CHECKLIST_LABELS[i]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-3">
                  <NumberField
                    id="replay-minrr"
                    label="Minimum reward-to-risk"
                    value={form.minRR}
                    min={0.1}
                    max={20}
                    step={0.1}
                    onValue={(v) => set('minRR', v)}
                  />
                  <NumberField
                    id="replay-entry"
                    label="Entry window (setup candles)"
                    value={form.entryExpiryBars}
                    min={1}
                    integer
                    onValue={(v) => set('entryExpiryBars', v)}
                  />
                  <NumberField
                    id="replay-hold"
                    label="Longest hold (setup candles)"
                    value={form.maxHoldBars}
                    min={1}
                    integer
                    onValue={(v) => set('maxHoldBars', v)}
                  />
                  <NumberField
                    id="replay-news-before"
                    label="News blackout before (minutes)"
                    value={form.newsBlackoutMin.before}
                    min={0}
                    max={1440}
                    integer
                    onValue={(v) => set('newsBlackoutMin', { ...form.newsBlackoutMin, before: v })}
                  />
                  <NumberField
                    id="replay-news-after"
                    label="News blackout after (minutes)"
                    value={form.newsBlackoutMin.after}
                    min={0}
                    max={1440}
                    integer
                    onValue={(v) => set('newsBlackoutMin', { ...form.newsBlackoutMin, after: v })}
                  />
                </div>
                <div className="flex flex-wrap gap-6">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.requireDisplacement}
                      onChange={(e) => set('requireDisplacement', e.target.checked)}
                    />
                    MSS needs displacement
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.blockConfirmOnLowLiquidity}
                      onChange={(e) => set('blockConfirmOnLowLiquidity', e.target.checked)}
                    />
                    Low liquidity blocks confirmation
                  </label>
                </div>
                <p className="text-xs text-fg-muted" data-replay-changes="">
                  {changes
                    ? `Changed: ${settingsSummary(changes)}`
                    : 'Nothing changed: the replay uses the live settings.'}
                </p>
              </div>
            )}
          </details>
          {problem ? <p className="text-sm text-fg-muted">{problem}</p> : null}
          {start.isError ? (
            <Alert tone="crit" title="The replay could not be started">
              {start.error instanceof ApiError || start.error instanceof Error ? start.error.message : null}
            </Alert>
          ) : null}
          <Button type="submit" disabled={!!problem || !chosen || start.isPending}>
            {start.isPending ? 'Starting…' : 'Start replay'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ComparisonView({
  replay,
  comparison: c,
  instrumentName,
}: {
  replay: ReplayStatus;
  comparison: RunComparison;
  instrumentName: string;
}) {
  const timeZone = useDisplayTimeZone();
  const verdict = comparisonVerdict(c);
  const baseLabel = c.base.mode === 'live' ? 'Live run' : 'Other replay';
  return (
    <div className="space-y-4" data-comparison="" data-equal={c.equal} data-incomplete={c.incomplete}>
      <Alert tone={verdict.tone} title={verdict.title}>
        {verdict.detail}
      </Alert>
      <p className="text-xs text-fg-muted">
        Compared over the decisions after {formatInstant(c.from, timeZone)}, up to{' '}
        {formatInstant(c.to, timeZone)}, for {instrumentName}.
      </p>
      <Table>
        <caption className="sr-only">The two runs compared</caption>
        <thead>
          <tr>
            <Th>Run</Th>
            <Th>Profile</Th>
            <Th>Rules version</Th>
            <Th className="text-right">Events</Th>
            <Th>Digest</Th>
          </tr>
        </thead>
        <tbody>
          {[
            { label: baseLabel, r: c.base },
            { label: 'This replay', r: c.other },
          ].map(({ label, r }) => (
            <tr key={label} data-run-side={label === 'This replay' ? 'other' : 'base'} data-digest={r.digest}>
              <Td>{label}</Td>
              <Td>
                {r.profile.name} v{r.profile.version}
              </Td>
              <Td>{r.rulesetVersion}</Td>
              <Td className="text-right tabular-nums">{r.events}</Td>
              <Td className="font-mono text-xs" title={r.digest}>
                {r.digest.slice(0, 16)}…
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {c.settings.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Settings that differ</h3>
          <Table>
            <caption className="sr-only">Settings that differ between the two runs</caption>
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th>{baseLabel}</Th>
                <Th>This replay</Th>
              </tr>
            </thead>
            <tbody>
              {c.settings.map((s) => (
                <tr key={s.path} data-setting-path={s.path}>
                  <Td>{settingLabel(s.path)}</Td>
                  <Td>{settingValue(s.path, s.base)}</Td>
                  <Td>{settingValue(s.path, s.other)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : (
        <p className="text-sm text-fg-muted">The two runs used the same rules version and settings.</p>
      )}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Detections in the period</h3>
        <p className="text-sm text-fg-muted" data-differences={c.onlyInBase + c.onlyInOther + c.changed}>
          Only in the {baseLabel.toLowerCase()}: {c.onlyInBase}. Only in this replay: {c.onlyInOther}. In
          both, with different details: {c.changed}.
          {!c.sameOrigins
            ? ' The runs started at different candles, so their events are numbered differently.'
            : ''}
        </p>
        <Table>
          <caption className="sr-only">Detections per type in each run</caption>
          <thead>
            <tr>
              <Th>Detection</Th>
              <Th className="text-right">{baseLabel}</Th>
              <Th className="text-right">This replay</Th>
            </tr>
          </thead>
          <tbody>
            {c.eventTypes.map((t) => (
              <tr key={t.type}>
                <Td>{t.type.replaceAll('_', ' ')}</Td>
                <Td className="text-right tabular-nums">{t.base}</Td>
                <Td className="text-right tabular-nums">{t.other}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      {c.setupsTotal > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Setups that differ ({c.setupsTotal})</h3>
          <Table>
            <caption className="sr-only">Setups whose transitions differ between the two runs</caption>
            <thead>
              <tr>
                <Th>Started forming</Th>
                <Th>Pattern</Th>
                <Th>Direction</Th>
                <Th>Timeframes</Th>
                <Th>{baseLabel}</Th>
                <Th>This replay</Th>
              </tr>
            </thead>
            <tbody>
              {c.setups.map((s) => (
                <tr key={s.key} data-setup-difference={s.key}>
                  <Td className="whitespace-nowrap">{formatInstant(s.createdAt, timeZone)}</Td>
                  <Td>
                    {PATTERN_SHORT[s.pattern]}
                    {s.variant ? ` ${s.variant}` : ''}
                  </Td>
                  <Td>{s.direction === 'bullish' ? 'Bullish' : 'Bearish'}</Td>
                  <Td>
                    {s.contextTf} / {s.setupTf}
                  </Td>
                  <Td>{sideText(s.base)}</Td>
                  <Td>{sideText(s.other)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {c.setupsTotal > c.setups.length ? (
            <p className="text-xs text-fg-muted">
              The first {SETUP_DIFFERENCES_SHOWN} are shown; the CSV has all {c.setupsTotal}.
            </p>
          ) : null}
        </section>
      ) : null}
      <DownloadButton
        path={`/api/v1/exports/run-comparison.csv?runId=${replay.runId}&compareWith=${c.base.runId}`}
        label="Comparison (CSV)"
        fallbackName={`replay-comparison-${replay.runId}.csv`}
      />
    </div>
  );
}

function ReplayDetail({
  runId,
  compare,
  instrumentName,
  onCompare,
  onStatistics,
}: {
  runId: string;
  compare: string | undefined;
  instrumentName: (id: string) => string;
  onCompare: (runId: string | undefined) => void;
  onStatistics: () => void;
}) {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const detail = useQuery({
    queryKey: ['replay', runId, compare ?? null],
    queryFn: () =>
      client.request<ReplayStatus>(
        'GET',
        `/api/v1/replays/${runId}${compare ? `?compareWith=${compare}` : ''}`,
      ),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'completed' || s === 'failed' ? false : POLL_MS;
    },
  });
  const instrumentId = detail.data?.instrumentId;
  const runs = useQuery({
    queryKey: ['runs', instrumentId],
    queryFn: () =>
      client.request<DetectionRun[]>('GET', `/api/v1/system/runs?instrumentId=${instrumentId}&limit=50`),
    enabled: !!instrumentId,
  });
  if (detail.isPending) return <Spinner label="Loading the replay" />;
  if (detail.isError)
    return (
      <Alert tone="crit" title="The replay could not be loaded">
        {detail.error.message}
      </Alert>
    );
  const r = detail.data;
  const status = STATUS[r.status];
  const others = (runs.data ?? []).filter((x) => x.id !== r.runId);
  return (
    <Card data-replay-detail={r.runId} data-status={r.status}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          Replay of {instrumentName(r.instrumentId)}, {formatInstant(r.from, timeZone)} to{' '}
          {formatInstant(r.to, timeZone)}
        </CardTitle>
        <StatusBadge tone={status.tone} label={status.label} />
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-fg-muted">Settings</dt>
            <dd data-replay-settings="">{settingsSummary(r.settings)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Requested</dt>
            <dd>
              {formatInstant(r.requestedAt, timeZone)}
              {r.finishedAt ? `, finished after ${formatAge(Math.max(0, r.finishedAt - r.requestedAt))}` : ''}
            </dd>
          </div>
          {r.digest ? (
            <div>
              <dt className="text-fg-muted">Digest</dt>
              <dd className="font-mono text-xs" title={r.digest}>
                {r.digest.slice(0, 16)}… ({r.events ?? 0} events in the period)
              </dd>
            </div>
          ) : null}
        </dl>
        {r.status === 'failed' ? (
          <Alert tone="crit" title="The replay failed">
            {r.error}
          </Alert>
        ) : r.status !== 'completed' ? (
          <p className="text-sm text-fg-muted" role="status">
            {r.status === 'queued' ? 'Waiting for the analyzer…' : 'Replaying stored candles…'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="replay-compare">Compare with</Label>
                <Select
                  id="replay-compare"
                  value={compare ?? ''}
                  onChange={(e) => onCompare(e.target.value || undefined)}
                >
                  <option value="">{r.sourceRunId ? 'The live run it started from' : 'Choose a run'}</option>
                  {others.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.mode === 'live' ? 'Live run' : 'Replay'} started{' '}
                      {formatInstant(x.startedAt, timeZone)} ({x.status})
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={onStatistics}>
                Statistics of this replay
              </Button>
            </div>
            {r.comparison ? (
              <ComparisonView
                replay={r}
                comparison={r.comparison}
                instrumentName={instrumentName(r.instrumentId)}
              />
            ) : (
              <p className="text-sm text-fg-muted">
                No live run covered this period, so there is nothing to compare with by default. Choose a run.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReplaysTab({ search, setSearch }: { search: HistorySearch; setSearch: (s: HistorySearch) => void }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const names = new Map((instruments.data ?? []).map((i) => [i.id, i.displayName]));
  const instrumentName = (id: string) => names.get(id) ?? 'Unknown instrument';
  const replays = useQuery({
    queryKey: ['replays'],
    queryFn: () => client.request<ReplaySummary[]>('GET', '/api/v1/replays?limit=50'),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => r.status !== 'completed' && r.status !== 'failed') ? POLL_MS : false,
  });
  const select = (replay: string) => setSearch({ tab: 'replays', replay });

  return (
    <div className="space-y-6">
      {can(user.role, 'replays.run') ? (
        <StartReplay
          onStarted={(runId) => {
            void queryClient.invalidateQueries({ queryKey: ['replays'] });
            select(runId);
          }}
        />
      ) : (
        <p className="text-sm text-fg-muted">
          Analysts and admins can start replays; you can look at them here.
        </p>
      )}
      {search.replay ? (
        <ReplayDetail
          runId={search.replay}
          compare={search.compare}
          instrumentName={instrumentName}
          onCompare={(compare) =>
            setSearch({ tab: 'replays', replay: search.replay!, ...(compare ? { compare } : {}) })
          }
          onStatistics={() => setSearch({ tab: 'stats', run: search.replay! })}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Replays</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {replays.isPending ? (
            <Spinner label="Loading the replays" />
          ) : replays.isError ? (
            <Alert tone="crit" title="The replays could not be loaded">
              {replays.error.message}
            </Alert>
          ) : replays.data.length === 0 ? (
            <Empty>No replay yet.</Empty>
          ) : (
            <Table>
              <caption className="sr-only">Replays, newest first</caption>
              <thead>
                <tr>
                  <Th>Requested</Th>
                  <Th>Instrument</Th>
                  <Th>Period</Th>
                  <Th>Settings</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Open</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {replays.data.map((r) => (
                  <tr
                    key={r.runId}
                    data-replay-id={r.runId}
                    data-status={r.status}
                    aria-current={r.runId === search.replay}
                  >
                    <Td className="whitespace-nowrap">
                      {formatInstant(r.requestedAt, timeZone)}
                      {r.mine ? <span className="ml-1 text-fg-muted">(you)</span> : null}
                    </Td>
                    <Td>{instrumentName(r.instrumentId)}</Td>
                    <Td className="whitespace-nowrap">
                      {formatInstant(r.from, timeZone)} to {formatInstant(r.to, timeZone)}
                    </Td>
                    <Td className="max-w-xs">{settingsSummary(r.settings)}</Td>
                    <Td>
                      <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
                    </Td>
                    <Td>
                      <Button type="button" variant="ghost" size="sm" onClick={() => select(r.runId)}>
                        Show
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'stats', label: 'Outcome statistics' },
  { id: 'replays', label: 'Replays' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Historical analytics (Phase 12; REQUIREMENTS §3.9, SMC-08 and NFR-14; ADR 026): how past setups
 * ended, labelled as historical observations and never as expected performance (criterion 12.2), and
 * replays of stored periods, compared with the live analysis or with each other (criterion 12.3).
 */
export function HistoricalAnalyticsPage() {
  const [search, setSearch] = useHistorySearch();
  const tab: TabId = search.tab ?? (search.replay ? 'replays' : 'stats');
  const refs = useRef<Record<TabId, HTMLButtonElement | null>>({ stats: null, replays: null });
  const go = (id: TabId) => setSearch(id === tab ? search : { tab: id });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? TABS.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    go(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Historical Analytics</h1>
        <p className="text-sm text-fg-muted">
          {HISTORICAL_OBSERVATIONS} of how past setups ended, and replays of stored periods.
        </p>
      </header>
      <div
        role="tablist"
        aria-label="Historical Analytics views"
        className="flex gap-1 border-b border-border"
        onKeyDown={onKey}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`history-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`history-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={
              tab === t.id
                ? '-mb-px border-b-2 border-accent px-3 py-2 text-sm font-medium'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted hover:text-fg'
            }
            onClick={() => go(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`history-panel-${tab}`} aria-labelledby={`history-tab-${tab}`} tabIndex={0}>
        {tab === 'stats' ? (
          <StatsTab search={search} setSearch={setSearch} />
        ) : (
          <ReplaysTab search={search} setSearch={setSearch} />
        )}
      </div>
    </div>
  );
}
