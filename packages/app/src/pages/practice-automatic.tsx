import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import {
  AUTO_SKIP_REASONS,
  AUTO_SKIP_TEXT,
  type AutoDecision,
  type AutoRules,
  AutoRulesSchema,
  type AutoSkipReason,
  type Instrument,
  type Pattern,
  type PracticeOrder,
  type PracticeStrategy,
  REFUSAL_TEXT,
  RefusalReasonSchema,
  type Venue,
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
  Switch,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { PracticeBanner } from '../components/practice-banner.js';
import { formatDecimal } from '../lib/decimal.js';
import { formatInstant } from '../lib/format.js';
import { VENUE_LABEL } from '../lib/market.js';
import { isLiveOrder, signed } from '../lib/practice.js';
import { PATTERN_TITLE, PATTERNS } from '../lib/setups.js';
import { PRACTICE_KEYS, useAutoDecisions, useAutoStrategy } from '../live/practice.js';
import { useDisplayTimeZone, useSession } from '../session.js';

/**
 * Automatic practice trading (Phase 16, REQUIREMENTS §11 revision 5, ADR 022): the user's own rules,
 * the switch, today's figures, the stop button and the decision log. The broker places the orders;
 * this card only changes what the user asked for. Practice balances only.
 */

type NumberField =
  'minScore' | 'minReward' | 'riskPct' | 'maxOpenTrades' | 'maxOrdersPerDay' | 'dailyLossPct';

const NUMBER_FIELDS: Readonly<
  Record<
    NumberField,
    { label: string; min: number; max: number; step: string; whole?: boolean; hint?: string }
  >
> = {
  minScore: { label: 'Lowest checklist score', min: 0, max: 100, step: '1' },
  minReward: {
    label: 'Lowest reward for the risk',
    min: 0.5,
    max: 10,
    step: '0.1',
    hint: 'Target 1’s distance over the stop’s: 2 means it could win twice what it risks.',
  },
  riskPct: {
    label: 'Risk per trade (% of the free balance)',
    min: 0.1,
    max: 2,
    step: '0.1',
    hint: 'The position-size calculator suggests 0.5–1 %. The size is capped at what the free balance buys.',
  },
  maxOpenTrades: { label: 'Open automatic trades at most', min: 1, max: 10, step: '1', whole: true },
  maxOrdersPerDay: { label: 'Automatic orders a day at most', min: 1, max: 50, step: '1', whole: true },
  dailyLossPct: {
    label: 'Daily loss limit (% of the starting balance)',
    min: 1,
    max: 10,
    step: '0.5',
    hint: 'When the day’s closed automatic trades lose this much, it pauses until 00:00 UTC.',
  },
};
const NUMBER_ORDER: readonly NumberField[] = [
  'minScore',
  'minReward',
  'riskPct',
  'maxOpenTrades',
  'maxOrdersPerDay',
  'dailyLossPct',
];

interface RulesDraft extends Record<NumberField, string> {
  venue: Venue;
  instrumentIds: string[];
  patterns: Pattern[];
}

const toDraft = (r: AutoRules): RulesDraft => ({
  venue: r.venue,
  instrumentIds: [...r.instrumentIds],
  patterns: [...r.patterns],
  minScore: String(r.minScore),
  minReward: String(r.minReward),
  riskPct: String(r.riskPct),
  maxOpenTrades: String(r.maxOpenTrades),
  maxOrdersPerDay: String(r.maxOrdersPerDay),
  dailyLossPct: String(r.dailyLossPct),
});

const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

/** The rules from the form, or a message per field that is out of bounds. */
function fromDraft(d: RulesDraft): { rules: AutoRules } | { errors: Partial<Record<string, string>> } {
  const parsed = AutoRulesSchema.safeParse({
    venue: d.venue,
    instrumentIds: d.instrumentIds,
    patterns: d.patterns,
    ...Object.fromEntries(NUMBER_ORDER.map((f) => [f, num(d[f])])),
  });
  if (parsed.success) return { rules: parsed.data };
  const errors: Partial<Record<string, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '');
    if (field in NUMBER_FIELDS) {
      const f = NUMBER_FIELDS[field as NumberField];
      errors[field] = `From ${f.min} to ${f.max}${f.whole ? ', a whole number' : ''}.`;
    } else if (field === 'patterns') errors[field] = 'Choose at least one pattern.';
    else errors[field] ??= issue.message;
  }
  return { errors };
}

