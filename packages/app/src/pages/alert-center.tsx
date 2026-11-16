import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type AlertCondition,
  type AlertConditionKind,
  type AlertEvent,
  type AlertRule,
  type AlertRuleTestResult,
  CreateAlertRuleRequestSchema,
  FEED_HEALTH_EVENTS,
  type Notification,
  type Page,
  PATTERN_NAMES,
  SETUP_STATES,
  SMC_ALERT_EVENTS,
  TIMEFRAMES,
  UpdateAlertRuleRequestSchema,
  WALL_EVENTS,
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
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import {
  ALERT_RULES_KEY as RULES_KEY,
  defaultCondition,
  describeCondition,
  describeDelivery,
  KIND_LABELS,
  KINDS,
  watchesInstruments,
} from '../lib/alert-rules.js';
import { formatInstant } from '../lib/format.js';
import { PATTERN_SHORT, STATE_TITLE } from '../lib/setups.js';
import { useAlerts } from '../live/alerts.js';
import { useDisplayTimeZone, useSession } from '../session.js';

const SEVERITY_TONE = { info: 'info', warning: 'warn', critical: 'crit' } as const;

/**
 * The Alert Center (REQUIREMENTS §6 and §8; Phase 8): the user's rules, with a dry run over the last
 * 24 hours, the inbox, and every alert their rules fired. Rules are personal; alerts describe what the
 * platform recorded and never predict anything.
 */
export function AlertCenterPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-fg">Alert Center</h1>
        <p className="text-sm text-fg-muted">
          Your alert rules and the alerts they fired. Every alert reaches the inbox; desktop and browser
          notifications appear while the app is open, outside each rule’s quiet hours.
        </p>
      </header>
      <NotificationPermission />
      <RulesCard />
      <InboxCard />
      <HistoryCard />
    </div>
  );
}

function NotificationPermission() {
  const { platform } = useSession();
  const [permission, setPermission] = useState<string | null>(null);
  const read = platform.notificationPermission;
  const request = platform.requestNotificationPermission;
  const [checked, setChecked] = useState(false);
  if (!read || !request) return null;
  if (!checked) {
    setChecked(true);
    void read().then(setPermission);
  }
  if (permission === null || permission === 'granted' || permission === 'unsupported') return null;
  const where = platform.kind === 'desktop' ? 'desktop' : 'browser';
  return (
    <Alert tone="info" title={`${where === 'desktop' ? 'Desktop' : 'Browser'} notifications are off`}>
      {permission === 'denied' ? (
        <>
          Your {where} blocks them; allow notifications for this app in its settings to see alerts as they
          fire.
        </>
      ) : (
        <>
          Allow them to see alerts as they fire.{' '}
          <Button size="sm" variant="secondary" onClick={() => void request().then(setPermission)}>
            Allow {where} notifications
          </Button>
        </>
      )}
    </Alert>
  );
}

// ── rules ─────────────────────────────────────────────────────────────────────────────────────────

