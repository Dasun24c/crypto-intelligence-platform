import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import {
  can,
  type Candle,
  type ChartOverlay,
  type ChecklistResult,
  type Instrument,
  SETUP_DISCLAIMER,
  type SetupDetail,
} from '@cip/contracts';
import { dec, DEFAULT_RISK_PCT, positionSize, SUGGESTED_RISK_PCT, TF_MS } from '@cip/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { LiquidityChart } from '../charts/liquidity-chart.js';
import { OVERLAY_KINDS } from '../charts/overlay-items.js';
import { PaxgDisclaimer } from '../components/paxg-disclaimer.js';
import { useSetupDetail } from '../live/smc-hooks.js';
import { formatInstant } from '../lib/format.js';
import { floorToStep } from '../lib/practice.js';
import {
  CHECKLIST_LABELS,
  creditText,
  evidenceText,
  formatRr,
  PATTERN_SHORT,
  PATTERN_TITLE,
  RESOLUTION_TITLE,
  STATE_TITLE,
} from '../lib/setups.js';
import { useCurrentUser, useDisplayTimeZone, useSession } from '../session.js';

/** Candles of context before the setup started, and after it ended. */
const BEFORE = 60;
const AFTER = 30;

function Fact({ label, value, data }: { label: string; value: ReactNode; data?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="font-mono text-sm tabular-nums" {...(data ? { 'data-level': data } : {})}>
        {value}
      </dd>
    </div>
  );
}

