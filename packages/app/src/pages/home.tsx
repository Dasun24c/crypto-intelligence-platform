import { Link } from '@tanstack/react-router';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { type ReactNode, useId, useMemo } from 'react';
import {
  channels,
  type CrossVenueSpread,
  type FeedStatus,
  type Instrument,
  type Ticker,
} from '@cip/contracts';
import { Alert, Badge, Card, CardContent, cn, Spinner, StatusBadge } from '@cip/ui';
import { useGoldClosures, useInstruments } from '../api/queries.js';
import { FeedBadge, type FeedView, VenueBadge, VenueStatusBadge } from '../components/market-badges.js';
import { type LiveValue, useLatest, useLiveConnection } from '../live/hooks.js';
import { type MarketValue, useFeedStatuses, useTicker } from '../live/market-hooks.js';
import { formatBps, formatDecimal, formatPct, formatUsd, spreadBps, stepDecimals } from '../lib/decimal.js';
import { formatAge, formatDuration, formatInstant } from '../lib/format.js';
import {
  CLOSURE_REASON,
  goldMarketState,
  groupInstruments,
  instrumentFeed,
  type InstrumentGroup,
  VENUE_LABEL,
} from '../lib/market.js';
import { useDisplayTimeZone, useNow } from '../session.js';

/** A spread message older than this means a leg stopped streaming (they arrive every second). */
const SPREAD_SILENT_MS = 5_000;

const pairName = (i: Instrument) => `${VENUE_LABEL[i.venue]} ${i.base}/${i.quote}`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-fg">{children}</dd>
    </div>
  );
}

/** Direction is carried by the sign and the icon, never by colour alone. */
function Change({ pct }: { pct: number }) {
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5',
        pct > 0 ? 'text-bull' : pct < 0 ? 'text-bear' : 'text-fg-muted',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {formatPct(pct)}
    </span>
  );
}

function NoLiveData({ view, replay }: { view: MarketValue<Ticker>; replay: boolean }) {
  if (view.source === 'live' && view.status.state === 'pending')
    return <p className="py-2 text-sm text-fg-muted">Waiting for live data…</p>;
  return (
    <div className="py-2">
      <p className="text-sm font-medium text-fg">No live data</p>
      <p className="text-xs text-fg-muted">
        {view.status.state === 'error' && view.source === 'live'
          ? `The live channel is unavailable (${view.status.error}).`
          : replay
            ? 'Nothing is being played back, so there is no price.'
            : 'The feed is not streaming, so there is no current price.'}
      </p>
    </div>
  );
}

function freshness(view: MarketValue<Ticker>, ticker: Ticker, now: number): string {
  if (view.source === 'rest') return `polled · venue time ${formatAge(now - ticker.ts)} ago`;
  if (view.lastMessageAt !== null) return `updated ${formatAge(now - view.lastMessageAt)} ago`;
  return `last venue update ${formatAge(now - ticker.ts)} ago`;
}

