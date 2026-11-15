import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode, useId, useState } from 'react';
import {
  type Instrument,
  type Pattern,
  SETUP_DISCLAIMER,
  SETUP_STATES,
  type SetupState,
  type SetupSummary,
} from '@cip/contracts';
import { Alert, Badge, Button, Checkbox, Input, Label, Select, Spinner, Table, Td, Th } from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { type SetupFilters, useSetupDetail, useSetupList } from '../live/smc-hooks.js';
import { formatInstant } from '../lib/format.js';
import { groupInstruments } from '../lib/market.js';
import {
  CHECKLIST_LABELS,
  creditText,
  evidenceText,
  formatRr,
  isSetupSort,
  OPEN_STATES,
  PATTERN_SHORT,
  PATTERN_TITLE,
  PATTERNS,
  RESOLUTION_TITLE,
  SETUP_SORTS,
  sortSetups,
  STATE_TITLE,
} from '../lib/setups.js';
import { readScannerSearch, type ScannerSearch } from '../lib/search.js';
import { useDisplayTimeZone } from '../session.js';

const splitList = <T extends string>(value: string | undefined, allowed: readonly T[]): T[] =>
  (value ?? '').split(',').filter((v): v is T => (allowed as readonly string[]).includes(v));

const PAGE = 100;

function Levels({ setup }: { setup: SetupSummary }) {
  const l = setup.levels;
  return (
    <>
      <Td className="font-mono tabular-nums" data-level="entry">
        {l.entry ?? '—'}
      </Td>
      <Td className="font-mono tabular-nums" data-level="invalidation">
        {l.invalidation ?? '—'}
      </Td>
      <Td className="font-mono tabular-nums" data-level="target1">
        {l.target1 ?? '—'}
      </Td>
      <Td className="font-mono tabular-nums whitespace-nowrap" data-level="rr">
        {formatRr(l.rr)}
      </Td>
    </>
  );
}

