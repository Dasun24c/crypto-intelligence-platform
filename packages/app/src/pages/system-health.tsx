import { useId } from 'react';
import type { AnalysisStatus, FeedStatus, HealthStatus, Instrument, PauseReason } from '@cip/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { RunStatusBadge } from '../components/analysis-status.js';
import { FEED_TONE } from '../components/market-badges.js';
import { useSystemHealth } from '../live/market-hooks.js';
import { formatLag } from '../lib/analysis.js';
import { formatAge } from '../lib/format.js';
import { groupInstruments, VENUE_LABEL } from '../lib/market.js';
import { useNow } from '../session.js';

const TONE = { ok: 'ok', degraded: 'warn', down: 'crit' } as const;
const LABEL = { ok: 'OK', degraded: 'Degraded', down: 'Down' } as const;
const FEED_STATE = { connected: 'Connected', degraded: 'Degraded', disconnected: 'Disconnected' } as const;
const STREAM_ORDER: FeedStatus['stream'][] = ['kline', 'trades', 'depth', 'ticker'];

function Status({ status }: { status: HealthStatus }) {
  return <StatusBadge tone={TONE[status]} label={LABEL[status]} />;
}

interface VenueFeeds {
  key: string;
  title: string;
  rows: { feed: FeedStatus; name: string }[];
}