function InstrumentTile({ instrument, feed }: { instrument: Instrument; feed: FeedView }) {
  const view = useTicker(instrument.id);
  const connection = useLiveConnection();
  const now = useNow();
  const titleId = useId();
  const replay = instrument.venue === 'replay';
  const ticker = view.data;
  const dp = stepDecimals(instrument.priceTick);
  // A value is current only while its feed streams and it reaches us: say so when it is not.
  const staleReason =
    ticker === null
      ? null
      : typeof feed === 'object' && feed.state === 'disconnected'
        ? 'Last known price: the feed is down.'
        : view.source === 'live' && connection.state !== 'live'
          ? 'Last known price: the live connection is down.'
          : null;
  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-surface p-4',
        replay ? 'border-dashed border-warn/60' : 'border-border',
      )}
    >
      <header className="space-y-1.5">
        <h3 id={titleId} className="text-sm font-medium leading-snug text-fg">
          {instrument.displayName}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <VenueBadge venue={instrument.venue} />
          {instrument.isPrimaryVenue ? <Badge tone="info">Primary venue</Badge> : null}
          <VenueStatusBadge status={instrument.venueStatus} />
        </div>
      </header>
      {ticker ? (
        <div className="space-y-2">
          <p
            className={cn(
              'font-mono text-2xl font-semibold tabular-nums',
              staleReason ? 'text-fg-muted' : 'text-fg',
            )}
          >
            <span className="sr-only">Last price </span>
            {formatDecimal(ticker.last, dp)}{' '}
            <span className="text-sm font-normal text-fg-muted">{instrument.quote}</span>
          </p>
          {staleReason ? <p className="text-xs text-warn">{staleReason}</p> : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <Field label="Bid">{formatDecimal(ticker.bid, dp)}</Field>
            <Field label="Ask">{formatDecimal(ticker.ask, dp)}</Field>
            <Field label="24 h">
              <Change pct={ticker.change24hPct} />
            </Field>
            <Field label="Spread">{formatBps(spreadBps(ticker.bid, ticker.ask))}</Field>
          </dl>
        </div>
      ) : (
        <NoLiveData view={view} replay={replay} />
      )}
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs">
        <FeedBadge feed={feed} replay={replay} />
        {ticker ? <span className="text-fg-muted">{freshness(view, ticker, now)}</span> : null}
      </footer>
      <Link
        to="/market"
        search={{ instrument: instrument.id }}
        className="text-xs text-accent underline-offset-2 hover:underline"
      >
        Market activity<span className="sr-only"> for {instrument.displayName}</span>
      </Link>
    </article>
  );
}

/** System Health's feed list, or why it is not there. */
type Feeds = readonly FeedStatus[] | 'loading' | 'unavailable';

function Tiles({ group, feeds }: { group: InstrumentGroup; feeds: Feeds }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {group.instruments.map((i) => (
        <InstrumentTile
          key={i.id}
          instrument={i}
          feed={typeof feeds === 'string' ? feeds : instrumentFeed(feeds, i.id)}
        />
      ))}
    </div>
  );
}

function GoldMarketHours({ now }: { now: number }) {
  const closures = useGoldClosures();
  const timeZone = useDisplayTimeZone();
  let body: ReactNode;
  if (closures.isPending) body = <Spinner label="Loading the gold-market calendar" />;
  else if (closures.isError)
    body = (
      <p className="text-sm text-crit">
        The gold-market calendar could not be loaded: {closures.error.message}
      </p>
    );
  else {
    const state = goldMarketState(closures.data, now);
    body = state ? (
      <>
        <p aria-live="polite">
          <StatusBadge
            tone={state.open ? 'ok' : 'warn'}
            label={
              state.open
                ? 'Gold market open'
                : `Gold market closed${state.reason ? ` (${CLOSURE_REASON[state.reason]})` : ''}`
            }
          />
        </p>
        <p className="text-sm text-fg-muted">
          {state.changesAt === null
            ? 'No upcoming closure in the calendar.'
            : `${state.open ? 'Closes' : 'Reopens'} ${formatInstant(state.changesAt, timeZone)} (in ${formatDuration(state.changesAt - now)})`}
        </p>
      </>
    ) : (
      <p className="text-sm text-fg-muted">
        The gold-market calendar has no closures, so whether the market is open cannot be said.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">Underlying gold market</h3>
      {body}
    </div>
  );
}

function SpreadSummary({
  value,
  now,
  instruments,
}: {
  value: LiveValue<CrossVenueSpread>;
  now: number;
  instruments: ReadonlyMap<string, Instrument>;
}) {
  const s = value.data;
  const name = (id: string) => {
    const i = instruments.get(id);
    return i ? pairName(i) : 'another venue';
  };
  const age = value.lastMessageAt === null ? null : now - value.lastMessageAt;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">Cross-venue spread</h3>
      {s === null ? (
        <>
          <p className="text-sm font-medium text-fg">No live spread</p>
          <p className="text-xs text-fg-muted">
            It is published every second while both PAXG feeds and USDT-USD are streaming.
          </p>
        </>
      ) : (
        <>
          <p className="font-mono text-2xl font-semibold tabular-nums">{formatBps(s.spreadBps, true)}</p>
          <p className="text-xs text-fg-muted">
            {name(s.secondaryInstrumentId)} vs {name(s.primaryInstrumentId)}, both in USD: (secondary −
            primary) ÷ primary.
          </p>
          <dl className="grid grid-cols-1 gap-1 text-xs">
            <Field label={`${name(s.primaryInstrumentId)} × USDT-USD`}>{formatUsd(s.primaryUsd)}</Field>
            <Field label={name(s.secondaryInstrumentId)}>{formatUsd(s.secondaryUsd)}</Field>
            <Field label="USDT-USD rate used">{formatDecimal(s.usdtUsd)}</Field>
          </dl>
          <p
            className={cn('text-xs', age !== null && age > SPREAD_SILENT_MS ? 'text-warn' : 'text-fg-muted')}
          >
            {age === null
              ? 'waiting for the next update'
              : age > SPREAD_SILENT_MS
                ? `No update for ${formatAge(age)}: a leg may have stopped streaming.`
                : `updated ${formatAge(age)} ago`}
          </p>
        </>
      )}
    </div>
  );
}