/** A setup's checklist, loaded when its row is opened. */
function ChecklistPanel({ setup }: { setup: SetupSummary }) {
  const detail = useSetupDetail(setup.id, setup.instrumentId);
  if (detail.isPending) return <Spinner label="Loading the checklist" />;
  if (detail.isError)
    return <p className="text-sm text-crit">The checklist could not be loaded: {detail.error.message}</p>;
  return (
    <div className="space-y-2" data-checklist={setup.id}>
      <ul className="grid gap-1 text-sm md:grid-cols-2">
        {detail.data.checklist.map((r) => (
          <li key={r.item} className="flex items-baseline gap-2" data-item={r.item} data-credit={r.credit}>
            <Badge tone={r.credit === 1 ? 'ok' : r.credit === 0.5 ? 'warn' : 'crit'}>
              {creditText(r.credit)}
            </Badge>
            <span>
              {CHECKLIST_LABELS[r.item]}
              <span className="text-fg-muted">
                {' '}
                ({r.weight}
                {r.mandatory ? ', mandatory' : ''})
              </span>
              {evidenceText(r) ? (
                <span className="block text-xs text-fg-muted">{evidenceText(r)}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">{SETUP_DISCLAIMER}</p>
    </div>
  );
}

function SetupRows({
  setups,
  instruments,
  timeZone,
}: {
  setups: readonly SetupSummary[];
  instruments: ReadonlyMap<string, Instrument>;
  timeZone: string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return (
    <Table>
      <thead>
        <tr>
          <Th scope="col">
            <span className="sr-only">Checklist</span>
          </Th>
          <Th scope="col">Instrument</Th>
          <Th scope="col">Pattern</Th>
          <Th scope="col">Direction</Th>
          <Th scope="col">Timeframes</Th>
          <Th scope="col">State</Th>
          <Th scope="col">Score</Th>
          <Th scope="col">Entry</Th>
          <Th scope="col">Invalidation</Th>
          <Th scope="col">Target 1</Th>
          <Th scope="col">R:R</Th>
          <Th scope="col">Flags</Th>
          <Th scope="col">Last change</Th>
        </tr>
      </thead>
      <tbody>
        {setups.map((s) => {
          const expanded = open.has(s.id);
          const name = instruments.get(s.instrumentId)?.displayName ?? s.instrumentId;
          const panelId = `checklist-${s.id}`;
          return (
            <Fragment key={s.id}>
              <tr
                className="border-t border-border"
                data-setup-id={s.id}
                data-instrument={s.instrumentId}
                data-pattern={s.pattern}
                data-direction={s.direction}
                data-state={s.state}
                data-score={s.score}
                data-rr={s.levels.rr ?? ''}
                data-updated={s.updatedAt}
              >
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-label={`${expanded ? 'Hide' : 'Show'} the checklist of ${PATTERN_SHORT[s.pattern]} on ${name}`}
                    onClick={() => {
                      const next = new Set(open);
                      if (expanded) next.delete(s.id);
                      else next.add(s.id);
                      setOpen(next);
                    }}
                  >
                    {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </Button>
                </Td>
                <Td>
                  <Link to="/setups/$setupId" params={{ setupId: s.id }} className="text-accent underline">
                    {name}
                  </Link>
                </Td>
                <Td title={PATTERN_TITLE[s.pattern]}>
                  {PATTERN_SHORT[s.pattern]}
                  {s.variant ? ` ${s.variant}` : ''}
                </Td>
                <Td>{s.direction === 'bullish' ? 'Bullish' : 'Bearish'}</Td>
                <Td className="whitespace-nowrap">
                  {s.contextTf} / {s.setupTf}
                </Td>
                <Td>
                  <span className="whitespace-nowrap">{s.displayLabel}</span>
                  {s.resolution ? (
                    <span className="block text-xs text-fg-muted">
                      {RESOLUTION_TITLE[s.resolution] ?? s.resolution}
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  {s.score}
                  {s.mandatoryPassed ? null : (
                    <span className="block text-xs text-warn">mandatory item failing</span>
                  )}
                </Td>
                <Levels setup={s} />
                <Td className="text-xs text-fg-muted">{[...s.qualityFlags, ...s.flags].join(', ') || '—'}</Td>
                <Td className="whitespace-nowrap text-xs">{formatInstant(s.updatedAt, timeZone)}</Td>
              </tr>
              {expanded ? (
                <tr id={panelId}>
                  <td colSpan={13} className="bg-surface-2 px-4 py-3">
                    <ChecklistPanel setup={s} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

/**
 * Setup Scanner (REQUIREMENTS §6, Phase 7): live and recent setups across instruments and
 * timeframes, with their state, score, hypothetical levels and R:R, and each one's checklist. The
 * filters go to `GET /setups`; sorting is done here, on the loaded rows. Every transition on the
 * `setups` channel reloads the list.
 */
export function SetupScannerPage() {
  const search: unknown = useSearch({ from: '/setups' });
  const navigate = useNavigate();
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const s = readScannerSearch(search);
  const [limit, setLimit] = useState(PAGE);
  const patterns = splitList<Pattern>(s.pattern, PATTERNS);
  const states =
    s.state === 'all'
      ? []
      : s.state === undefined
        ? [...OPEN_STATES]
        : splitList<SetupState>(s.state, SETUP_STATES);
  const sort = s.sort ?? 'updated';
  const filters: SetupFilters = {
    ...(s.instrument ? { instrumentId: s.instrument } : {}),
    ...(patterns.length ? { pattern: patterns } : {}),
    ...(s.direction ? { direction: s.direction } : {}),
    ...(states.length ? { state: states } : {}),
    ...(s.minScore ? { minScore: s.minScore } : {}),
  };
  const list = useSetupList(filters, limit);
  const byId = new Map((instruments.data ?? []).map((i) => [i.id, i]));
  const rows = sortSetups(list.data?.items ?? [], sort, (id) => byId.get(id)?.displayName ?? id);
  const groups = groupInstruments(instruments.data ?? []);
  const update = (patch: Partial<ScannerSearch>) => {
    const next = { ...s, ...patch };
    for (const k of Object.keys(next) as (keyof ScannerSearch)[])
      if (next[k] === undefined || next[k] === '') delete next[k];
    setLimit(PAGE);
    void navigate({ to: '/setups', search: next });
  };
  const toggle = (
    value: string,
    current: readonly string[],
    all: readonly string[],
    key: 'pattern' | 'state',
  ) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const ordered = all.filter((v) => next.includes(v));
    update({ [key]: key === 'state' && ordered.length === 0 ? 'all' : ordered.join(',') || undefined });
  };
  const patternsId = useId();
  const statesId = useId();

  let body: ReactNode;
  if (list.isPending) body = <Spinner label="Loading setups" />;
  else if (list.isError)
    body = (
      <Alert tone="crit" title="Setups could not be loaded">
        {list.error.message}
      </Alert>
    );
  else if (rows.length === 0)
    body = (
      <Alert tone="info" title="No setups match">
        No setup of the analyzers&apos; live runs matches these filters. Setups appear as the SMC engine finds
        them on closed candles.
      </Alert>
    );
  else
    body = (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted" data-setup-count={rows.length}>
          {rows.length} setup{rows.length === 1 ? '' : 's'}
          {list.data?.nextCursor ? ' (more available)' : ''}, sorted by {SETUP_SORTS[sort].toLowerCase()}.
        </p>
        <div className="overflow-x-auto">
          <SetupRows setups={rows} instruments={byId} timeZone={timeZone} />
        </div>
        {list.data?.nextCursor && limit < 1000 ? (
          <Button variant="secondary" onClick={() => setLimit((n) => Math.min(1000, n + PAGE))}>
            Load more
          </Button>
        ) : null}
      </div>
    );

  return (
    <div className="max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Setup Scanner</h1>
        <p className="text-sm text-fg-muted">
          Pattern setups the SMC engine is watching or has confirmed, across instruments and timeframes. A
          setup that fails a mandatory checklist item is never shown as confirmed.
        </p>
        <p className="text-sm font-medium text-warn" data-disclaimer="setups">
          All levels are hypothetical. {SETUP_DISCLAIMER}.
        </p>
      </header>

      <section
        aria-label="Filters"
        className="flex flex-wrap items-end gap-4 rounded-md border border-border p-4"
      >
        <div className="space-y-1.5">
          <Label htmlFor="scanner-instrument">Instrument</Label>
          <Select
            id="scanner-instrument"
            className="block min-w-64"
            value={s.instrument ?? ''}
            onChange={(e) => update({ instrument: e.target.value || undefined })}
          >
            <option value="">All instruments</option>
            {groups.map((g) => (
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
        <fieldset aria-labelledby={patternsId} className="space-y-1.5">
          <legend id={patternsId} className="text-sm font-medium">
            Pattern
          </legend>
          <div className="flex gap-3">
            {PATTERNS.map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <Checkbox
                  id={`pattern-${p}`}
                  checked={patterns.includes(p)}
                  onChange={() => toggle(p, patterns, PATTERNS, 'pattern')}
                />
                <Label htmlFor={`pattern-${p}`} className="font-normal" title={PATTERN_TITLE[p]}>
                  {PATTERN_SHORT[p]}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="scanner-direction">Direction</Label>
          <Select
            id="scanner-direction"
            className="block"
            value={s.direction ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              update({ direction: v === 'bullish' || v === 'bearish' ? v : undefined });
            }}
          >
            <option value="">Both</option>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
          </Select>
        </div>
        <fieldset aria-labelledby={statesId} className="space-y-1.5">
          <legend id={statesId} className="text-sm font-medium">
            State
          </legend>
          <div className="flex flex-wrap gap-3">
            {SETUP_STATES.map((st) => (
              <div key={st} className="flex items-center gap-1.5">
                <Checkbox
                  id={`state-${st}`}
                  checked={states.length === 0 || states.includes(st)}
                  onChange={() =>
                    toggle(st, states.length === 0 ? SETUP_STATES : states, SETUP_STATES, 'state')
                  }
                />
                <Label htmlFor={`state-${st}`} className="font-normal">
                  {STATE_TITLE[st]}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="scanner-score">Minimum score</Label>
          <Input
            id="scanner-score"
            type="number"
            min={0}
            max={100}
            step={5}
            className="block w-24"
            value={s.minScore ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ minScore: Number.isFinite(v) && v > 0 ? Math.min(100, v) : undefined });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scanner-sort">Sort by</Label>
          <Select
            id="scanner-sort"
            className="block"
            value={sort}
            onChange={(e) =>
              update({
                sort:
                  isSetupSort(e.target.value) && e.target.value !== 'updated' ? e.target.value : undefined,
              })
            }
          >
            {Object.entries(SETUP_SORTS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      </section>
      {body}
    </div>
  );
}
