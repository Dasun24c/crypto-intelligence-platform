import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import {
  type BlackoutWindow,
  can,
  type CalendarStatus,
  type EconomicEvent,
  type Impact,
} from '@cip/contracts';
import { zonedTimeToUtc } from '@cip/domain';
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
import { useCalendarEvents, useCalendarStatus } from '../live/smc-hooks.js';
import { formatInstant } from '../lib/format.js';
import { useCurrentUser, useDisplayTimeZone, useNow, useSession } from '../session.js';

const DAY = 86_400_000;
const NEW_YORK = 'America/New_York';
/** FRED's terms of use ask for this notice, placed prominently. */
export const FRED_NOTICE =
  'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.';

const IMPACT_TONE: Record<Impact, 'crit' | 'warn' | 'info'> = { high: 'crit', medium: 'warn', low: 'info' };
const SOURCE_NAME = { fred: 'FRED', bea: 'BEA', manual: 'Entered by an admin' } as const;

function dayKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(ms));
}

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/** The profiles whose blackout a high-impact event in their currencies opens (rulebook §7 item 8). */
export function blackoutsFor(event: EconomicEvent, windows: readonly BlackoutWindow[]): BlackoutWindow[] {
  if (event.impact !== 'high') return [];
  return windows.filter((w) => w.currencies.includes(event.currency));
}

