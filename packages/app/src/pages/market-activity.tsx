import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { type ReactNode, useMemo, useReducer } from 'react';
import {
  type BookMetrics,
  channels,
  type CrossVenueSpread,
  type DataGap,
  type Instrument,
  type LargeTrade,
  type Page,
  type Wall,
} from '@cip/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Label,
  Select,
  Spinner,
  StatusBadge,
  type StatusTone,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { ReplayBadge } from '../components/market-badges.js';
import { OrderBookTable } from '../components/order-book.js';
import { SpreadChart } from '../components/spread-chart.js';
import { useChannel, useLiveConnection } from '../live/hooks.js';
import { useBook } from '../live/market-hooks.js';
import {
  gapClosure,
  gapFromEvent,
  liveGapsReducer,
  liveSpreadsReducer,
  liveTradesReducer,
  liveWallsReducer,
  type MarketSnapshot,
  mergeGaps,
  mergeTrades,
  mergeWalls,
  NO_LIVE_GAPS,
  NO_LIVE_TRADES,
  NO_LIVE_WALLS,
  spreadSeries,
} from '../lib/activity.js';
import { formatBps, formatCompactUsd, formatDecimal, formatUsd, stepDecimals } from '../lib/decimal.js';
import { formatAge, formatDuration, formatInstant, formatTime } from '../lib/format.js';
import { defaultInstrument, groupInstruments } from '../lib/market.js';
import { useDisplayTimeZone, useNow, useSession } from '../session.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function When({ ms, timeZone }: { ms: number; timeZone: string }) {
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatInstant(ms, timeZone)}>
      {formatTime(ms, timeZone)}
    </time>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-fg-muted">{children}</p>;
}

function LiveNote() {
  const connection = useLiveConnection();
  return (
    <span className={cn('text-xs', connection.state === 'live' ? 'text-fg-muted' : 'text-warn')}>
      {connection.state === 'live' ? 'live updates' : 'live updates paused: reconnecting'}
    </span>
  );
}

// -----------------------------------------------------------------------------------------------
// Order book
// -----------------------------------------------------------------------------------------------