function RulesCard() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: RULES_KEY,
    queryFn: () => client.request<AlertRule[]>('GET', '/api/v1/alerts/rules'),
  });
  const instruments = useInstruments();
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, AlertRuleTestResult | 'running'>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = new Map((instruments.data ?? []).map((i) => [i.id, i.displayName]));
  const refresh = () => queryClient.invalidateQueries({ queryKey: RULES_KEY });

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card aria-labelledby="rules-title">
      <CardHeader className="flex items-center justify-between">
        <CardTitle id="rules-title">Your rules</CardTitle>
        <Button size="sm" onClick={() => setEditing('new')} disabled={editing !== null}>
          New rule
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert tone="crit" title="That did not work">
            {error}
          </Alert>
        ) : null}
        {editing !== null ? (
          <RuleForm
            rule={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void refresh();
            }}
          />
        ) : null}
        {rules.isPending ? (
          <Spinner label="Loading rules" />
        ) : !rules.data?.length ? (
          <p className="text-sm text-fg-muted">
            No rules yet. A rule watches for one kind of event and alerts you.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rules.data.map((r) => {
              const test = tests[r.id];
              return (
                <li key={r.id} data-rule-id={r.id} data-kind={r.condition.kind} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium text-fg">
                        {r.name} <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>{' '}
                        {r.enabled ? null : <Badge tone="neutral">paused</Badge>}
                      </p>
                      <p className="text-sm text-fg-muted">
                        {describeCondition(r.condition)}
                        {watchesInstruments(r.condition.kind)
                          ? ` · ${r.scope.instrumentIds ? r.scope.instrumentIds.map((id) => names.get(id) ?? 'removed instrument').join(', ') : 'all instruments'}`
                          : ''}
                      </p>
                      <p className="text-xs text-fg-muted">
                        {describeDelivery(r)} · cooldown {Math.round(r.cooldownSec / 60)} min
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`}
                        onClick={() =>
                          void act(() =>
                            client.request('PATCH', `/api/v1/alerts/rules/${r.id}`, {
                              version: r.version,
                              enabled: !r.enabled,
                            }),
                          )
                        }
                      >
                        {r.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Edit ${r.name}`}
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Test ${r.name} on the last 24 hours`}
                        disabled={test === 'running'}
                        onClick={() => {
                          setTests((t) => ({ ...t, [r.id]: 'running' }));
                          void client
                            .request<AlertRuleTestResult>(
                              'POST',
                              `/api/v1/alerts/rules/${r.id}/test?hours=24`,
                            )
                            .then((result) => setTests((t) => ({ ...t, [r.id]: result })))
                            .catch((err: unknown) => {
                              setTests(({ [r.id]: _, ...rest }) => rest);
                              setError(err instanceof Error ? err.message : String(err));
                            });
                        }}
                      >
                        Test 24 h
                      </Button>
                      {removing === r.id ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() =>
                            void act(async () => {
                              await client.request('DELETE', `/api/v1/alerts/rules/${r.id}`);
                              setRemoving(null);
                            })
                          }
                        >
                          Confirm removal
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${r.name}`}
                          onClick={() => setRemoving(r.id)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                  {test === 'running' ? <Spinner label="Testing on the last 24 hours" /> : null}
                  {test && test !== 'running' ? <TestResult result={test} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TestResult({ result }: { result: AlertRuleTestResult }) {
  const timeZone = useDisplayTimeZone();
  const n = result.wouldHaveFired.length;
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3 text-sm" data-test-result={n}>
      <p className="text-fg">
        Over the last 24 hours this rule would have fired {n === 1 ? 'once' : `${n} times`}
        {result.suppressed ? ` (${result.suppressed} more dropped by its cooldown)` : ''}, from{' '}
        {result.evaluated} events checked.
      </p>
      {result.note ? <p className="text-xs text-fg-muted">{result.note}</p> : null}
      {n ? (
        <ul className="mt-2 space-y-1">
          {result.wouldHaveFired.slice(0, 20).map((m) => (
            <li key={m.dedupeKey} className="text-fg-muted">
              {formatInstant(m.at, timeZone)} · {m.title}
            </li>
          ))}
          {n > 20 ? <li className="text-fg-muted">… and {n - 20} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

interface Draft {
  name: string;
  condition: AlertCondition;
  instrumentIds: string[] | null;
  severity: AlertRule['severity'];
  cooldownMin: string;
  desktop: boolean;
  web: boolean;
  quiet: { on: boolean; start: string; end: string; timeZone: string };
  enabled: boolean;
}

function draftOf(rule: AlertRule | null, timeZone: string): Draft {
  return {
    name: rule?.name ?? '',
    condition: rule?.condition ?? defaultCondition('setup_transition'),
    instrumentIds: rule?.scope.instrumentIds ?? null,
    severity: rule?.severity ?? 'info',
    cooldownMin: String(Math.round((rule?.cooldownSec ?? 300) / 60)),
    desktop: rule ? rule.channels.includes('desktop') : true,
    web: rule ? rule.channels.includes('web') : true,
    quiet: rule?.quietHours
      ? { on: true, ...rule.quietHours }
      : { on: false, start: '22:00', end: '07:00', timeZone },
    enabled: rule?.enabled ?? true,
  };
}

function RuleForm({ rule, onDone }: { rule: AlertRule | null; onDone: () => void }) {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule, timeZone));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async () => {
    const body = {
      name: draft.name,
      enabled: draft.enabled,
      scope:
        watchesInstruments(draft.condition.kind) && draft.instrumentIds?.length
          ? { instrumentIds: draft.instrumentIds }
          : {},
      condition: draft.condition,
      severity: draft.severity,
      cooldownSec: Math.round(Number(draft.cooldownMin) * 60),
      channels: [
        'in_app' as const,
        ...(draft.desktop ? (['desktop'] as const) : []),
        ...(draft.web ? (['web'] as const) : []),
      ],
      quietHours: draft.quiet.on
        ? { start: draft.quiet.start, end: draft.quiet.end, timeZone: draft.quiet.timeZone }
        : null,
    };
    const parsed = rule
      ? UpdateAlertRuleRequestSchema.safeParse({ version: rule.version, ...body })
      : CreateAlertRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.') || 'rule'}: ${i.message}`));
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      if (rule) await client.request('PATCH', `/api/v1/alerts/rules/${rule.id}`, parsed.data);
      else await client.request('POST', '/api/v1/alerts/rules', parsed.data);
      onDone();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={rule ? `Edit ${rule.name}` : 'New alert rule'}
      className="space-y-4 rounded-md border border-border-strong bg-surface-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rule-name">Name</Label>
          <Input
            id="rule-name"
            value={draft.name}
            maxLength={100}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-kind">Alert me on</Label>
          <Select
            id="rule-kind"
            value={draft.condition.kind}
            onChange={(e) => set('condition', defaultCondition(e.target.value as AlertConditionKind))}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-fg-muted">Condition</legend>
        <ConditionFields condition={draft.condition} onChange={(c) => set('condition', c)} />
      </fieldset>
      {watchesInstruments(draft.condition.kind) ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg-muted">Instruments</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.instrumentIds === null}
              onChange={(e) => set('instrumentIds', e.target.checked ? null : [])}
            />
            All instruments
          </label>
          {draft.instrumentIds !== null ? (
            <div className="grid gap-1 sm:grid-cols-2">
              {(instruments.data ?? []).map((i) => (
                <label key={i.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.instrumentIds?.includes(i.id) ?? false}
                    onChange={(e) =>
                      set(
                        'instrumentIds',
                        e.target.checked
                          ? [...(draft.instrumentIds ?? []), i.id]
                          : (draft.instrumentIds ?? []).filter((x) => x !== i.id),
                      )
                    }
                  />
                  {i.displayName}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="rule-severity">Severity</Label>
          <Select
            id="rule-severity"
            value={draft.severity}
            onChange={(e) => set('severity', e.target.value as Draft['severity'])}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-cooldown">Cooldown (minutes)</Label>
          <Input
            id="rule-cooldown"
            type="number"
            min={0}
            max={1440}
            value={draft.cooldownMin}
            onChange={(e) => set('cooldownMin', e.target.value)}
          />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-fg-muted">Notify me</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={draft.desktop} onChange={(e) => set('desktop', e.target.checked)} /> In the
            desktop app
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={draft.web} onChange={(e) => set('web', e.target.checked)} /> In the browser
          </label>
        </fieldset>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg-muted">Quiet hours</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.quiet.on}
            onChange={(e) => set('quiet', { ...draft.quiet, on: e.target.checked })}
          />
          No desktop or browser notifications between
        </label>
        {draft.quiet.on ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="quiet-start">From</Label>
              <Input
                id="quiet-start"
                type="time"
                value={draft.quiet.start}
                onChange={(e) => set('quiet', { ...draft.quiet, start: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiet-end">To</Label>
              <Input
                id="quiet-end"
                type="time"
                value={draft.quiet.end}
                onChange={(e) => set('quiet', { ...draft.quiet, end: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiet-tz">Time zone</Label>
              <Input
                id="quiet-tz"
                value={draft.quiet.timeZone}
                onChange={(e) => set('quiet', { ...draft.quiet, timeZone: e.target.value })}
              />
            </div>
          </div>
        ) : null}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Active
      </label>
      {errors.length ? (
        <Alert tone="crit" title="Check the rule">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Checks<T extends string>({
  legend,
  options,
  selected,
  label = (v) => v,
  onChange,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly T[] | undefined;
  label?: (v: T) => string;
  onChange: (next: T[] | undefined) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm text-fg-muted">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={selected?.includes(o) ?? false}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...(selected ?? []), o]
                  : (selected ?? []).filter((x) => x !== o);
                onChange(next.length ? next : undefined);
              }}
            />
            {label(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  step = 'any',
}: {
  id: string;
  label: string;
  value: number | string | undefined;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** The fields of one condition kind; the contract validates them on submit. */
function ConditionFields({
  condition: c,
  onChange,
}: {
  condition: AlertCondition;
  onChange: (c: AlertCondition) => void;
}) {
  const num = (v: string) => (v === '' ? Number.NaN : Number(v));
  const STRUCTURE_TFS = TIMEFRAMES.filter((tf) => tf !== '1m');
  switch (c.kind) {
    case 'price_cross':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="c-direction">Direction</Label>
            <Select
              id="c-direction"
              value={c.direction}
              onChange={(e) => onChange({ ...c, direction: e.target.value as 'above' | 'below' })}
            >
              <option value="above">Crosses above</option>
              <option value="below">Crosses below</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-price">Price</Label>
            <Input
              id="c-price"
              inputMode="decimal"
              value={c.price}
              onChange={(e) => onChange({ ...c, price: e.target.value.trim() })}
            />
          </div>
        </div>
      );
    case 'price_change_pct':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            id="c-pct"
            label="Move (%, either way)"
            value={c.pct}
            onChange={(v) => onChange({ ...c, pct: num(v) })}
          />
          <NumberField
            id="c-window"
            label="Within (minutes)"
            step="1"
            value={c.windowMin}
            onChange={(v) => onChange({ ...c, windowMin: num(v) })}
          />
        </div>
      );
    case 'indicator_threshold':
      return (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="c-tf">Timeframe</Label>
            <Select
              id="c-tf"
              value={c.tf}
              onChange={(e) => onChange({ ...c, tf: e.target.value as typeof c.tf })}
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf}>{tf}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-indicator">Indicator</Label>
            <Select
              id="c-indicator"
              value={c.indicator}
              onChange={(e) => onChange({ ...c, indicator: e.target.value as typeof c.indicator })}
            >
              <option value="rsi">RSI</option>
              <option value="macd_hist">MACD histogram</option>
              <option value="volume_z">Volume z-score</option>
              <option value="atr">ATR</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-op">When it is</Label>
            <Select
              id="c-op"
              value={c.op}
              onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}
            >
              <option value=">">above</option>
              <option value="<">below</option>
              <option value="cross_above">crosses above</option>
              <option value="cross_below">crosses below</option>
            </Select>
          </div>
          <NumberField
            id="c-value"
            label="Value"
            value={c.value}
            onChange={(v) => onChange({ ...c, value: num(v) })}
          />
        </div>
      );
    case 'volume_anomaly':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="c-tf">Timeframe</Label>
            <Select
              id="c-tf"
              value={c.tf}
              onChange={(e) => onChange({ ...c, tf: e.target.value as typeof c.tf })}
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf}>{tf}</option>
              ))}
            </Select>
          </div>
          <NumberField
            id="c-z"
            label="Volume z-score at least"
            value={c.minZ}
            onChange={(v) => onChange({ ...c, minZ: num(v) })}
          />
        </div>
      );
    case 'smc_event':
      return (
        <div className="space-y-2">
          <Checks
            legend="Events"
            options={SMC_ALERT_EVENTS}
            selected={c.events}
            label={(e) =>
              ({
                sweep: 'Sweep',
                false_breakout: 'False breakout',
                bos: 'BOS',
                choch: 'CHOCH',
                mss: 'MSS',
                poi_entry: 'POI entry',
              })[e]
            }
            onChange={(v) => onChange({ ...c, events: v ?? [] })}
          />
          <Checks
            legend="Timeframes"
            options={STRUCTURE_TFS}
            selected={c.tfs}
            onChange={(v) => onChange({ ...c, tfs: v ?? [] })}
          />
        </div>
      );
    case 'setup_transition':
      return (
        <div className="space-y-2">
          <Checks
            legend="When a setup becomes"
            options={SETUP_STATES}
            selected={c.toStates}
            label={(s) => STATE_TITLE[s]}
            onChange={(v) => onChange({ ...c, toStates: v ?? [] })}
          />
          <Checks
            legend="Patterns (none: all)"
            options={PATTERN_NAMES}
            selected={c.patterns}
            label={(p) => PATTERN_SHORT[p]}
            onChange={(v) => onChange({ ...c, patterns: v })}
          />
          <Checks
            legend="Directions (none: both)"
            options={['bullish', 'bearish'] as const}
            selected={c.directions}
            onChange={(v) => onChange({ ...c, directions: v })}
          />
          <NumberField
            id="c-score"
            label="Score at least (optional)"
            step="1"
            value={c.minScore}
            onChange={(v) => onChange({ ...c, minScore: v === '' ? undefined : num(v) })}
          />
        </div>
      );
    case 'spread_threshold':
      return (
        <NumberField
          id="c-bps"
          label="Spread beyond (basis points, either way)"
          value={c.absBps}
          onChange={(v) => onChange({ ...c, absBps: num(v) })}
        />
      );
    case 'economic_event_upcoming':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="c-impact">Impact</Label>
            <Select
              id="c-impact"
              value={c.minImpact}
              onChange={(e) => onChange({ ...c, minImpact: e.target.value as 'medium' | 'high' })}
            >
              <option value="high">High</option>
              <option value="medium">Medium or high</option>
            </Select>
          </div>
          <NumberField
            id="c-lead"
            label="Minutes before"
            step="1"
            value={c.minutesBefore}
            onChange={(v) => onChange({ ...c, minutesBefore: num(v) })}
          />
        </div>
      );
    case 'gold_market_session':
      return (
        <Checks
          legend="When the gold market"
          options={['open', 'close'] as const}
          selected={c.on}
          label={(o) => (o === 'open' ? 'opens' : 'closes')}
          onChange={(v) => onChange({ ...c, on: v ?? [] })}
        />
      );
    case 'large_trade':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="c-usd">At least (USD, optional)</Label>
            <Input
              id="c-usd"
              inputMode="decimal"
              value={c.minUsd ?? ''}
              onChange={(e) => onChange({ ...c, minUsd: e.target.value.trim() || undefined })}
            />
          </div>
          <Checks
            legend="Sides (none: both)"
            options={['buy', 'sell'] as const}
            selected={c.sides}
            onChange={(v) => onChange({ ...c, sides: v })}
          />
        </div>
      );
    case 'wall':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Checks
            legend="When a wall"
            options={WALL_EVENTS}
            selected={c.events}
            onChange={(v) => onChange({ ...c, events: v ?? [] })}
          />
          <div className="space-y-1">
            <Label htmlFor="c-usd">At least (USD, optional)</Label>
            <Input
              id="c-usd"
              inputMode="decimal"
              value={c.minUsd ?? ''}
              onChange={(e) => onChange({ ...c, minUsd: e.target.value.trim() || undefined })}
            />
          </div>
        </div>
      );
    case 'feed_health':
      return (
        <Checks
          legend="Feed events"
          options={FEED_HEALTH_EVENTS}
          selected={c.events}
          onChange={(v) => onChange({ ...c, events: v ?? [] })}
        />
      );
    case 'practice_order_filled':
      return (
        <p className="text-sm text-fg-muted">
          When one of your own practice buys or sells has filled. Practice trading is simulated: no real
          money, and no order reaches an exchange.
        </p>
      );
    case 'practice_exit':
      return (
        <Checks
          legend="When your practice order's"
          options={['stop', 'target'] as const}
          selected={c.on}
          onChange={(v) => onChange({ ...c, on: v ?? [] })}
        />
      );
    case 'practice_auto_order':
      return (
        <p className="text-sm text-fg-muted">
          When your automatic practice trading places a buy, with its stop and target, on a setup that matched
          your rules. Practice trading is simulated: no real money, and no order reaches an exchange.
        </p>
      );
    case 'practice_auto_paused':
      return (
        <p className="text-sm text-fg-muted">
          When your automatic practice trading reaches your daily loss limit and pauses until 00:00 UTC.
          Simulated: no real money.
        </p>
      );
  }
}

// ── inbox and history ─────────────────────────────────────────────────────────────────────────────

function InboxCard() {
  const { unread, items, loaded, markRead, markAllRead } = useAlerts();
  const timeZone = useDisplayTimeZone();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const shown = onlyUnread ? items.filter((n) => n.readAt === null) : items;
  return (
    <Card aria-labelledby="inbox-title">
      <CardHeader className="flex items-center justify-between">
        <CardTitle id="inbox-title">
          Inbox <span className="text-sm font-normal text-fg-muted">({unread} unread)</span>
        </CardTitle>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Unread only
          </label>
          <Button size="sm" variant="secondary" disabled={unread === 0} onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <Spinner label="Loading the inbox" />
        ) : shown.length === 0 ? (
          <p className="text-sm text-fg-muted">{onlyUnread ? 'Nothing unread.' : 'No alerts yet.'}</p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Inbox">
            {shown.map((n) => (
              <InboxItem key={n.id} n={n} timeZone={timeZone} onRead={() => void markRead(n.id)} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function InboxItem({ n, timeZone, onRead }: { n: Notification; timeZone: string; onRead: () => void }) {
  const e = n.event;
  return (
    <li
      className="flex items-start justify-between gap-3 py-2"
      data-notification-id={n.id}
      data-read={n.readAt !== null}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-fg">
          {n.readAt === null ? (
            <span className="mr-1.5 inline-block size-2 rounded-full bg-accent" aria-label="unread" />
          ) : null}
          {e.title} <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
          {e.late ? (
            <>
              {' '}
              <Badge tone="warn">late</Badge>
            </>
          ) : null}
        </p>
        <p className="text-sm text-fg-muted">{e.body}</p>
        <p className="text-xs text-fg-muted">
          {formatInstant(e.firedAt, timeZone)} · {e.ruleName}
        </p>
      </div>
      {n.readAt === null ? (
        <Button size="sm" variant="ghost" aria-label={`Mark "${e.title}" read`} onClick={onRead}>
          Mark read
        </Button>
      ) : null}
    </li>
  );
}

function HistoryCard() {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const [pages, setPages] = useState<Page<AlertEvent>[]>([]);
  const first = useQuery({
    queryKey: ['alerts', 'events'],
    queryFn: () => client.request<Page<AlertEvent>>('GET', '/api/v1/alerts/events?limit=50'),
  });
  const all = [first.data, ...pages].filter((p): p is Page<AlertEvent> => !!p);
  const next = all.at(-1)?.nextCursor ?? null;
  const events = all.flatMap((p) => p.items);
  return (
    <Card aria-labelledby="history-title">
      <CardHeader>
        <CardTitle id="history-title">Fired alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {first.isPending ? (
          <Spinner label="Loading fired alerts" />
        ) : events.length === 0 ? (
          <p className="text-sm text-fg-muted">Your rules have not fired yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="py-2 text-sm" data-event-id={e.id}>
                <span className="text-fg">{e.title}</span>
                {e.late ? ' (late)' : ''}
                <span className="block text-xs text-fg-muted">
                  {formatInstant(e.firedAt, timeZone)} · {e.ruleName}
                </span>
              </li>
            ))}
          </ul>
        )}
        {next ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void client
                .request<Page<AlertEvent>>(
                  'GET',
                  `/api/v1/alerts/events?limit=50&cursor=${encodeURIComponent(next)}`,
                )
                .then((p) => setPages((ps) => [...ps, p]))
            }
          >
            Load older
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