function LevelsCard({ setup }: { setup: SetupDetail }) {
  const l = setup.levels;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hypothetical levels</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Fact label="Entry" value={l.entry ?? '—'} data="entry" />
          <Fact label="Invalidation" value={l.invalidation ?? '—'} data="invalidation" />
          <Fact label="Target 1" value={l.target1 ?? '—'} data="target1" />
          <Fact label="Target 2" value={l.target2 ?? '—'} data="target2" />
          <Fact label="R:R (on target 1)" value={formatRr(l.rr)} data="rr" />
        </dl>
        <p className="text-xs text-fg-muted">
          The entry is the entry zone&apos;s proximal edge, the invalidation lies beyond the sweep&apos;s
          extreme, and the targets are the nearest opposite liquidity (rulebook §6.1). {SETUP_DISCLAIMER}.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The position-size calculator (REQUIREMENTS §3.7, SMC-06): the size a user-entered account size
 * and risk % imply at this setup's hypothetical entry and invalidation. Calculation only.
 */
function CalculatorCard({ setup, instrument }: { setup: SetupDetail; instrument: Instrument | null }) {
  const user = useCurrentUser();
  const [account, setAccount] = useState('10000');
  const [risk, setRisk] = useState(DEFAULT_RISK_PCT);
  const { entry, invalidation, target1 } = setup.levels;
  let result: ReturnType<typeof positionSize> | null = null;
  let problem: string | null = null;
  if (entry === null || invalidation === null)
    problem = 'This setup has no entry and invalidation yet, so there is nothing to size.';
  else
    try {
      result = positionSize({
        accountSize: account.trim(),
        riskPct: risk.trim(),
        entry,
        invalidation,
        target: target1,
        ...(instrument ? { qtyStep: instrument.qtyStep } : {}),
      });
    } catch (err) {
      problem = err instanceof Error ? err.message : 'These values cannot be used.';
    }
  const quote = instrument?.quote ?? '';
  const base = instrument?.base ?? '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Position size</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="calc-account">Account size ({quote || 'quote currency'})</Label>
            <Input
              id="calc-account"
              inputMode="decimal"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="calc-risk">Risk per trade (%)</Label>
            <Input
              id="calc-risk"
              inputMode="decimal"
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
              className="w-24"
              aria-describedby="calc-risk-hint"
            />
            <p id="calc-risk-hint" className="text-xs text-fg-muted">
              Suggested {SUGGESTED_RISK_PCT.min}–{SUGGESTED_RISK_PCT.max} %
            </p>
          </div>
        </div>
        {problem ? (
          <p className="text-sm text-warn" role="status">
            {problem}
          </p>
        ) : result ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-calculator="">
            <Fact label="Side" value={result.side === 'long' ? 'Long' : 'Short'} />
            <Fact label={`Amount at risk (${quote})`} value={result.riskAmount} />
            <Fact label="Distance to invalidation" value={`${result.distance} (${result.distancePct} %)`} />
            <Fact
              label={`Quantity (${base}, rounded down to ${instrument?.qtyStep ?? 'the step'})`}
              value={result.quantity}
            />
            <Fact label={`Notional (${quote})`} value={result.notional} />
            <Fact label={`Risk at that quantity (${quote})`} value={result.riskAtQuantity} />
            <Fact label="Leverage needed" value={`${result.leverage}×`} />
            <Fact
              label="R:R and reward at target 1"
              value={result.rr === null ? '—' : `1 : ${result.rr} (${result.reward} ${quote})`}
            />
          </dl>
        ) : null}
        <p className="text-xs text-fg-muted">
          Calculation only: nothing is linked to an exchange account and no order is placed.{' '}
          {SETUP_DISCLAIMER}.
        </p>
        {can(user.role, 'practice.own') ? (
          <PractiseThisSetup setup={setup} instrument={instrument} quantity={result?.quantity ?? null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * "Practise this setup" (criterion 14.6): opens a practice order ticket filled in with the setup's
 * levels (on the pair's price steps) and the calculator's quantity. It places nothing: the user checks
 * the ticket and confirms it there. Practice trading is spot only, so only bullish setups qualify.
 */
function PractiseThisSetup({
  setup,
  instrument,
  quantity,
}: {
  setup: SetupDetail;
  instrument: Instrument | null;
  quantity: string | null;
}) {
  const { entry, invalidation, target1 } = setup.levels;
  if (setup.direction !== 'bullish')
    return (
      <p className="text-xs text-fg-muted">
        Practice trading buys and sells spot only, so a bearish setup cannot be practised by selling short.
      </p>
    );
  if (!instrument || entry === null || invalidation === null || quantity === null || dec(quantity).lte(0))
    return null;
  const tick = instrument.priceTick;
  return (
    <div className="space-y-1 border-t border-border pt-3">
      <Link
        to="/practice"
        search={{
          instrument: setup.instrumentId,
          setup: setup.id,
          quantity,
          limit: floorToStep(entry, tick),
          stop: floorToStep(invalidation, tick),
          ...(target1 !== null ? { target: floorToStep(target1, tick) } : {}),
        }}
        className="inline-flex h-8 items-center rounded-md border border-practice/60 px-3 text-sm font-medium text-practice hover:bg-practice/10"
      >
        Practise this setup
      </Link>
      <p className="text-xs text-fg-muted">
        Opens a practice order ticket with these levels and this quantity. Nothing is placed until you confirm
        it there. Practice trading is simulated: no real money.
      </p>
    </div>
  );
}

function ChecklistTable({ items, caption }: { items: readonly ChecklistResult[]; caption: string }) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <Th scope="col">Item</Th>
          <Th scope="col">Weight</Th>
          <Th scope="col">Result</Th>
          <Th scope="col">Evidence</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.item} className="border-t border-border" data-item={r.item} data-credit={r.credit}>
            <Td>
              {CHECKLIST_LABELS[r.item]}
              {r.mandatory ? <span className="ml-1 text-xs text-fg-muted">(mandatory)</span> : null}
            </Td>
            <Td className="tabular-nums">{r.weight}</Td>
            <Td>
              <Badge tone={r.credit === 1 ? 'ok' : r.credit === 0.5 ? 'warn' : 'crit'}>
                {creditText(r.credit)}
              </Badge>
            </Td>
            <Td className="text-xs text-fg-muted">{evidenceText(r) || '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ChecklistCard({ setup }: { setup: SetupDetail }) {
  const states = Object.entries(setup.checklistByState) as [keyof typeof STATE_TITLE, ChecklistResult[]][];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Checklist: score {setup.score}
          {setup.mandatoryPassed ? '' : ' (a mandatory item fails)'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ChecklistTable items={setup.checklist} caption="The checklist at the setup's current state" />
        {states.length > 1 ? (
          <details>
            <summary className="cursor-pointer text-sm text-fg-muted">At each state it reached</summary>
            <div className="mt-2 space-y-3">
              {states.map(([state, items]) => (
                <div key={state}>
                  <h3 className="text-sm font-medium">{STATE_TITLE[state]}</h3>
                  <ChecklistTable
                    items={items}
                    caption={`The checklist when the setup was ${STATE_TITLE[state].toLowerCase()}`}
                  />
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TransitionsCard({ setup, timeZone }: { setup: SetupDetail; timeZone: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transitions</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th scope="col">Change</Th>
              <Th scope="col">Reason</Th>
              <Th scope="col">Decided at</Th>
              <Th scope="col">Evidence</Th>
            </tr>
          </thead>
          <tbody>
            {setup.transitions.map((t, i) => (
              <tr key={i} className="border-t border-border">
                <Td className="whitespace-nowrap">
                  {t.from ? `${STATE_TITLE[t.from]} → ` : ''}
                  {STATE_TITLE[t.to]}
                  {t.late ? (
                    <Badge tone="warn" className="ml-2">
                      late
                    </Badge>
                  ) : null}
                </Td>
                <Td>{t.reason.replaceAll('_', ' ')}</Td>
                <Td className="whitespace-nowrap text-xs">{formatInstant(t.decidedAt, timeZone)}</Td>
                <Td className="max-w-md break-all font-mono text-xs text-fg-muted">
                  {JSON.stringify(t.evidence)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OutcomeCard({ setup, timeZone }: { setup: SetupDetail; timeZone: string }) {
  const o = setup.outcome;
  if (!o) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Outcome: {RESOLUTION_TITLE[o.result] ?? o.result}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Fact
            label="Entry reached"
            value={o.entryTouchedAt ? formatInstant(o.entryTouchedAt, timeZone) : 'No'}
          />
          <Fact label="Resolved" value={formatInstant(o.resolvedAt, timeZone)} />
          <Fact label="MFE (R)" value={o.mfeR ?? '—'} />
          <Fact label="MAE (R)" value={o.maeR ?? '—'} />
          <Fact label="Bars held" value={o.barsHeld ?? '—'} />
        </dl>
        {o.resolvedWithTf ? (
          <p className="mt-2 text-xs text-fg-muted">
            One setup candle traded through two outcomes; its 1m candles decided the order.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The setup on its own timeframe, from a little before it formed to a little after it ended. */
function SetupChart({ setup, instrument }: { setup: SetupDetail; instrument: Instrument | null }) {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const tf = setup.setupTf;
  const size = TF_MS[tf];
  const [now] = useState(() => Date.now());
  const from = Math.floor(setup.createdAt / size) * size - BEFORE * size;
  const to = Math.min(
    Math.floor(now / size) * size,
    Math.floor((setup.resolvedAt ?? now) / size) * size + AFTER * size,
  );
  const candles = useQuery({
    queryKey: ['setup-chart', setup.id, 'candles', from, to],
    queryFn: () =>
      client.request<Candle[]>(
        'GET',
        `/api/v1/market/${setup.instrumentId}/candles?tf=${tf}&from=${from}&to=${to}&limit=5000`,
      ),
  });
  const list = useMemo(() => (candles.data ?? []).filter((c) => c.t + size <= to), [candles.data, size, to]);
  const win = list.length ? { from: list[0]!.t, to: list.at(-1)!.t + size } : null;
  const overlay = useQuery({
    queryKey: ['setup-chart', setup.id, 'overlay', win?.from, win?.to],
    queryFn: () =>
      client.request<ChartOverlay>(
        'GET',
        `/api/v1/smc/${setup.instrumentId}/overlay?tf=${tf}&from=${win!.from}&to=${win!.to}&runId=${setup.runId}`,
      ),
    enabled: win !== null,
  });
  const visible = useMemo(() => new Set(OVERLAY_KINDS), []);
  if (candles.isPending) return <Spinner label="Loading the chart" />;
  if (candles.isError)
    return (
      <Alert tone="crit" title="The chart could not be loaded">
        {candles.error.message}
      </Alert>
    );
  return (
    <LiquidityChart
      instrumentId={setup.instrumentId}
      tf={tf}
      candles={list}
      overlay={overlay.data ?? null}
      ready={overlay.isSuccess}
      visible={visible}
      priceTick={instrument?.priceTick ?? '0.01'}
      timeZone={timeZone}
      label={`${instrument?.displayName ?? 'Instrument'}, ${tf} candles around the setup, with its levels and detections`}
    />
  );
}

/** One setup (Phase 7): its levels, the calculator, the checklist, its history and outcome, on its chart. */
export function SetupDetailPage() {
  // Read through `unknown`: the registered route types are circular from inside a route component.
  const params: unknown = useParams({ from: '/setups/$setupId' });
  const raw = (params as { setupId?: unknown } | null)?.setupId;
  const setupId = typeof raw === 'string' ? raw : '';
  const timeZone = useDisplayTimeZone();
  const user = useCurrentUser();
  const instruments = useInstruments();
  const detail = useSetupDetail(setupId, null);
  const setup = detail.data;
  const instrument = setup
    ? ((instruments.data ?? []).find((i) => i.id === setup.instrumentId) ?? null)
    : null;

  if (detail.isPending) return <Spinner label="Loading the setup" />;
  if (detail.isError)
    return (
      <Alert tone="crit" title="The setup could not be loaded">
        {detail.error.message}
      </Alert>
    );
  const s = detail.data;
  const gold = instrument?.underlyingCalendar === 'gold';
  return (
    <div className="max-w-6xl space-y-6" data-setup={s.id}>
      <header className="space-y-2">
        <p className="text-sm">
          <Link to="/setups" className="text-accent underline">
            Setup Scanner
          </Link>
        </p>
        <h1 className="text-xl font-semibold">
          {PATTERN_SHORT[s.pattern]}
          {s.variant ? ` ${s.variant}` : ''}: {PATTERN_TITLE[s.pattern]}, {s.direction}
        </h1>
        <p className="text-sm text-fg-muted">
          {instrument?.displayName ?? s.instrumentId} · context {s.contextTf}, setup {s.setupTf} · formed{' '}
          {formatInstant(s.createdAt, timeZone)} · last change {formatInstant(s.updatedAt, timeZone)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={s.state === 'confirmed' || s.state === 'entry_active' ? 'ok' : 'info'}>
            {s.displayLabel}
          </Badge>
          {s.resolution ? <Badge>{RESOLUTION_TITLE[s.resolution] ?? s.resolution}</Badge> : null}
          {[...s.qualityFlags, ...s.flags].map((f) => (
            <Badge key={f} tone="warn">
              {f.replaceAll('_', ' ')}
            </Badge>
          ))}
        </div>
        <p className="text-sm font-medium text-warn" data-disclaimer="setups">
          All levels are hypothetical. {SETUP_DISCLAIMER}.
        </p>
        {gold ? <PaxgDisclaimer /> : null}
        {can(user.role, 'ai.request') && s.state !== 'resolved' ? (
          <Link
            to="/ai"
            search={{ instrument: s.instrumentId, setup: s.id, reason: 'setup_review' }}
            className="inline-block text-sm text-accent underline"
          >
            Ask Grok to review this setup
          </Link>
        ) : null}
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <LevelsCard setup={s} />
        <CalculatorCard setup={s} instrument={instrument} />
      </div>
      <ChecklistCard setup={s} />
      <OutcomeCard setup={s} timeZone={timeZone} />
      <Card>
        <CardHeader>
          <CardTitle>On the chart</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <SetupChart setup={s} instrument={instrument} />
          <Link
            to="/liquidity"
            search={{ instrument: s.instrumentId, tf: s.setupTf }}
            className="text-sm text-accent underline"
          >
            Open the Liquidity Map
          </Link>
        </CardContent>
      </Card>
      <TransitionsCard setup={s} timeZone={timeZone} />
    </div>
  );
}