function DepthMetrics({ instrument }: { instrument: Instrument }) {
  const { client } = useSession();
  const now = useNow();
  const metrics = useQuery({
    queryKey: ['market', instrument.id, 'book-metrics'],
    queryFn: () =>
      client.request<BookMetrics[]>(
        'GET',
        `/api/v1/market/${instrument.id}/book/metrics?from=${Date.now() - 2 * MINUTE}`,
      ),
    refetchInterval: 5_000,
  });
  if (metrics.isPending) return <Spinner label="Loading depth metrics" />;
  if (metrics.isError)
    return <p className="text-sm text-crit">Depth metrics could not be loaded: {metrics.error.message}</p>;
  const m = metrics.data.at(-1);
  if (!m) return <p className="text-sm text-fg-muted">No depth metrics stored in the last 2 minutes.</p>;
  const rows: [string, number | null, number | null, number | null][] = [
    ['±0.1%', m.bidDepth10bp, m.askDepth10bp, m.imbalance10bp],
    ['±0.5%', m.bidDepth50bp, m.askDepth50bp, m.imbalance50bp],
    ['±1%', m.bidDepth100bp, m.askDepth100bp, m.imbalance100bp],
  ];
  return (
    <div className="space-y-2">
      <Table>
        <caption className="sr-only">Book depth around the mid price, in USD-equivalent notional</caption>
        <thead>
          <tr>
            <Th>Within</Th>
            <Th className="text-right">Bid depth</Th>
            <Th className="text-right">Ask depth</Th>
            <Th className="text-right">Imbalance</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([band, bid, ask, imbalance]) => (
            <tr key={band}>
              <Td>{band}</Td>
              <Td className="text-right font-mono">{formatCompactUsd(bid)}</Td>
              <Td className="text-right font-mono">{formatCompactUsd(ask)}</Td>
              <Td className="text-right font-mono">
                {imbalance === null ? '—' : `${imbalance > 0 ? '+' : ''}${imbalance.toFixed(2)}`}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-xs text-fg-muted">
        Mid {formatDecimal(m.mid, stepDecimals(instrument.priceTick))} · spread {formatBps(m.spreadBps)} ·
        stored {formatAge(now - m.ts)} ago (metrics are stored every second). Imbalance runs from −1 (all
        asks) to +1 (all bids).
      </p>
    </div>
  );
}

function OrderBookCard({ instrument }: { instrument: Instrument }) {
  const book = useBook(instrument.id);
  const now = useNow();
  const data = book.data;
  const age = data ? now - (book.lastMessageAt ?? data.ts) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Order book</CardTitle>
        <span className="text-xs text-fg-muted">
          {data === null
            ? ''
            : book.source === 'rest'
              ? `polled ${formatAge(age ?? 0)} ago (live connection down)`
              : `updated ${formatAge(age ?? 0)} ago`}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {data ? (
          <OrderBookTable book={data} instrument={instrument} />
        ) : book.source === 'live' && book.status.state === 'pending' ? (
          <p className="text-sm text-fg-muted">Waiting for live data…</p>
        ) : (
          <div>
            <p className="text-sm font-medium text-fg">No live data</p>
            <p className="text-xs text-fg-muted">The book feed is not streaming.</p>
          </div>
        )}
        <DepthMetrics instrument={instrument} />
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Large trades
// -----------------------------------------------------------------------------------------------

const GROUPING: Record<LargeTrade['grouping'], string> = {
  single: 'Single message',
  taker_order: 'Taker order',
  burst: 'Burst (≤ 250 ms)',
};

function Side({ side }: { side: 'buy' | 'sell' }) {
  const Icon = side === 'buy' ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-1', side === 'buy' ? 'text-bull' : 'text-bear')}>
      <Icon className="size-3.5" aria-hidden />
      {side === 'buy' ? 'Buy' : 'Sell'}
    </span>
  );
}

function LargeTradesCard({ instrument }: { instrument: Instrument }) {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const pages = useInfiniteQuery({
    queryKey: ['market', instrument.id, 'large-trades'],
    queryFn: ({ pageParam }) =>
      client.request<Page<LargeTrade>>(
        'GET',
        `/api/v1/market/${instrument.id}/large-trades?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const [live, dispatch] = useReducer(liveTradesReducer, NO_LIVE_TRADES);
  useChannel(channels.trades(instrument.id), {
    onMessage: (m) => {
      if (m.type === 'trade.large') dispatch({ type: 'trade', trade: m.data as LargeTrade });
    },
    onSnapshot: (snapshot) => {
      const trades = (snapshot as { largeTrades?: LargeTrade[] } | null)?.largeTrades;
      if (trades) dispatch({ type: 'snapshot', trades });
    },
  });
  const rest = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const trades = useMemo(() => mergeTrades(rest, live), [rest, live]);
  const priceDp = stepDecimals(instrument.priceTick);

  let body: ReactNode;
  if (pages.isPending) body = <Empty>Loading large trades…</Empty>;
  else if (pages.isError)
    body = (
      <div className="p-4">
        <Alert tone="crit" title="Large trades could not be loaded">
          {pages.error.message}
        </Alert>
      </div>
    );
  else if (trades.length === 0) body = <Empty>No large trades recorded for this instrument yet.</Empty>;
  else
    body = (
      <Table>
        <caption className="sr-only">Large trades on {instrument.displayName}, newest first</caption>
        <thead>
          <tr>
            <Th>Time</Th>
            <Th>Side</Th>
            <Th className="text-right">Notional (USD)</Th>
            <Th className="text-right">Avg price ({instrument.quote})</Th>
            <Th className="text-right">Quantity ({instrument.base})</Th>
            <Th>Grouping</Th>
            <Th className="text-right">Fills / levels</Th>
            <Th className="text-right">Threshold</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <Td className="whitespace-nowrap font-mono text-xs">
                <When ms={t.ts} timeZone={timeZone} />
              </Td>
              <Td>
                <Side side={t.takerSide} />
              </Td>
              <Td className="text-right font-mono">{formatUsd(t.notionalUsd)}</Td>
              <Td className="text-right font-mono">{formatDecimal(t.avgPrice, priceDp)}</Td>
              <Td className="text-right font-mono">{formatDecimal(t.qty)}</Td>
              <Td className="text-xs text-fg-muted">{GROUPING[t.grouping]}</Td>
              <Td className="text-right font-mono text-xs">
                {t.fillCount} / {t.priceLevels}
              </Td>
              <Td className="text-right font-mono text-xs text-fg-muted">{formatUsd(t.thresholdUsd, 0)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Large trades</CardTitle>
        <LiveNote />
      </CardHeader>
      <CardContent className="p-0">
        {body}
        <p className="px-4 py-3 text-xs text-fg-muted">
          Newest first. Fills are merged per taker order before the threshold is applied; the threshold is the
          larger of a floor and the 99.9th percentile of trade notional over the last 24 h.
        </p>
        {pages.hasNextPage ? (
          <div className="px-4 pb-4">
            <Button
              variant="secondary"
              size="sm"
              busy={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              Load older trades
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Walls
// -----------------------------------------------------------------------------------------------

const ENDED: Record<NonNullable<Wall['endedReason']>, string> = {
  filled: 'Filled (traded through)',
  pulled: 'Pulled (cancelled)',
  unknown: 'Ended (reason unknown)',
};

function WallSide({ side }: { side: Wall['side'] }) {
  return <span className={side === 'bid' ? 'text-bull' : 'text-bear'}>{side === 'bid' ? 'Bid' : 'Ask'}</span>;
}

function WallsCard({ instrument }: { instrument: Instrument }) {
  const { client } = useSession();
  const timeZone = useDisplayTimeZone();
  const now = useNow();
  const id = instrument.id;
  const active = useQuery({
    queryKey: ['market', id, 'walls', 'standing'],
    queryFn: () => client.request<Wall[]>('GET', `/api/v1/market/${id}/walls?active=true`),
    refetchInterval: MINUTE,
  });
  const ended = useQuery({
    queryKey: ['market', id, 'walls', 'ended'],
    queryFn: () =>
      client.request<Wall[]>('GET', `/api/v1/market/${id}/walls?active=false&from=${Date.now() - HOUR}`),
    refetchInterval: MINUTE,
  });
  const [live, dispatch] = useReducer(liveWallsReducer, NO_LIVE_WALLS);
  useChannel(channels.market(id), {
    onMessage: (m) => {
      if (m.type === 'wall.appeared' || m.type === 'wall.ended')
        dispatch({ type: 'wall', wall: m.data as Wall });
    },
    onSnapshot: (snapshot) => {
      const standing = (snapshot as MarketSnapshot | null)?.activeWalls;
      if (standing) dispatch({ type: 'snapshot', standing });
    },
  });
  const walls = useMemo(
    () => mergeWalls(active.data ?? [], ended.data ?? [], live),
    [active.data, ended.data, live],
  );
  const recent = walls.ended.filter((w) => w.lastSeen >= now - HOUR).slice(0, 20);
  const priceDp = stepDecimals(instrument.priceTick);

  let standing: ReactNode;
  if (active.isPending) standing = <Empty>Loading walls…</Empty>;
  else if (active.isError)
    standing = (
      <div className="p-4">
        <Alert tone="crit" title="Walls could not be loaded">
          {active.error.message}
        </Alert>
      </div>
    );
  else if (walls.standing.length === 0) standing = <Empty>No wall is standing in the book now.</Empty>;
  else
    standing = (
      <Table>
        <caption className="sr-only">Walls standing in the {instrument.displayName} book</caption>
        <thead>
          <tr>
            <Th>Side</Th>
            <Th className="text-right">Price</Th>
            <Th className="text-right">Max notional</Th>
            <Th className="text-right">Standing for</Th>
          </tr>
        </thead>
        <tbody>
          {walls.standing.map((w) => (
            <tr key={w.id}>
              <Td>
                <WallSide side={w.side} />
              </Td>
              <Td className="text-right font-mono">{formatDecimal(w.price, priceDp)}</Td>
              <Td className="text-right font-mono">{formatUsd(w.maxNotionalUsd, 0)}</Td>
              <Td className="text-right text-xs" title={`First seen ${formatInstant(w.firstSeen, timeZone)}`}>
                {formatDuration(now - w.firstSeen)}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Order-book walls</CardTitle>
        <LiveNote />
      </CardHeader>
      <CardContent className="space-y-2 p-0">
        <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">Standing</h3>
        {standing}
        <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Ended in the last hour
        </h3>
        {ended.isError ? (
          <Empty>Ended walls could not be loaded: {ended.error.message}</Empty>
        ) : recent.length === 0 ? (
          <Empty>{ended.isPending ? 'Loading…' : 'None.'}</Empty>
        ) : (
          <Table>
            <caption className="sr-only">Walls that ended in the last hour</caption>
            <thead>
              <tr>
                <Th>Side</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Max notional</Th>
                <Th className="text-right">Lasted</Th>
                <Th>Outcome</Th>
                <Th>Ended</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <WallSide side={w.side} />
                  </Td>
                  <Td className="text-right font-mono">{formatDecimal(w.price, priceDp)}</Td>
                  <Td className="text-right font-mono">{formatUsd(w.maxNotionalUsd, 0)}</Td>
                  <Td className="text-right text-xs">{formatAge(w.lastSeen - w.firstSeen)}</Td>
                  <Td className="text-xs">{w.endedReason ? ENDED[w.endedReason] : '—'}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    <When ms={w.lastSeen} timeZone={timeZone} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="px-4 pb-3 text-xs text-fg-muted">
          A wall is a price level holding at least 10× the median level notional within ±1% of mid. A filled
          wall was traded through; a pulled one was cancelled.
        </p>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Cross-venue spread (PAXG)
// -----------------------------------------------------------------------------------------------

function SpreadCard({ instrument }: { instrument: Instrument }) {
  const { client } = useSession();
  const stored = useQuery({
    queryKey: ['market', 'spreads', instrument.base],
    queryFn: () => client.request<CrossVenueSpread[]>('GET', `/api/v1/market/spreads/${instrument.base}`),
    refetchInterval: 5 * MINUTE,
  });
  const [live, add] = useReducer(liveSpreadsReducer, [] as readonly CrossVenueSpread[]);
  useChannel(channels.market(instrument.id), {
    onMessage: (m) => {
      if (m.type === 'spread') add(m.data as CrossVenueSpread);
    },
  });
  const now = useNow(5_000);
  const lastTs = live.at(-1)?.ts ?? stored.data?.at(-1)?.ts ?? 0;
  const to = Math.max(now, lastTs);
  const from = to - HOUR;
  const points = useMemo(() => spreadSeries(stored.data ?? [], live, from), [stored.data, live, from]);
  const latest = live.at(-1) ?? stored.data?.at(-1) ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{instrument.base} cross-venue spread, last hour</CardTitle>
        <LiveNote />
      </CardHeader>
      <CardContent className="space-y-2">
        {stored.isPending && live.length === 0 ? (
          <Spinner label="Loading spread history" />
        ) : stored.isError && live.length === 0 ? (
          <Alert tone="crit" title="Spread history could not be loaded">
            {stored.error.message}
          </Alert>
        ) : points.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No spread in the last hour: it exists only while both venues&apos; feeds and USDT-USD stream.
          </p>
        ) : (
          <SpreadChart
            points={points}
            from={from}
            to={to}
            title={`${instrument.base} cross-venue spread in bps over the last hour`}
          />
        )}
        {latest ? (
          <p className="text-xs text-fg-muted">
            (secondary − primary) ÷ primary, with the primary converted at USDT-USD{' '}
            {formatDecimal(latest.usdtUsd)}. Stored every 10 s; live points every second.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Data gaps
// -----------------------------------------------------------------------------------------------

const GAP_STATUS: Record<DataGap['status'], [StatusTone, string]> = {
  open: ['crit', 'Open'],
  backfilling: ['warn', 'Backfilling'],
  repaired: ['ok', 'Repaired'],
  unrepairable: ['crit', 'Unrepairable'],
};

const DETECTED_BY: Record<DataGap['detectedBy'], string> = {
  sequence: 'Sequence gap',
  heartbeat: 'Silent stream',
  timer: 'Missing candle',
  reconnect: 'Reconnect',
  consistency_check: 'Consistency check',
};

function GapsCard({ instrument }: { instrument: Instrument }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const timeZone = useDisplayTimeZone();
  const key = ['market', instrument.id, 'gaps'];
  const gaps = useQuery({
    queryKey: key,
    queryFn: () =>
      client.request<Page<DataGap>>('GET', `/api/v1/market/gaps?instrumentId=${instrument.id}&limit=50`),
    refetchInterval: MINUTE,
  });
  const [live, dispatch] = useReducer(liveGapsReducer, NO_LIVE_GAPS);
  useChannel(channels.market(instrument.id), {
    onMessage: (m) => {
      if (m.type === 'gap.opened') {
        const gap = gapFromEvent(m.data, m.ts);
        if (gap) dispatch({ type: 'opened', gap });
      } else if (m.type === 'gap.closed') {
        const closure = gapClosure(m.data);
        if (closure) dispatch({ type: 'closed', ...closure, at: m.ts });
      }
    },
    onSnapshot: (snapshot) => {
      const open = (snapshot as MarketSnapshot | null)?.openGaps;
      if (!open) return;
      dispatch({ type: 'snapshot', open });
      // Gaps that closed while we were away are not in the snapshot: reload their final state.
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const list = useMemo(() => mergeGaps(gaps.data?.items ?? [], live), [gaps.data, live]);

  let body: ReactNode;
  if (gaps.isPending) body = <Empty>Loading data gaps…</Empty>;
  else if (gaps.isError)
    body = (
      <div className="p-4">
        <Alert tone="crit" title="Data gaps could not be loaded">
          {gaps.error.message}
        </Alert>
      </div>
    );
  else if (list.length === 0) body = <Empty>No data gap has been recorded for this instrument.</Empty>;
  else
    body = (
      <Table>
        <caption className="sr-only">Data gaps of {instrument.displayName}, most recent first</caption>
        <thead>
          <tr>
            <Th>Stream</Th>
            <Th>Status</Th>
            <Th>Missing from</Th>
            <Th>Missing to</Th>
            <Th>Detected by</Th>
            <Th>Detected</Th>
            <Th>Resolved</Th>
          </tr>
        </thead>
        <tbody>
          {list.map((g) => {
            const [tone, label] = GAP_STATUS[g.status];
            return (
              <tr key={g.id}>
                <Td className="font-mono text-xs">{g.stream}</Td>
                <Td>
                  <StatusBadge tone={tone} label={label} />
                </Td>
                <Td className="whitespace-nowrap text-xs">{formatInstant(g.from, timeZone)}</Td>
                <Td className="whitespace-nowrap text-xs">
                  {g.to === null ? 'ongoing' : formatInstant(g.to, timeZone)}
                </Td>
                <Td className="text-xs">{DETECTED_BY[g.detectedBy]}</Td>
                <Td className="whitespace-nowrap font-mono text-xs">
                  <When ms={g.detectedAt} timeZone={timeZone} />
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">
                  {g.resolvedAt === null ? '—' : <When ms={g.resolvedAt} timeZone={timeZone} />}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data gaps</CardTitle>
        <LiveNote />
      </CardHeader>
      <CardContent className="p-0">
        {body}
        <p className="px-4 py-3 text-xs text-fg-muted">
          Missing or delayed market data is recorded as a gap and backfilled from the venue&apos;s REST API.
          Analysis waits at an open gap.
        </p>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------------------------

function ActivityPanels({ instrument }: { instrument: Instrument }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <OrderBookCard instrument={instrument} />
      <WallsCard instrument={instrument} />
      <div className="xl:col-span-2">
        <LargeTradesCard instrument={instrument} />
      </div>
      {instrument.base === 'PAXG' ? (
        <div className="xl:col-span-2">
          <SpreadCard instrument={instrument} />
        </div>
      ) : null}
      <div className="xl:col-span-2">
        <GapsCard instrument={instrument} />
      </div>
    </div>
  );
}

function requestedInstrument(search: unknown): string | undefined {
  const value = (search as { instrument?: unknown } | null)?.instrument;
  return typeof value === 'string' ? value : undefined;
}

/** Market Activity (Phase 2): large trades, walls, the live book, the PAXG spread and data gaps. */
export function MarketActivityPage() {
  const instruments = useInstruments();
  // Read through `unknown`: the registered route types are circular from inside a route component.
  const search: unknown = useSearch({ from: '/market' });
  const navigate = useNavigate();
  const groups = useMemo(() => groupInstruments(instruments.data ?? []), [instruments.data]);
  const list = instruments.data ?? [];
  const requested = requestedInstrument(search);
  const selected = list.find((i) => i.id === requested) ?? defaultInstrument(list);

  let body: ReactNode;
  if (instruments.isPending) body = <Spinner label="Loading instruments" />;
  else if (instruments.isError)
    body = (
      <Alert tone="crit" title="Instruments could not be loaded">
        {instruments.error.message}
      </Alert>
    );
  else if (!selected)
    body = (
      <Alert tone="info" title="No instruments are enabled">
        There is no market activity to show. An administrator can enable or add instruments.
      </Alert>
    );
  else
    body = (
      <>
        {requested !== undefined && requested !== selected.id ? (
          <Alert tone="warn" title="That instrument is not available">
            The link points to an instrument that is not enabled. Showing {selected.displayName} instead.
          </Alert>
        ) : null}
        {selected.venue === 'replay' ? (
          <Alert tone="warn" title="Replay instrument">
            {selected.displayName} plays back recorded market data. It is not the live market.
          </Alert>
        ) : null}
        <ActivityPanels key={selected.id} instrument={selected} />
      </>
    );

  return (
    <div className="max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Market Activity {selected?.venue === 'replay' ? <ReplayBadge /> : null}
          </h1>
          <p className="text-sm text-fg-muted">
            Large trades, order-book walls, the live book and data gaps for one instrument.
          </p>
        </div>
        {selected ? (
          <div className="space-y-1.5">
            <Label htmlFor="market-instrument">Instrument</Label>
            <Select
              id="market-instrument"
              className="block w-full min-w-72"
              value={selected.id}
              onChange={(e) => void navigate({ to: '/market', search: { instrument: e.target.value } })}
            >
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
        ) : null}
      </header>
      {body}
    </div>
  );
}