/** The gold panel (requirements §6): PAXG on both venues, their spread, and gold-market hours. */
function GoldPanel({ instruments }: { instruments: readonly Instrument[] }) {
  const primary = instruments.find((i) => i.isPrimaryVenue) ?? instruments[0] ?? null;
  // The spread is published on both PAXG instruments' market channels; one is enough.
  const spread = useLatest<CrossVenueSpread>(primary ? channels.market(primary.id) : null, {
    type: 'spread',
    minIntervalMs: 500,
  });
  const now = useNow();
  const byId = useMemo(() => new Map(instruments.map((i) => [i.id, i])), [instruments]);
  return (
    <Card>
      <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <GoldMarketHours now={now} />
        <SpreadSummary value={spread} now={now} instruments={byId} />
        <p className="text-xs text-fg-muted md:col-span-2">
          PAXG is a token backed by physical gold, not spot gold: its price can differ from spot gold and from
          a broker&apos;s XAUUSD quotes, so PAXG levels cannot be copied one-to-one onto an XAUUSD chart.
          Upcoming US economic events will appear here once the economic calendar is available (Phase 7).
        </p>
      </CardContent>
    </Card>
  );
}

function GroupSection({ group, feeds }: { group: InstrumentGroup; feeds: Feeds }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
        {group.title}
      </h2>
      {group.key === 'PAXG' ? <GoldPanel instruments={group.instruments} /> : null}
      <Tiles group={group} feeds={feeds} />
    </section>
  );
}

/**
 * The Command Center (Phase 2): one tile per enabled instrument with its live ticker and feed state,
 * and the gold panel. Every figure comes from a venue feed; when one is missing it says so.
 */
export function HomePage() {
  const instruments = useInstruments();
  const ids = useMemo(() => instruments.data?.map((i) => i.id) ?? [], [instruments.data]);
  const { feeds: feedList, health } = useFeedStatuses(ids);
  const feeds: Feeds = feedList ?? (health.pending ? 'loading' : 'unavailable');
  const groups = useMemo(() => groupInstruments(instruments.data ?? []), [instruments.data]);
  const hasReplay = instruments.data?.some((i) => i.venue === 'replay') ?? false;

  let body: ReactNode;
  if (instruments.isPending) body = <Spinner label="Loading instruments" />;
  else if (instruments.isError)
    body = (
      <Alert tone="crit" title="Instruments could not be loaded">
        {instruments.error.message}
      </Alert>
    );
  else if (instruments.data.length === 0)
    body = (
      <Alert tone="info" title="No instruments are enabled">
        There is no market data to show. An administrator can enable or add instruments.
      </Alert>
    );
  else body = groups.map((g) => <GroupSection key={g.key} group={g} feeds={feeds} />);

  return (
    <div className="max-w-7xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Command Center</h1>
        <p className="text-sm text-fg-muted">
          Live prices from the venues&apos; public feeds. Nothing is simulated: missing data is shown as
          missing.
        </p>
      </header>
      {hasReplay ? (
        <Alert tone="warn" title="Replay instruments are shown">
          Instruments marked Replay play back recorded market data. They are not the live market.
        </Alert>
      ) : null}
      {body}
    </div>
  );
}
