import { useId } from 'react';
import type { FeedStatus, HealthStatus, Instrument } from '@cip/contracts';
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
import { FEED_TONE } from '../components/market-badges.js';
import { useSystemHealth } from '../live/market-hooks.js';
import { formatAge } from '../lib/format.js';
import { VENUE_LABEL } from '../lib/market.js';
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

/**
 * System Health (architecture §16): dependencies, service heartbeats and market data feeds. Pushed
 * over `system:health` while the live connection is up, polled every 5 s otherwise.
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
    </div>
  );
}