function StatusPanel({ status }: { status: CalendarStatus }) {
  const timeZone = useDisplayTimeZone();
  return (
    <div className="space-y-3">
      {status.available ? null : (
        <Alert tone="warn" title="Checklist item 8 cannot use the calendar yet">
          {status.detail}
        </Alert>
      )}
      <dl className="grid gap-4 sm:grid-cols-3" data-calendar-status={status.status}>
        {status.sources.map((s) => (
          <div key={s.source} className="space-y-0.5">
            <dt className="text-xs text-fg-muted">
              {s.source === 'fred' ? 'FRED (release dates)' : 'BEA (GDP and PCE, with times)'}
            </dt>
            <dd className="text-sm">
              {!s.lastSync
                ? 'Not synced yet'
                : s.lastSync.status === 'skipped'
                  ? 'No API key configured'
                  : s.lastSync.status === 'failed'
                    ? `Last sync failed: ${s.lastSync.error ?? 'unknown error'}`
                    : `Synced ${formatInstant(s.lastSync.finishedAt ?? s.lastSync.startedAt, timeZone)}`}
              {s.lastSuccessAt && s.lastSync?.status !== 'ok' ? (
                <span className="block text-xs text-fg-muted">
                  Last success {formatInstant(s.lastSuccessAt, timeZone)}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
        <div className="space-y-0.5">
          <dt className="text-xs text-fg-muted">Blackout windows (checklist item 8)</dt>
          <dd className="text-sm">
            {status.blackouts.map((b) => (
              <span key={`${b.profile}:${b.version}`} className="block">
                {b.profile === 'gold' ? 'Gold (PAXG)' : 'Crypto'}: {b.beforeMin} min before to {b.afterMin}{' '}
                min after high-impact {b.currencies.join(', ')} events
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function EventRow({
  event,
  windows,
  timeZone,
  now,
  admin,
  onCancel,
}: {
  event: EconomicEvent;
  windows: readonly BlackoutWindow[];
  timeZone: string;
  now: number;
  admin: boolean;
  onCancel: (e: EconomicEvent) => void;
}) {
  const blackouts = blackoutsFor(event, windows);
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 border-t border-border py-3"
      data-event-id={event.id}
      data-release={event.release ?? ''}
      data-impact={event.impact}
      data-scheduled-at={event.scheduledAt}
      data-time-confirmed={event.timeConfirmed ? 'true' : 'false'}
    >
      <div className="flex min-w-0 gap-4">
        <time
          className="w-14 shrink-0 font-mono text-sm tabular-nums"
          dateTime={new Date(event.scheduledAt).toISOString()}
        >
          {clock(event.scheduledAt, timeZone)}
        </time>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{event.title}</p>
          <p className="text-xs text-fg-muted">
            {event.country} · {event.currency} · {SOURCE_NAME[event.source]}
            {event.timeConfirmed ? '' : ' · standard release time, not confirmed by the source'}
          </p>
          {blackouts.map((b) => {
            const from = event.scheduledAt - b.beforeMin * 60_000;
            const to = event.scheduledAt + b.afterMin * 60_000;
            const active = now >= from && now <= to;
            return (
              <p key={b.profile} className="text-xs" data-blackout={b.profile}>
                <span className={active ? 'font-medium text-warn' : 'text-fg-muted'}>
                  {b.profile === 'gold' ? 'Gold (PAXG)' : 'Crypto'} blackout {clock(from, timeZone)}–
                  {clock(to, timeZone)}
                  {active ? ' (now)' : ''}
                </span>
              </p>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={IMPACT_TONE[event.impact]}>{event.impact} impact</Badge>
        {admin && event.source === 'manual' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCancel(event)}
            aria-label={`Remove ${event.title} on ${dayKey(event.scheduledAt, timeZone)}`}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** An admin's entry, e.g. an FOMC statement: a date and a New York time (feasibility §6.1). */
function ManualEntryForm({ onDone }: { onDone: () => void }) {
  const { client } = useSession();
  const [date, setDate] = useState('');
  const [time, setTime] = useState('14:00');
  const [title, setTitle] = useState('FOMC statement');
  const [fomc, setFomc] = useState(true);
  const [impact, setImpact] = useState<Impact>('high');
  const [confirmed, setConfirmed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!d || !/^\d{2}:\d{2}$/.test(time)) {
      setError('Enter a date and a time (HH:MM).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.request('POST', '/api/v1/calendar/events', {
        release: fomc ? 'fomc' : null,
        title: title.trim(),
        category: fomc ? 'central_bank' : 'other',
        impact,
        scheduledAt: zonedTimeToUtc(Number(d[1]), Number(d[2]), Number(d[3]), time, NEW_YORK),
        timeConfirmed: confirmed,
      });
      setDate('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The entry could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Add a calendar entry">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="entry-date">Date</Label>
          <Input
            id="entry-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entry-time">Time (New York)</Label>
          <Input
            id="entry-time"
            type="time"
            required
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-28"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entry-title">Title</Label>
          <Input
            id="entry-title"
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-64"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entry-impact">Impact</Label>
          <Select
            id="entry-impact"
            className="block"
            value={impact}
            onChange={(e) => setImpact(e.target.value as Impact)}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-5">
        <div className="flex items-center gap-2">
          <Checkbox id="entry-fomc" checked={fomc} onChange={(e) => setFomc(e.target.checked)} />
          <Label htmlFor="entry-fomc" className="font-normal">
            FOMC statement
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="entry-confirmed"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <Label htmlFor="entry-confirmed" className="font-normal">
            Time confirmed by the source
          </Label>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-crit" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        Add entry
      </Button>
    </form>
  );
}

/**
 * Economic Calendar (REQUIREMENTS §3.8 and §6, Phase 7): upcoming US releases from FRED and BEA and
 * the FOMC statements admins enter, with each profile's blackout window around high-impact events
 * (checklist item 8). Reloads on `calendar.updated`.
 */
export function EconomicCalendarPage() {
  const user = useCurrentUser();
  const admin = can(user.role, 'settings.manage');
  const { client } = useSession();
  const queryClient = useQueryClient();
  const timeZone = useDisplayTimeZone();
  const now = useNow(30_000);
  const [days, setDays] = useState(60);
  const [minImpact, setMinImpact] = useState<Impact | ''>('');
  const [from] = useState(() => Math.floor(Date.now() / 60_000) * 60_000 - DAY);
  const events = useCalendarEvents({
    from,
    to: from + (days + 1) * DAY,
    ...(minImpact ? { minImpact } : {}),
  });
  const status = useCalendarStatus();
  const [message, setMessage] = useState<string | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['calendar'] });

  const days_ = useMemo(() => {
    const out = new Map<string, EconomicEvent[]>();
    for (const e of events.data ?? []) {
      const k = dayKey(e.scheduledAt, timeZone);
      out.set(k, [...(out.get(k) ?? []), e]);
    }
    return [...out.entries()];
  }, [events.data, timeZone]);

  const cancel = async (e: EconomicEvent) => {
    try {
      await client.request('DELETE', `/api/v1/calendar/events/${e.id}`);
      setMessage(`Removed ${e.title}.`);
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The entry could not be removed.');
    }
  };
  const sync = async () => {
    try {
      await client.request('POST', '/api/v1/calendar/sync');
      setMessage('Sync requested; the status updates when it finishes.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The sync could not be requested.');
    }
  };

  let list: ReactNode;
  if (events.isPending) list = <Spinner label="Loading the calendar" />;
  else if (events.isError)
    list = (
      <Alert tone="crit" title="The calendar could not be loaded">
        {events.error.message}
      </Alert>
    );
  else if (days_.length === 0)
    list = <p className="text-sm text-fg-muted">No scheduled events in this window.</p>;
  else
    list = (
      <div className="space-y-6">
        {days_.map(([day, items]) => (
          <section key={day} aria-label={day}>
            <h2 className="text-sm font-semibold text-fg-muted">{day}</h2>
            <ul>
              {items.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  windows={status.data?.blackouts ?? []}
                  timeZone={timeZone}
                  now={now}
                  admin={admin}
                  onCancel={(x) => void cancel(x)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Economic Calendar</h1>
        <p className="text-sm text-fg-muted">
          Scheduled US releases: CPI and the Employment Situation (dates from FRED), GDP and Personal Income
          and Outlays (BEA, with their times), and FOMC statements entered by an admin. A setup confirmed
          inside a blackout window fails checklist item 8. Times are shown in {timeZone}.
        </p>
        <p className="text-sm font-medium" data-notice="fred">
          {FRED_NOTICE}
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Sources and blackout windows</CardTitle>
          {admin ? (
            <Button size="sm" variant="secondary" onClick={() => void sync()}>
              Sync now
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {status.isPending ? (
            <Spinner label="Loading the calendar's status" />
          ) : status.isError ? (
            <Alert tone="crit" title="The status could not be loaded">
              {status.error.message}
            </Alert>
          ) : (
            <StatusPanel status={status.data} />
          )}
        </CardContent>
      </Card>

      {message ? (
        <p className="text-sm" role="status">
          {message}
        </p>
      ) : null}

      <section aria-label="Events" className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="calendar-days">Window</Label>
            <Select
              id="calendar-days"
              className="block"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>Next 7 days</option>
              <option value={30}>Next 30 days</option>
              <option value={60}>Next 60 days</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="calendar-impact">Impact</Label>
            <Select
              id="calendar-impact"
              className="block"
              value={minImpact}
              onChange={(e) => setMinImpact(e.target.value as Impact | '')}
            >
              <option value="">All</option>
              <option value="medium">Medium and high</option>
              <option value="high">High only</option>
            </Select>
          </div>
        </div>
        {list}
      </section>

      {admin ? (
        <Card>
          <CardHeader>
            <CardTitle>Add an entry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-fg-muted">
              For releases no source publishes, such as FOMC statements (federalreserve.gov lists the meeting
              dates; statements are released at 2:00 p.m. New York time). Entries are audited; removing one
              keeps it in the history the engine reads.
            </p>
            <ManualEntryForm
              onDone={() => {
                setMessage('Entry added.');
                reload();
              }}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