/** Feeds grouped by the venue of their instrument, instruments by name, streams in a fixed order. */
function byVenue(feeds: readonly FeedStatus[], instruments: readonly Instrument[]): VenueFeeds[] {
  const known = new Map(instruments.map((i) => [i.id, i]));
  const groups = new Map<string, VenueFeeds>();
  for (const feed of feeds) {
    const instrument = known.get(feed.instrumentId);
    const key = instrument?.venue ?? 'other';
    const title = instrument ? VENUE_LABEL[instrument.venue] : 'Other instruments';
    const group = groups.get(key) ?? { key, title, rows: [] };
    group.rows.push({ feed, name: instrument?.displayName ?? `Instrument ${feed.instrumentId}` });
    groups.set(key, group);
  }
  for (const g of groups.values())
    g.rows.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        STREAM_ORDER.indexOf(a.feed.stream) - STREAM_ORDER.indexOf(b.feed.stream),
    );
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function VenueTable({ group, now }: { group: VenueFeeds; now: number }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {group.title}
      </h3>
      <Table>
        <thead>
          <tr>
            <Th>Instrument</Th>
            <Th>Stream</Th>
            <Th>State</Th>
            <Th>Detail</Th>
            <Th>Last message</Th>
            <Th className="text-right">Lag p50 / p95</Th>
            <Th className="text-right">Open gaps</Th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map(({ feed, name }) => (
            <tr key={`${feed.instrumentId}:${feed.stream}`}>
              <Td className="text-sm">{name}</Td>
              <Td className="font-mono text-xs">{feed.stream}</Td>
              <Td>
                <StatusBadge tone={FEED_TONE[feed.state]} label={FEED_STATE[feed.state]} />
              </Td>
              <Td className="text-fg-muted">{feed.detail}</Td>
              <Td className="whitespace-nowrap font-mono text-xs">
                {feed.lastMessageAt === null ? 'never' : `${formatAge(now - feed.lastMessageAt)} ago`}
              </Td>
              <Td className="whitespace-nowrap text-right font-mono text-xs">
                {feed.lagMsP50 === null || feed.lagMsP95 === null
                  ? '—'
                  : `${Math.round(feed.lagMsP50)} / ${Math.round(feed.lagMsP95)} ms`}
              </Td>
              <Td className={feed.openGaps > 0 ? 'text-right font-mono text-warn' : 'text-right font-mono'}>
                {feed.openGaps}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function FeedsCard({
  feeds,
  instruments,
  now,
}: {
  feeds: readonly FeedStatus[];
  instruments: readonly Instrument[];
  now: number;
}) {
  const connected = feeds.filter((f) => f.state === 'connected').length;
  const replay = instruments.filter((i) => i.venue === 'replay');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Market data feeds</CardTitle>
        <span className="text-xs text-fg-muted">
          {connected} of {feeds.length} streams connected
        </span>
      </CardHeader>
      <CardContent className="space-y-2 p-0 pb-3">
        {feeds.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">
            No feed is reported: no enabled instrument streams from a live venue.
          </p>
        ) : (
          byVenue(feeds, instruments).map((g) => <VenueTable key={g.key} group={g} now={now} />)
        )}
        {replay.length > 0 ? (
          <p className="px-4 text-xs text-fg-muted">
            Replay instruments ({replay.map((i) => i.displayName).join(', ')}) play back recorded data and
            report no feed status.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface AnalysisRow {
  key: string;
  name: string;
  instrument: Instrument | null;
  status: AnalysisStatus | null;
}

/**
 * One row per enabled instrument in Command Center order, with its analysis state; an instrument no
 * analyzer reports stays listed as not analysed. Statuses of instruments not (yet) listed come last.
 */
function analysisRows(
  statuses: readonly AnalysisStatus[],
  instruments: readonly Instrument[],
): AnalysisRow[] {
  const byId = new Map(statuses.map((s) => [s.instrumentId, s]));
  const rows: AnalysisRow[] = groupInstruments(instruments)
    .flatMap((g) => g.instruments)
    .map((i) => ({ key: i.id, name: i.displayName, instrument: i, status: byId.get(i.id) ?? null }));
  const listed = new Set(instruments.map((i) => i.id));
  for (const s of statuses)
    if (!listed.has(s.instrumentId))
      rows.push({ key: s.instrumentId, name: `Instrument ${s.instrumentId}`, instrument: null, status: s });
  return rows;
}

const PAUSE_REASON: Record<PauseReason, string> = {
  warming_up: 'Waiting for history',
  data_gap: 'Data gap',
};

function AnalysisCard({
  statuses,
  instruments,
  now,
}: {
  statuses: readonly AnalysisStatus[];
  instruments: readonly Instrument[];
  now: number;
}) {
  const rows = analysisRows(statuses, instruments);
  const analysed = rows.filter((r) => r.status !== null).length;
  const paused = rows.filter((r) => r.status?.paused).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Analysis</CardTitle>
        <span className="text-xs text-fg-muted">
          {analysed} of {rows.length} instruments analysed{paused > 0 ? ` · ${paused} paused` : ''}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">No instrument is enabled, so nothing is analysed.</p>
        ) : (
          <Table>
            <caption className="sr-only">Analysis state of each enabled instrument</caption>
            <thead>
              <tr>
                <Th>Instrument</Th>
                <Th>Run</Th>
                <Th>Paused</Th>
                <Th>Detail</Th>
                <Th className="text-right">Lag</Th>
                <Th>Reported</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, name, instrument, status }) => (
                <tr key={key}>
                  <Td className="text-sm">{name}</Td>
                  <Td>
                    <RunStatusBadge status={status?.status ?? null} />
                  </Td>
                  <Td>
                    {status === null ? (
                      '—'
                    ) : status.paused ? (
                      <StatusBadge
                        tone="warn"
                        label={status.pauseReason ? PAUSE_REASON[status.pauseReason] : 'Paused'}
                      />
                    ) : (
                      'No'
                    )}
                  </Td>
                  <Td className="text-fg-muted">
                    {status !== null
                      ? status.detail || '—'
                      : instrument?.profile === null
                        ? 'Not analysed: the instrument has no profile'
                        : 'Not analysed: no analyzer holds this instrument'}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-mono text-xs">
                    {status === null ? '—' : formatLag(status.lagSec)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {status === null ? '—' : `${formatAge(now - status.updatedAt)} ago`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="px-4 py-3 text-xs text-fg-muted">
          Lag is how far the newest analysed candle trails the newest stored one, on the timeframe furthest
          behind. Analysis pauses at a data gap until the backfill repairs it, and while a timeframe waits for
          history.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * System Health (architecture §16): dependencies, service heartbeats, market data feeds and the
 * analysis of each instrument. Pushed over `system:health` while the live connection is up, polled
 * every 5 s otherwise.
 */
export function SystemHealthPage() {
  const health = useSystemHealth();
  const instruments = useInstruments();
  const now = useNow();

  if (health.pending) return <Spinner label="Checking services" />;
  if (!health.data)
    return (
      <Alert tone="crit" title="System health is unavailable">
        {health.error?.message ?? 'The server did not answer.'}
      </Alert>
    );
  const data = health.data;
  const age = now - data.checkedAt;

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">System Health</h1>
        <Status status={data.status} />
        <span className="text-xs text-fg-subtle">
          checked {formatAge(age)} ago · {health.live ? 'live updates' : 'refreshes every 5 s'}
        </span>
      </header>
      {health.error && !health.live ? (
        <Alert tone="warn" title="The last refresh failed">
          {health.error.message} The figures below are from the last successful check.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Component</Th>
                <Th>Status</Th>
                <Th>Latency</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {data.dependencies.map((d) => (
                <tr key={d.name}>
                  <Td className="capitalize">{d.name}</Td>
                  <Td>
                    <Status status={d.status} />
                  </Td>
                  <Td className="font-mono">{d.latencyMs === null ? '—' : `${d.latencyMs} ms`}</Td>
                  <Td className="text-fg-muted">{d.detail}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <span className="text-xs text-fg-subtle">from heartbeats; an instance silent for 15 s is down</span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Instance</Th>
                <Th>Version</Th>
                <Th>State</Th>
                <Th>Last heartbeat</Th>
              </tr>
            </thead>
            <tbody>
              {data.services.flatMap((s) =>
                s.instances.length === 0
                  ? [
                      <tr key={s.service}>
                        <Td>{s.service}</Td>
                        <Td>
                          <Status status={s.status} />
                        </Td>
                        <Td colSpan={4} className="text-fg-muted">
                          No running instance
                        </Td>
                      </tr>,
                    ]
                  : s.instances.map((i) => (
                      <tr key={`${s.service}:${i.instance}`}>
                        <Td>{s.service}</Td>
                        <Td>
                          <Status status={i.status} />
                        </Td>
                        <Td className="font-mono text-xs">{i.instance}</Td>
                        <Td className="font-mono text-xs">{i.version}</Td>
                        <Td className="text-fg-muted">{i.detail}</Td>
                        <Td className="font-mono">{formatAge(i.ageMs)} ago</Td>
                      </tr>
                    )),
              )}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <FeedsCard feeds={data.feeds} instruments={instruments.data ?? []} now={now} />

      {/* `?? []`: a server from before Phase 3 (a desktop app can point at one) sends no analysis. */}
      <AnalysisCard statuses={data.analysis ?? []} instruments={instruments.data ?? []} now={now} />
    </div>
  );
}