const sameRules = (a: RulesDraft, b: RulesDraft) => JSON.stringify(a) === JSON.stringify(b);

const CANCEL_TEXT: Record<string, string> = {
  invalidated: 'The setup was invalidated before the buy filled.',
  expired_no_entry: 'The setup expired before its entry was reached.',
  expired: 'The setup expired.',
  expired_open: 'The setup expired.',
  target_reached: 'The setup reached its target before the buy filled.',
  ambiguous: 'The setup ended without a clear outcome.',
  stopped: 'You stopped automatic trading.',
};

const OUTCOME: Record<AutoDecision['outcome'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  placed: { label: 'Placed', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  refused: { label: 'Refused', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Why, in words. */
export function decisionText(d: Pick<AutoDecision, 'outcome' | 'reason'>): string {
  if (d.outcome === 'placed') return 'Matched your rules.';
  const reason = d.reason ?? '';
  if (d.outcome === 'skipped')
    return (AUTO_SKIP_REASONS as readonly string[]).includes(reason)
      ? AUTO_SKIP_TEXT[reason as AutoSkipReason]
      : reason;
  if (d.outcome === 'refused') {
    const r = RefusalReasonSchema.safeParse(reason);
    return r.success ? `The order checks refused it: ${REFUSAL_TEXT[r.data]}` : reason;
  }
  return CANCEL_TEXT[reason] ?? reason;
}

/** What the last action came to: kept by the card, as a saved change re-creates the form. */
interface Result {
  tone: 'ok' | 'warn' | 'crit';
  title: string;
  body?: string;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function AutomaticTradingCard({
  instruments,
  venues,
  openOrders,
  onAnnounce,
}: {
  /** The practice pairs (monitored and enabled). */
  instruments: readonly Instrument[];
  /** Venues with a practice account and practice pairs. */
  venues: readonly Venue[];
  openOrders: readonly PracticeOrder[];
  onAnnounce: (t: string) => void;
}) {
  const strategy = useAutoStrategy();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <Card aria-labelledby="auto-title" data-automatic="">
      <CardHeader>
        <CardTitle id="auto-title">Automatic trading (simulated)</CardTitle>
        {strategy.data ? <AutoStatus strategy={strategy.data} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <PracticeBanner />
        <p className="text-sm text-fg-muted">
          When it is on, the platform places practice orders for you: on each confirmed bullish setup that
          matches your rules, a limit buy at the setup&apos;s entry, with a stop at its invalidation and a
          target at its first target, sized by the position-size calculator. Practice balances only: no real
          money, and nothing reaches an exchange. The AI never decides an order. Simulated results are not a
          guide to what real trading would return.
        </p>
        {strategy.isPending ? (
          <Spinner label="Loading your automatic trading" />
        ) : strategy.isError ? (
          <Alert tone="crit" title="Your automatic trading could not be loaded">
            {strategy.error.message}
          </Alert>
        ) : (
          <AutomaticBody
            key={strategy.data.version}
            strategy={strategy.data}
            instruments={instruments}
            venues={venues}
            liveAutoOrders={openOrders.filter((o) => o.source === 'auto' && isLiveOrder(o)).length}
            onAnnounce={onAnnounce}
            onResult={setResult}
          />
        )}
        {result ? (
          <Alert tone={result.tone} title={result.title}>
            {result.body}
          </Alert>
        ) : null}
        <DecisionLog instruments={instruments} />
      </CardContent>
    </Card>
  );
}

function AutoStatus({ strategy: s }: { strategy: PracticeStrategy }) {
  if (s.enabled && s.pausedUntil !== null) return <StatusBadge tone="warn" label="Paused for today" />;
  if (s.enabled) return <StatusBadge tone="ok" label="On" />;
  return <Badge>Off</Badge>;
}

function AutomaticBody({
  strategy: s,
  instruments,
  venues,
  liveAutoOrders,
  onAnnounce,
  onResult: setResult,
}: {
  strategy: PracticeStrategy;
  instruments: readonly Instrument[];
  venues: readonly Venue[];
  liveAutoOrders: number;
  onAnnounce: (t: string) => void;
  onResult: (r: Result | null) => void;
}) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const saved = toDraft(s.rules);
  const [draft, setDraft] = useState<RulesDraft>(saved);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [confirming, setConfirming] = useState<'on' | 'stop' | null>(null);
  const [busy, setBusy] = useState<'save' | 'on' | 'off' | 'stop' | null>(null);
  const ids = useId();
  const dirty = !sameRules(draft, saved);
  const venuePairs = instruments.filter((i) => i.venue === draft.venue);
  const savedPairs = instruments.filter((i) => s.rules.instrumentIds.includes(i.id));

  const settle = (next: PracticeStrategy) => {
    queryClient.setQueryData(PRACTICE_KEYS.automatic, next);
    void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.decisions });
  };
  const failed = (err: unknown, title: string) => {
    if (err instanceof ApiError && err.status === 409) {
      setResult({
        tone: 'warn',
        title: 'Changed in another tab or device',
        body: 'Your automatic trading was changed elsewhere and has been loaded again. Check it, then try again.',
      });
      void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.automatic });
      return;
    }
    setResult({ tone: 'crit', title, body: errorText(err, 'Please try again.') });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    const built = fromDraft(draft);
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setBusy('save');
    try {
      settle(
        await client.request<PracticeStrategy>('PUT', '/api/v1/practice/automatic', {
          version: s.version,
          rules: built.rules,
        }),
      );
      onAnnounce('Automatic trading rules saved.');
    } catch (err) {
      failed(err, 'The rules could not be saved');
    } finally {
      setBusy(null);
    }
  };

  const switchOn = async () => {
    setResult(null);
    setBusy('on');
    try {
      settle(
        await client.request<PracticeStrategy>('POST', '/api/v1/practice/automatic/on', {
          version: s.version,
        }),
      );
      onAnnounce('Automatic practice trading is on.');
    } catch (err) {
      setConfirming(null);
      failed(err, 'Automatic trading could not be switched on');
    } finally {
      setBusy(null);
    }
  };

  const switchOff = async () => {
    setResult(null);
    setBusy('off');
    try {
      settle(await client.request<PracticeStrategy>('POST', '/api/v1/practice/automatic/off'));
      onAnnounce(
        'Automatic practice trading is off. Its working orders stay until they fill, or their setups end.',
      );
    } catch (err) {
      failed(err, 'Automatic trading could not be switched off');
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setResult(null);
    setBusy('stop');
    try {
      const res = await client.requestWithStatus<PracticeStrategy>('POST', '/api/v1/practice/automatic/stop');
      settle(res.body);
      void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.open });
      const done = res.status === 200;
      setResult({
        tone: 'ok',
        title: done ? 'Stopped' : 'Stopping',
        body: done
          ? 'Automatic trading is off and its orders are cancelled. What it bought stays in your practice balance.'
          : 'Automatic trading is off; its orders are being cancelled. What it bought stays in your practice balance.',
      });
      onAnnounce(
        done ? 'Automatic trading stopped; its orders are cancelled.' : 'Automatic trading stopping.',
      );
      setConfirming(null);
    } catch (err) {
      failed(err, 'Automatic trading could not be stopped');
    } finally {
      setBusy(null);
    }
  };

  const pairsText = savedPairs.length
    ? savedPairs.map((i) => `${i.base}/${i.quote}`).join(', ')
    : `every practice pair on ${VENUE_LABEL[s.rules.venue]}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          id={`${ids}-switch`}
          checked={s.enabled}
          disabled={busy !== null || (!s.enabled && dirty)}
          onCheckedChange={(on) => {
            if (on) setConfirming('on');
            else void switchOff();
          }}
        />
        <Label htmlFor={`${ids}-switch`}>Automatic practice trading</Label>
        {!s.enabled && dirty ? (
          <span className="text-xs text-fg-muted">Save or undo your changes to switch it on.</span>
        ) : null}
        {s.enabled || liveAutoOrders > 0 ? (
          <Button
            size="sm"
            variant="danger"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() => setConfirming('stop')}
          >
            Stop and cancel its orders
          </Button>
        ) : null}
      </div>

      {confirming === 'on' ? (
        <div
          className="space-y-2 rounded-md border border-practice/50 p-3"
          role="group"
          aria-label="Switch on automatic practice trading"
        >
          <p className="text-sm">
            Switch on automatic practice trading? On confirmed bullish setups ({pairsText};{' '}
            {s.rules.patterns.length === PATTERNS.length
              ? 'every pattern'
              : s.rules.patterns.map((p) => PATTERN_TITLE[p]).join(', ')}
            ; score {s.rules.minScore} or more; reward at least {s.rules.minReward} times the risk), it places
            practice limit buys on your {VENUE_LABEL[s.rules.venue]} practice account, each risking{' '}
            {s.rules.riskPct} % of the free balance, with a stop and a target. At most {s.rules.maxOpenTrades}{' '}
            open at once and {s.rules.maxOrdersPerDay} a day; it pauses until 00:00 UTC once the day&apos;s
            closed trades lose {s.rules.dailyLossPct} % of the starting balance. You can stop it at any time.
          </p>
          <div className="flex gap-2">
            <Button size="sm" busy={busy === 'on'} onClick={() => void switchOn()}>
              Switch on
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => setConfirming(null)}
            >
              Keep it off
            </Button>
          </div>
        </div>
      ) : null}
      {confirming === 'stop' ? (
        <div
          className="space-y-2 rounded-md border border-warn/40 p-3"
          role="group"
          aria-label="Stop automatic practice trading"
        >
          <p className="text-sm">
            Stop automatic practice trading? It switches off, and its{' '}
            {liveAutoOrders === 1 ? 'working order is' : `${liveAutoOrders} working orders are`} cancelled,
            stops and targets included. What it bought stays in your practice balance.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" busy={busy === 'stop'} onClick={() => void stop()}>
              Stop it
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => setConfirming(null)}
            >
              Keep it running
            </Button>
          </div>
        </div>
      ) : null}

      {s.enabled && s.pausedUntil !== null ? (
        <Alert tone="warn" title="Paused for today">
          Today&apos;s closed automatic trades reached your daily loss limit of {s.rules.dailyLossPct} %. It
          places nothing more until {formatInstant(s.pausedUntil)}.
        </Alert>
      ) : null}
      <p className="text-sm" data-auto-today="">
        Today, since 00:00 UTC: {s.today.orders} automatic {s.today.orders === 1 ? 'buy' : 'buys'} placed; its
        closed trades come to{' '}
        <span className="font-mono">
          {signed(s.today.result)} {s.today.asset}
        </span>{' '}
        (simulated).
      </p>

      <form
        onSubmit={(e) => void save(e)}
        className="space-y-4"
        aria-label="Automatic trading rules"
        noValidate
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-venue`}>Practice account</Label>
            <Select
              id={`${ids}-venue`}
              value={draft.venue}
              onChange={(e) => setDraft({ ...draft, venue: e.target.value as Venue, instrumentIds: [] })}
            >
              {venues.map((v) => (
                <option key={v} value={v}>
                  {VENUE_LABEL[v]}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Pairs</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {venuePairs.map((i) => (
                <label key={i.id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={draft.instrumentIds.includes(i.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        instrumentIds: e.target.checked
                          ? [...draft.instrumentIds, i.id]
                          : draft.instrumentIds.filter((x) => x !== i.id),
                      })
                    }
                  />
                  {i.base}/{i.quote}
                </label>
              ))}
            </div>
            <p className="text-xs text-fg-muted">None ticked: every practice pair on this account.</p>
          </fieldset>
        </div>
        <fieldset
          className="space-y-1"
          aria-describedby={errors['patterns'] ? `${ids}-patterns-error` : undefined}
        >
          <legend className="text-sm font-medium">Patterns</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {PATTERNS.map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={draft.patterns.includes(p)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      patterns: e.target.checked
                        ? PATTERNS.filter((x) => x === p || draft.patterns.includes(x))
                        : draft.patterns.filter((x) => x !== p),
                    })
                  }
                />
                {PATTERN_TITLE[p]}
              </label>
            ))}
          </div>
          {errors['patterns'] ? (
            <p id={`${ids}-patterns-error`} className="text-xs text-crit">
              {errors['patterns']}
            </p>
          ) : null}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBER_ORDER.map((field) => {
            const f = NUMBER_FIELDS[field];
            const id = `${ids}-${field}`;
            const error = errors[field];
            return (
              <div key={field} className="space-y-1">
                <Label htmlFor={id}>{f.label}</Label>
                <Input
                  id={id}
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  inputMode="decimal"
                  value={draft[field]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={
                    [error ? `${id}-error` : null, f.hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
                    undefined
                  }
                  onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                />
                {f.hint ? (
                  <p id={`${id}-hint`} className="text-xs text-fg-muted">
                    {f.hint}
                  </p>
                ) : null}
                {error ? (
                  <p id={`${id}-error`} className="text-xs text-crit">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Button
            type="submit"
            busy={busy === 'save'}
            disabled={!dirty || (busy !== null && busy !== 'save')}
          >
            Save rules
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setDraft(saved);
                setErrors({});
              }}
            >
              Undo changes
            </Button>
          ) : null}
        </div>
        {s.enabled && dirty ? (
          <p className="text-xs text-fg-muted">Saved rules apply to the next setups it decides on.</p>
        ) : null}
      </form>
    </div>
  );
}

function DecisionLog({ instruments }: { instruments: readonly Instrument[] }) {
  const decisions = useAutoDecisions();
  const timeZone = useDisplayTimeZone();
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const items = decisions.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby="auto-log-title" className="space-y-2">
      <h3 id="auto-log-title" className="font-medium">
        Decisions
      </h3>
      {decisions.isPending ? (
        <Spinner label="Loading the decisions" />
      ) : decisions.isError ? (
        <Alert tone="crit" title="The decisions could not be loaded">
          {decisions.error.message}
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No decisions yet. Each confirmed bullish setup it considers while on is listed here, placed or
          skipped, with the reason.
        </p>
      ) : (
        <>
          <Table>
            <caption className="sr-only">Automatic trading decisions, newest first</caption>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Pair</Th>
                <Th>Pattern</Th>
                <Th>Outcome</Th>
                <Th>Why</Th>
                <Th>Order</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const i = byId.get(d.instrumentId);
                const o = OUTCOME[d.outcome];
                return (
                  <tr key={d.id} data-decision={d.outcome}>
                    <Td>{formatInstant(d.decidedAt, timeZone)}</Td>
                    <Td>{i ? `${i.base}/${i.quote}` : d.instrumentId}</Td>
                    <Td>{PATTERN_TITLE[d.pattern]}</Td>
                    <Td>
                      <Badge tone={o.tone}>{o.label}</Badge>
                    </Td>
                    <Td className="text-sm">{decisionText(d)}</Td>
                    <Td className="font-mono text-sm">
                      {d.order
                        ? `Buy ${formatDecimal(d.order.quantity)} at ${formatDecimal(d.order.limitPrice)}${d.order.stop ? `, stop ${formatDecimal(d.order.stop)}` : ''}${d.order.target ? `, target ${formatDecimal(d.order.target)}` : ''}`
                        : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {decisions.hasNextPage ? (
            <Button
              size="sm"
              variant="secondary"
              busy={decisions.isFetchingNextPage}
              onClick={() => void decisions.fetchNextPage()}
            >
              Show older decisions
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
