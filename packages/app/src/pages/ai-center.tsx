import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  AI_DISCLAIMER,
  AI_REASONS,
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiBudgetStatus,
  type AiContext,
  type AiReason,
  type AiStatus,
  type AiStatusReport,
  type AiValidationIssue,
  can,
  type Instrument,
} from '@cip/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { useInstruments } from '../api/queries.js';
import {
  answerView,
  BUDGET_LABEL,
  describeRef,
  failureText,
  formatTokens,
  formatUsd,
  type InFlight,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  triggerLabel,
} from '../lib/ai.js';
import { formatAge, formatInstant } from '../lib/format.js';
import { groupInstruments } from '../lib/market.js';
import { readAiSearch, type AiSearch } from '../lib/search.js';
import { PATTERN_TITLE, STATE_TITLE } from '../lib/setups.js';
import {
  type AiFilters,
  useAiAnalyses,
  useAiAnalysis,
  useAiLive,
  useAiUsage,
  useOpenSetups,
} from '../live/ai-hooks.js';
import { useSystemHealth } from '../live/market-hooks.js';
import { useCurrentUser, useDisplayTimeZone, useNow, useSession } from '../session.js';

const PAGE = 50;

/** The budget, the provider and the switch: what decides whether an analysis can run now. */
function BudgetCard({
  budget,
  provider,
  pending,
}: {
  budget: AiBudgetStatus | undefined;
  provider: AiStatusReport | undefined;
  pending: boolean;
}) {
  return (
    <Card data-ai="budget">
      <CardHeader>
        <CardTitle>Budget and provider</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {budget ? (
          <>
            <p className="flex items-center gap-2">
              <Badge
                tone={budget.state === 'ok' ? 'ok' : budget.state === 'throttled' ? 'warn' : 'crit'}
                data-budget-state={budget.state}
              >
                {BUDGET_LABEL[budget.state]}
              </Badge>
            </p>
            {budget.state === 'exhausted' ? (
              <Alert tone="crit" title="AI budget reached">
                No analyses run until the cap resets: the daily cap at 00:00 UTC, the monthly cap on the 1st.
              </Alert>
            ) : null}
            {!budget.enabled ? (
              <Alert tone="warn" title="AI analyses are switched off">
                An admin switched them off: nothing is sent to Grok.
              </Alert>
            ) : null}
            <Meter label="Today (UTC)" cap={budget.daily} />
            <Meter label="This month (UTC)" cap={budget.monthly} />
          </>
        ) : pending ? (
          <Spinner label="Loading the budget" />
        ) : (
          <p className="text-fg-muted">The budget could not be loaded.</p>
        )}
        <div className="border-t border-border pt-3" data-ai="provider">
          <p className="font-medium">Grok (xAI)</p>
          {provider ? (
            <p className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={provider.status === 'ok' ? 'ok' : provider.status === 'degraded' ? 'warn' : 'crit'}
                label={provider.status}
              />
              <span className="text-fg-muted">{provider.detail}</span>
            </p>
          ) : (
            <p className="text-fg-muted">No report from the jobs service yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Meter({ label, cap }: { label: string; cap: AiBudgetStatus['daily'] }) {
  const pct = Math.max(0, Math.min(100, cap.usedPct));
  return (
    <div className="space-y-1">
      <p className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono tabular-nums">
          {formatUsd(cap.spentUsd)} of {formatUsd(cap.capUsd)}
        </span>
      </p>
      <div
        role="meter"
        aria-label={`${label}: spent`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${cap.usedPct} % of the cap`}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div className={pct >= 80 ? 'h-full bg-warn' : 'h-full bg-accent'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** An on-demand request (analysts and admins): a reason from a fixed list, never free text (ADR 011). */
function RequestCard({
  instruments,
  search,
  blocked,
  onQueued,
}: {
  instruments: readonly Instrument[];
  search: AiSearch;
  blocked: string | null;
  onQueued: (analysisId: string) => void;
}) {
  const { client } = useSession();
  const analysed = instruments.filter((i) => i.profile !== null);
  const [instrumentId, setInstrumentId] = useState(
    search.instrument && analysed.some((i) => i.id === search.instrument)
      ? search.instrument
      : (analysed[0]?.id ?? ''),
  );
  const [reason, setReason] = useState<AiReason>(
    search.reason ?? (search.setup ? 'setup_review' : 'market_summary'),
  );
  const [setupId, setSetupId] = useState(search.setup ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const setups = useOpenSetups(reason === 'setup_review' && instrumentId ? instrumentId : null);
  const options = reason === 'setup_review' ? (setups.data?.items ?? []) : [];
  const chosenSetup = options.some((s) => s.id === setupId) ? setupId : (options[0]?.id ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const body = {
        instrumentId,
        reason,
        ...(reason === 'setup_review' ? { setupId: chosenSetup } : {}),
      };
      const res = await client.request<{ analysisId: string }>('POST', '/api/v1/ai/analyses', body);
      setResult({
        tone: 'ok',
        text: 'Queued. Grok answers within a minute or so; the checks run before anything is shown.',
      });
      onQueued(res.analysisId);
    } catch (err) {
      const code = err instanceof ApiError ? err.problem?.code : undefined;
      setResult({
        tone: 'crit',
        text:
          code === 'BUDGET_EXHAUSTED'
            ? 'AI budget reached.'
            : err instanceof Error
              ? err.message
              : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-ai="request">
      <CardHeader>
        <CardTitle>Ask for an analysis</CardTitle>
      </CardHeader>
      <CardContent>
        <form aria-label="Request an analysis" className="space-y-3 text-sm" onSubmit={(e) => void submit(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="ai-instrument">Instrument</Label>
            <Select
              id="ai-instrument"
              className="block w-full"
              value={instrumentId}
              onChange={(e) => setInstrumentId(e.target.value)}
            >
              {groupInstruments(analysed).map((g) => (
                <optgroup key={g.key} label={g.title}>
                  {g.instruments.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.displayName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-reason">What for</Label>
            <Select
              id="ai-reason"
              className="block w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value as AiReason)}
            >
              {AI_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>
          {reason === 'setup_review' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ai-setup">Setup</Label>
              <Select
                id="ai-setup"
                className="block w-full"
                value={chosenSetup}
                onChange={(e) => setSetupId(e.target.value)}
                disabled={options.length === 0}
              >
                {options.length === 0 ? <option value="">No open setup on this pair</option> : null}
                {options.map((s) => (
                  <option key={s.id} value={s.id}>
                    {PATTERN_TITLE[s.pattern]}, {s.direction} ({STATE_TITLE[s.state].toLowerCase()})
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {blocked ? <p className="text-warn">{blocked}</p> : null}
          <Button
            type="submit"
            disabled={
              busy || blocked !== null || !instrumentId || (reason === 'setup_review' && !chosenSetup)
            }
          >
            {busy ? 'Asking…' : 'Ask Grok'}
          </Button>
          {result ? (
            <p role="status" className={result.tone === 'ok' ? 'text-ok' : 'text-crit'}>
              {result.text}
            </p>
          ) : null}
          <p className="text-xs text-fg-muted">At most 10 requests an hour, within the shared budget.</p>
        </form>
      </CardContent>
    </Card>
  );
}

function InFlightCard({
  inFlight,
  names,
}: {
  inFlight: readonly InFlight[];
  names: ReadonlyMap<string, string>;
}) {
  const now = useNow();
  return (
    <Card data-ai="in-flight">
      <CardHeader>
        <CardTitle>On their way</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {inFlight.length === 0 ? (
          <p className="text-fg-muted">
            Nothing is waiting for Grok. Analyses start on significant events, every 4 hours, and on request.
          </p>
        ) : (
          <ul className="space-y-1.5" aria-live="polite">
            {inFlight.map((a) => (
              <li key={a.analysisId} data-in-flight={a.analysisId} className="flex items-center gap-2">
                <Badge tone={a.state === 'running' ? 'info' : 'neutral'}>
                  {a.state === 'running' ? 'Grok is answering' : 'Queued'}
                </Badge>
                <span>{names.get(a.instrumentId) ?? a.instrumentId}</span>
                <span className="text-fg-muted">
                  {triggerLabel({ trigger: a.trigger, reason: null })}, {formatAge(now - a.since)} ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_FILTERS = {
  all: { label: 'Every outcome', status: [] as AiStatus[] },
  shown: { label: 'Accepted and from cache', status: ['accepted', 'cache_hit'] as AiStatus[] },
  problems: {
    label: 'Rejected, failed or not called',
    status: ['rejected', 'failed', 'skipped_budget'] as AiStatus[],
  },
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

function History({
  names,
  instruments,
  selected,
  onOpen,
  timeZone,
}: {
  names: ReadonlyMap<string, string>;
  instruments: readonly Instrument[];
  selected: string | null;
  onOpen: (id: string) => void;
  timeZone: string;
}) {
  const [instrumentId, setInstrumentId] = useState('');
  const [outcome, setOutcome] = useState<StatusFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  const filters: AiFilters = {
    ...(instrumentId ? { instrumentId } : {}),
    ...(STATUS_FILTERS[outcome].status.length ? { status: STATUS_FILTERS[outcome].status } : {}),
  };
  const list = useAiAnalyses(filters, limit);
  let body: ReactNode;
  if (list.isPending) body = <Spinner label="Loading the analyses" />;
  else if (list.isError)
    body = (
      <Alert tone="crit" title="The analyses could not be loaded">
        {list.error.message}
      </Alert>
    );
  else if (list.data.items.length === 0)
    body = (
      <Alert tone="info" title="No analyses yet">
        Analyses appear here as significant events happen, every 4 hours, and when someone asks for one.
      </Alert>
    );
  else
    body = (
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th scope="col">Time</Th>
                <Th scope="col">Instrument</Th>
                <Th scope="col">Why</Th>
                <Th scope="col">Outcome</Th>
                <Th scope="col">Headline</Th>
                <Th scope="col">Cost</Th>
                <Th scope="col">
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <HistoryRow
                  key={a.id}
                  a={a}
                  name={a.instrumentId ? (names.get(a.instrumentId) ?? a.instrumentId) : '—'}
                  selected={a.id === selected}
                  onOpen={onOpen}
                  timeZone={timeZone}
                />
              ))}
            </tbody>
          </Table>
        </div>
        {list.data.nextCursor && limit < 1000 ? (
          <Button variant="secondary" onClick={() => setLimit((n) => Math.min(1000, n + PAGE))}>
            Load more
          </Button>
        ) : null}
      </div>
    );
  return (
    <section aria-labelledby="ai-history" className="space-y-3">
      <h2 id="ai-history" className="text-lg font-semibold">
        History
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="ai-filter-instrument">Instrument</Label>
          <Select
            id="ai-filter-instrument"
            className="block min-w-64"
            value={instrumentId}
            onChange={(e) => {
              setInstrumentId(e.target.value);
              setLimit(PAGE);
            }}
          >
            <option value="">All instruments</option>
            {groupInstruments(instruments).map((g) => (
              <optgroup key={g.key} label={g.title}>
                {g.instruments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayName}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ai-filter-outcome">Outcome</Label>
          <Select
            id="ai-filter-outcome"
            className="block"
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value as StatusFilter);
              setLimit(PAGE);
            }}
          >
            {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_FILTERS[k].label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {body}
    </section>
  );
}

function HistoryRow({
  a,
  name,
  selected,
  onOpen,
  timeZone,
}: {
  a: AiAnalysisSummary;
  name: string;
  selected: boolean;
  onOpen: (id: string) => void;
  timeZone: string;
}) {
  return (
    <tr
      className={selected ? 'border-t border-border bg-surface-2' : 'border-t border-border'}
      data-analysis-id={a.id}
      data-status={a.status}
    >
      <Td className="whitespace-nowrap text-xs">{formatInstant(a.createdAt, timeZone)}</Td>
      <Td>{name}</Td>
      <Td className="text-xs">{triggerLabel(a)}</Td>
      <Td>
        <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
      </Td>
      <Td className="max-w-md">
        {a.headline ?? <span className="text-fg-muted">{failureText(a.error) || '—'}</span>}
      </Td>
      <Td className="font-mono text-xs tabular-nums">{formatUsd(a.costUsd)}</Td>
      <Td>
        <Button
          size="sm"
          variant="ghost"
          aria-current={selected ? 'true' : undefined}
          aria-label={`Open the analysis of ${name} at ${formatInstant(a.createdAt, timeZone)}`}
          onClick={() => onOpen(a.id)}
        >
          Open
        </Button>
      </Td>
    </tr>
  );
}

/** The cited ids of one statement, each with the context item it points at. */
function Refs({ refs, context }: { refs: readonly string[]; context: AiContext | null }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
      {refs.map((r) => {
        const what = context ? describeRef(context, r) : null;
        return (
          <li key={r} data-ref={r}>
            <code className="font-mono">{r}</code> {what ?? 'not in the context'}
          </li>
        );
      })}
    </ul>
  );
}

function Issues({ title, issues }: { title: string; issues: readonly AiValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-medium">{title}</p>
      <ul className="space-y-0.5 text-sm" data-issues={title}>
        {issues.map((i, n) => (
          <li key={`${i.rule}-${i.path}-${n}`}>
            <Badge tone="neutral">{i.rule}</Badge>{' '}
            <span className="font-mono text-xs">{i.path || 'answer'}</span>: {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The accepted answer, each statement with what it cites (rendered as text, never as markup). */
function Answer({ d }: { d: AiAnalysisDetail }) {
  const view = answerView(d.response);
  if (!view) return <p className="text-fg-muted">The stored answer cannot be read.</p>;
  const ctx = d.context;
  const cited = (title: string, items: readonly { text: string; refs: string[] }[]) =>
    items.length ? (
      <div className="space-y-1">
        <h4 className="font-medium">{title}</h4>
        <ul className="space-y-2">
          {items.map((o, n) => (
            <li key={n}>
              {o.text}
              <Refs refs={o.refs} context={ctx} />
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="space-y-4 text-sm" data-answer={d.id}>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{view.headline}</h3>
        <p>{view.summary}</p>
        <p className="text-fg-muted">
          Reading of the data: <span data-stance={view.stance}>{view.stance}</span>, confidence{' '}
          {view.confidence}. This describes the data now; it is not a forecast.
        </p>
      </div>
      {cited('Observations', view.observations)}
      {view.supportingIndicators.length ? (
        <div className="space-y-1">
          <h4 className="font-medium">Indicators</h4>
          <ul className="space-y-2">
            {view.supportingIndicators.map((s) => (
              <li key={s.ref}>
                {s.reading}
                <Refs refs={[s.ref]} context={ctx} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {cited('Risks', view.risks)}
      {cited('What would invalidate it', view.invalidation ? [view.invalidation] : [])}
      {cited('The competing scenario', view.competingScenario ? [view.competingScenario] : [])}
      {view.dataQualityNotes.length ? (
        <div className="space-y-1">
          <h4 className="font-medium">Data quality</h4>
          <ul className="list-disc pl-5">
            {view.dataQualityNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Issues title="Notes from the checks" issues={d.validation.warnings} />
      <p className="text-xs font-medium text-warn">{AI_DISCLAIMER}</p>
    </div>
  );
}

function Detail({
  id,
  names,
  timeZone,
  onOpen,
}: {
  id: string;
  names: ReadonlyMap<string, string>;
  timeZone: string;
  onOpen: (id: string) => void;
}) {
  const q = useAiAnalysis(id);
  if (q.isPending) return <Spinner label="Loading the analysis" />;
  if (q.isError)
    return (
      <Alert tone="crit" title="The analysis could not be loaded">
        {q.error.message}
      </Alert>
    );
  const d = q.data;
  const shown = d.status === 'accepted' || d.status === 'cache_hit';
  const u = d.usage;
  return (
    <div className="space-y-4" data-detail={d.id} data-status={d.status}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
        <span className="font-medium">
          {d.instrumentId ? (names.get(d.instrumentId) ?? d.instrumentId) : '—'}
        </span>
        <span className="text-fg-muted">
          {triggerLabel(d)}, {formatInstant(d.createdAt, timeZone)}
        </span>
      </div>
      {d.status === 'cache_hit' && d.cacheSourceId ? (
        <p className="text-sm text-fg-muted">
          The context was identical to an analysis of the last 30 minutes: its answer was reused, at no cost.{' '}
          <button type="button" className="text-accent underline" onClick={() => onOpen(d.cacheSourceId!)}>
            Open the original
          </button>
        </p>
      ) : null}
      {shown ? <Answer d={d} /> : null}
      {d.status === 'rejected' ? (
        <div className="space-y-3">
          <Alert tone="crit" title="Rejected by the checks">
            Grok&apos;s answer failed the platform&apos;s checks{d.repairAttempted ? ', twice' : ''}, so it is
            not shown as an analysis. It is kept here, with what was wrong, for review.
          </Alert>
          <Issues title="What the checks found" issues={d.validation.errors} />
          <Issues
            title="In the first answer (before the repair attempt)"
            issues={d.validation.firstAttemptErrors ?? []}
          />
          {d.error ? <p className="text-sm text-fg-muted">{failureText(d.error)}</p> : null}
          <details className="text-sm">
            <summary className="cursor-pointer">The rejected answer, as received</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-2 p-3 text-xs whitespace-pre-wrap">
              {JSON.stringify(d.response, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
      {d.status === 'failed' || d.status === 'skipped_budget' ? (
        <Alert tone={d.status === 'failed' ? 'crit' : 'warn'} title={STATUS_LABEL[d.status]}>
          {failureText(d.error)}
        </Alert>
      ) : null}
      <details className="text-sm" data-provenance={d.id}>
        <summary className="cursor-pointer font-medium">How it was made</summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-fg-muted">Triggered by</dt>
          <dd>
            {d.triggerRefs.length
              ? d.triggerRefs.map((t) => `${t.kind} (${t.score})`).join(', ')
              : triggerLabel(d)}
          </dd>
          <dt className="text-fg-muted">Model</dt>
          <dd>
            {d.modelRequested}
            {d.modelReported && d.modelReported !== d.modelRequested
              ? ` (answered as ${d.modelReported})`
              : ''}
          </dd>
          <dt className="text-fg-muted">Prompt version</dt>
          <dd>{d.promptVersion}</dd>
          <dt className="text-fg-muted">Tokens</dt>
          <dd className="font-mono tabular-nums">
            {formatTokens(u.inputTokens)} in ({formatTokens(u.cachedInputTokens)} cached),{' '}
            {formatTokens(u.outputTokens)} out, {formatTokens(u.reasoningTokens)} reasoning
          </dd>
          <dt className="text-fg-muted">Cost</dt>
          <dd className="font-mono tabular-nums">{formatUsd(u.costUsd)}</dd>
          <dt className="text-fg-muted">Time</dt>
          <dd>{u.latencyMs === null ? '—' : `${(u.latencyMs / 1000).toFixed(1)} s`}</dd>
          <dt className="text-fg-muted">Context hash</dt>
          <dd className="font-mono text-xs">{d.contextHash ? d.contextHash.slice(0, 16) : '—'}</dd>
        </dl>
        <details className="mt-2">
          <summary className="cursor-pointer">The context sent to Grok</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-2 p-3 text-xs whitespace-pre-wrap">
            {d.context ? JSON.stringify(d.context, null, 2) : 'None: the context could not be built.'}
          </pre>
        </details>
      </details>
    </div>
  );
}

function Usage({ days }: { days: NonNullable<ReturnType<typeof useAiUsage>['data']>['days'] }) {
  return (
    <section aria-labelledby="ai-usage" className="space-y-3">
      <h2 id="ai-usage" className="text-lg font-semibold">
        Usage, last 30 days (UTC)
      </h2>
      {days.length === 0 ? (
        <p className="text-sm text-fg-muted">No calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th scope="col">Day</Th>
                <Th scope="col">Calls</Th>
                <Th scope="col">Accepted</Th>
                <Th scope="col">Rejected</Th>
                <Th scope="col">Failed</Th>
                <Th scope="col">From cache</Th>
                <Th scope="col">Not called</Th>
                <Th scope="col">Tokens in</Th>
                <Th scope="col">Tokens out</Th>
                <Th scope="col">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-t border-border" data-usage-day={d.day}>
                  <Td className="whitespace-nowrap">{d.day}</Td>
                  <Td className="tabular-nums">{d.calls}</Td>
                  <Td className="tabular-nums">{d.accepted}</Td>
                  <Td className="tabular-nums">{d.rejected}</Td>
                  <Td className="tabular-nums">{d.failed}</Td>
                  <Td className="tabular-nums">{d.cacheHits}</Td>
                  <Td className="tabular-nums">{d.skipped}</Td>
                  <Td className="font-mono tabular-nums">{formatTokens(d.inputTokens)}</Td>
                  <Td className="font-mono tabular-nums">{formatTokens(d.outputTokens)}</Td>
                  <Td className="font-mono tabular-nums">{formatUsd(d.costUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}

/**
 * AI Intelligence Center (REQUIREMENTS §4, Phase 9, ADR 023): Grok explains what the platform's own
 * analysis found. Every answer passed the server's checks (each reference exists, each number is in
 * the data, no certainty and no trading instructions) before it is shown; rejected ones are kept,
 * with what was wrong, and never shown as an analysis. The budget and the provider's state come
 * from the server; nothing here is simulated.
 */
export function AiCenterPage() {
  const search = readAiSearch(useSearch({ strict: false }) as unknown);
  const navigate = useNavigate();
  const user = useCurrentUser();
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const health = useSystemHealth();
  const usage = useAiUsage();
  const [queued, setQueued] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const { inFlight } = useAiLive((id) => {
    if (id === queued) setFinished(id);
  });
  const list = instruments.data ?? [];
  const names = new Map(list.map((i) => [i.id, i.displayName]));
  const budget = usage.data?.budget;
  const provider = health.data?.ai;
  const open = (id: string) => void navigate({ to: '/ai', search: { ...search, analysis: id } });
  const blocked = !budget
    ? null
    : !budget.enabled
      ? 'AI analyses are switched off.'
      : budget.state === 'exhausted'
        ? 'AI budget reached.'
        : provider && !provider.keyConfigured
          ? 'No Grok API key is configured.'
          : null;

  return (
    <div className="max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">AI Intelligence Center</h1>
        <p className="text-sm text-fg-muted">
          Grok explains what the platform&apos;s own analysis found: significant events as they happen, a
          review every 4 hours, and analyses on request. Every answer is checked against the data before it is
          shown: each reference must exist, each number must be in the data, and no certainty or trading
          instruction is allowed.
        </p>
        <p className="text-sm font-medium text-warn" data-disclaimer="ai">
          {AI_DISCLAIMER}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <BudgetCard budget={budget} provider={provider} pending={usage.isPending} />
        {can(user.role, 'ai.request') ? (
          instruments.isPending ? (
            <Spinner label="Loading the instruments" />
          ) : (
            <RequestCard
              instruments={list}
              search={search}
              blocked={blocked}
              onQueued={(id) => {
                setQueued(id);
                setFinished(null);
              }}
            />
          )
        ) : null}
        <InFlightCard inFlight={inFlight} names={names} />
      </div>
      {finished ? (
        <Alert tone="info" title="Your analysis is ready">
          <button type="button" className="text-accent underline" onClick={() => open(finished)}>
            Open it
          </button>
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <History
          names={names}
          instruments={list}
          selected={search.analysis ?? null}
          onOpen={open}
          timeZone={timeZone}
        />
        <section aria-labelledby="ai-detail" className="space-y-3">
          <h2 id="ai-detail" className="text-lg font-semibold">
            Analysis
          </h2>
          {search.analysis ? (
            <Detail id={search.analysis} names={names} timeZone={timeZone} onOpen={open} />
          ) : (
            <p className="text-sm text-fg-muted">Open an analysis from the history to read it in full.</p>
          )}
        </section>
      </div>

      {usage.data ? <Usage days={usage.data.days} /> : null}
    </div>
  );
}
