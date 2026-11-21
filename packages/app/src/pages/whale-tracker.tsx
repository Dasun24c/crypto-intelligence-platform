import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, ExternalLink } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  can,
  type Chain,
  CHAINS,
  channels,
  type ExchangeFlow,
  type ExchangeLabel,
  type Instrument,
  ONCHAIN_ASSETS,
  type OnchainAsset,
  type OnchainEventKind,
  type OnchainPage,
  type OnchainStatusResponse,
  WALLET_KINDS,
} from '@cip/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { useChannels } from '../live/hooks.js';
import { formatDecimal, formatUsd } from '../lib/decimal.js';
import { formatAge, formatDuration, formatInstant } from '../lib/format.js';
import {
  CHAIN_LABELS,
  deliveryMs,
  explorerUrl,
  FLOW_LABELS,
  KIND_LABELS,
  party,
  SOURCE_STATE_LABELS,
  shortAddress,
  sourceTone,
  thresholdsSentence,
  WHALE_WINDOWS,
  type WhaleWindow,
  windowMs,
} from '../lib/whales.js';
import { useCurrentUser, useDisplayTimeZone, useNow, useSession } from '../session.js';

/** The tabs are refreshed this often (the on-chain events arrive with their blocks). */
const REFRESH_MS = 15_000;

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-fg-muted">{children}</p>;
}

function WindowSelect({
  value,
  onChange,
  id,
}: {
  value: WhaleWindow;
  onChange: (w: WhaleWindow) => void;
  id: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Window</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as WhaleWindow)}>
        {WHALE_WINDOWS.map((w) => (
          <option key={w.id} value={w.id}>
            {w.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ── Exchange flow ───────────────────────────────────────────────────────────────────────────────

function Side({ side }: { side: 'buy' | 'sell' }) {
  const Icon = side === 'buy' ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={
        side === 'buy' ? 'inline-flex items-center gap-1 text-ok' : 'inline-flex items-center gap-1 text-crit'
      }
    >
      <Icon className="size-3.5" aria-hidden />
      {side === 'buy' ? 'Buy' : 'Sell'}
    </span>
  );
}

const WALL_ENDED = { filled: 'Filled', pulled: 'Pulled', unknown: 'Ended' } as const;

function ExchangeFlowTab() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const timeZone = useDisplayTimeZone();
  const instruments = useInstruments();
  const [win, setWin] = useState<WhaleWindow>('24h');
  const [instrumentId, setInstrumentId] = useState('');
  const byId = useMemo(
    () => new Map<string, Instrument>((instruments.data ?? []).map((i) => [i.id, i])),
    [instruments.data],
  );
  const name = (id: string) => byId.get(id)?.displayName ?? 'Unknown instrument';

  const flow = useQuery({
    queryKey: ['whales', 'exchange', win, instrumentId],
    queryFn: () => {
      const to = Date.now();
      const q = new URLSearchParams({ from: String(to - windowMs(win)), to: String(to) });
      if (instrumentId) q.set('instrumentId', instrumentId);
      return client.request<ExchangeFlow>('GET', `/api/v1/whales/exchange?${q}`);
    },
    refetchInterval: REFRESH_MS,
  });

  // New large trades and walls arrive on each instrument's channels: read the totals again then.
  const watched = useMemo(
    () =>
      (instruments.data ?? [])
        .filter((i) => i.enabled && (!instrumentId || i.id === instrumentId))
        .flatMap((i) => [channels.trades(i.id), channels.market(i.id)]),
    [instruments.data, instrumentId],
  );
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  useChannels(watched, {
    onMessage: (m) => {
      if (m.type !== 'trade.large' && m.type !== 'wall.appeared' && m.type !== 'wall.ended') return;
      clearTimeout(pending.current);
      pending.current = setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ['whales', 'exchange'] }),
        1_000,
      );
    },
  });

  let body: ReactNode;
  if (flow.isPending) body = <Spinner label="Loading the exchange flow" />;
  else if (flow.isError)
    body = (
      <Alert tone="crit" title="The exchange flow could not be loaded">
        {flow.error.message}
      </Alert>
    );
  else {
    const f = flow.data;
    body = (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>By instrument</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {f.instruments.length === 0 ? (
              <Empty>No large trade or wall in this window.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">Large trades and walls per instrument in the window</caption>
                  <thead>
                    <tr>
                      <Th>Instrument</Th>
                      <Th className="text-right">Large trades</Th>
                      <Th className="text-right">Bought</Th>
                      <Th className="text-right">Sold</Th>
                      <Th className="text-right">Net</Th>
                      <Th className="text-right">Largest</Th>
                      <Th className="text-right">Walls appeared</Th>
                      <Th className="text-right">Filled / pulled</Th>
                      <Th className="text-right">Standing now</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.instruments.map((s) => (
                      <tr
                        key={s.instrumentId}
                        data-flow-instrument={s.instrumentId}
                        data-large-trades={s.largeTrades}
                        data-bought-usd={s.boughtUsd}
                        data-sold-usd={s.soldUsd}
                        data-walls-appeared={s.wallsAppeared}
                        data-walls-standing={s.wallsStanding}
                      >
                        <Td className="whitespace-nowrap">{name(s.instrumentId)}</Td>
                        <Td className="text-right font-mono">
                          {s.largeTrades}
                          <span className="block text-xs text-fg-muted">
                            {s.buys} buys, {s.sells} sells
                          </span>
                        </Td>
                        <Td className="text-right font-mono">{formatUsd(s.boughtUsd, 0)}</Td>
                        <Td className="text-right font-mono">{formatUsd(s.soldUsd, 0)}</Td>
                        <Td className="text-right font-mono">{formatUsd(s.netUsd, 0)}</Td>
                        <Td className="text-right font-mono">
                          {s.largestUsd ? formatUsd(s.largestUsd, 0) : '—'}
                        </Td>
                        <Td className="text-right font-mono">{s.wallsAppeared}</Td>
                        <Td className="text-right font-mono">
                          {s.wallsFilled} / {s.wallsPulled}
                        </Td>
                        <Td className="text-right font-mono">{s.wallsStanding}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Large trades</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {f.largeTrades.length === 0 ? (
              <Empty>No large trade in this window.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">Large trades in the window, newest first</caption>
                  <thead>
                    <tr>
                      <Th>Time</Th>
                      <Th>Instrument</Th>
                      <Th>Side</Th>
                      <Th className="text-right">Notional (USD)</Th>
                      <Th className="text-right">Avg price</Th>
                      <Th className="text-right">Quantity</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.largeTrades.map((t) => (
                      <tr key={t.id} data-trade-id={t.id}>
                        <Td className="whitespace-nowrap font-mono text-xs">
                          {formatInstant(t.ts, timeZone)}
                        </Td>
                        <Td className="whitespace-nowrap">{name(t.instrumentId)}</Td>
                        <Td>
                          <Side side={t.takerSide} />
                        </Td>
                        <Td className="text-right font-mono">{formatUsd(t.notionalUsd)}</Td>
                        <Td className="text-right font-mono">{formatDecimal(t.avgPrice)}</Td>
                        <Td className="text-right font-mono">{formatDecimal(t.qty)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            <p
              className="px-4 py-3 text-xs text-fg-muted"
              data-trades-shown={f.largeTrades.length}
              data-trades-total={f.largeTradesTotal}
            >
              {f.largeTrades.length < f.largeTradesTotal
                ? `The newest ${f.largeTrades.length} of ${f.largeTradesTotal} large trades in this window.`
                : `${f.largeTradesTotal} large trades in this window, newest first.`}{' '}
              A large trade is one taker order worth more than the larger of a floor and the 99.9th percentile
              of the instrument's trades over the last 24 h.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Order-book walls</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {f.walls.length === 0 ? (
              <Empty>No wall stands now, and none appeared in this window.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">
                    Walls standing now, then walls that appeared in the window
                  </caption>
                  <thead>
                    <tr>
                      <Th>Instrument</Th>
                      <Th>Side</Th>
                      <Th className="text-right">Price</Th>
                      <Th className="text-right">Largest size (USD)</Th>
                      <Th>First seen</Th>
                      <Th>State</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.walls.map((w) => (
                      <tr key={w.id} data-wall-id={w.id}>
                        <Td className="whitespace-nowrap">{name(w.instrumentId)}</Td>
                        <Td>{w.side === 'bid' ? 'Bid' : 'Ask'}</Td>
                        <Td className="text-right font-mono">{formatDecimal(w.price)}</Td>
                        <Td className="text-right font-mono">{formatUsd(w.maxNotionalUsd, 0)}</Td>
                        <Td className="whitespace-nowrap font-mono text-xs">
                          {formatInstant(w.firstSeen, timeZone)}
                        </Td>
                        <Td>{w.endedReason ? WALL_ENDED[w.endedReason] : 'Standing'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Large trades and order-book walls on Binance and Coinbase: activity on the venues, not blockchain
        transfers. It updates as they happen.
      </p>
      <div className="flex flex-wrap gap-4">
        <WindowSelect id="flow-window" value={win} onChange={setWin} />
        <div className="space-y-1">
          <Label htmlFor="flow-instrument">Instrument</Label>
          <Select id="flow-instrument" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
            <option value="">Every instrument</option>
            {(instruments.data ?? [])
              .filter((i) => i.enabled)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.displayName}
                </option>
              ))}
          </Select>
        </div>
      </div>
      {body}
    </div>
  );
}

// ── On-chain ────────────────────────────────────────────────────────────────────────────────────

function Sources({ status }: { status: OnchainStatusResponse }) {
  const now = useNow(5_000);
  if (status.sources.length === 0)
    return (
      <Alert tone="warn" title="The on-chain watcher has not reported yet">
        It runs in the jobs service. On the replay stack, and in CI, it is switched off.
      </Alert>
    );
  return (
    <div className="space-y-3">
      {status.stale ? (
        <Alert tone="warn" title="This status is old">
          The jobs service has not reported for a while; it may be stopped.
        </Alert>
      ) : null}
      {status.sources.every((s) => s.state === 'off') ? (
        <Alert tone="info" title="The on-chain watcher is switched off on this stack">
          Nothing here connects to the blockchain providers, so no new on-chain event arrives. It is switched
          on with ONCHAIN_ENABLED=true, on a computer where that traffic is allowed.
        </Alert>
      ) : null}
      <dl className="grid gap-4 sm:grid-cols-3">
        {status.sources.map((s) => (
          <div key={s.chain} className="space-y-1" data-source={s.chain} data-source-state={s.state}>
            <dt className="text-xs text-fg-muted">
              {CHAIN_LABELS[s.chain]} · {s.provider}
            </dt>
            <dd className="space-y-1 text-sm">
              <StatusBadge tone={sourceTone(s.state)} label={SOURCE_STATE_LABELS[s.state]} />
              <span className="block text-xs text-fg-muted">{s.detail}</span>
              {s.lastBlock !== null ? (
                <span className="block text-xs text-fg-muted">
                  {s.chain === 'solana' ? 'Slot' : 'Block'} {s.lastBlock.toLocaleString('en-US')}
                  {s.lastBlockTime !== null ? `, ${formatAge(now - s.lastBlockTime)} ago` : ''}
                </span>
              ) : null}
              {s.watching !== null ? (
                <span className="block text-xs text-fg-muted">Watching {s.watching} exchange wallets</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-fg-muted">{thresholdsSentence(status.thresholdsUsd)}</p>
    </div>
  );
}

function OnchainTab() {
  const { client } = useSession();
  const user = useCurrentUser();
  const timeZone = useDisplayTimeZone();
  const [win, setWin] = useState<WhaleWindow>('24h');
  const [asset, setAsset] = useState<OnchainAsset | ''>('');
  const [kind, setKind] = useState<OnchainEventKind | ''>('');

  const status = useQuery({
    queryKey: ['whales', 'onchain', 'status'],
    queryFn: () => client.request<OnchainStatusResponse>('GET', '/api/v1/whales/onchain/status'),
    refetchInterval: REFRESH_MS,
  });
  const pages = useInfiniteQuery({
    queryKey: ['whales', 'onchain', 'events', win, asset, kind],
    initialPageParam: null as { cursor: string; from: number; to: number } | null,
    queryFn: ({ pageParam }) => {
      const to = pageParam?.to ?? Date.now();
      const from = pageParam?.from ?? to - windowMs(win);
      const q = new URLSearchParams({ from: String(from), to: String(to), limit: '100' });
      if (asset) q.set('asset', asset);
      if (kind) q.set('kind', kind);
      if (pageParam) q.set('cursor', pageParam.cursor);
      return client.request<OnchainPage>('GET', `/api/v1/whales/onchain?${q}`);
    },
    getNextPageParam: (last) =>
      last.nextCursor ? { cursor: last.nextCursor, from: last.from, to: last.to } : null,
    refetchInterval: REFRESH_MS,
  });
  const events = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const summary = pages.data?.pages[0]?.summary ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Transfers on the Bitcoin, Ethereum and Solana blockchains, and PAXG's supply growing or shrinking,
        pushed by the providers as blocks are mined. Exchange activity is in the other tab.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        <CardContent>
          {status.isPending ? (
            <Spinner label="Loading the sources" />
          ) : status.isError ? (
            <Alert tone="crit" title="The sources could not be loaded">
              {status.error.message}
            </Alert>
          ) : (
            <Sources status={status.data} />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-4">
        <WindowSelect id="onchain-window" value={win} onChange={setWin} />
        <div className="space-y-1">
          <Label htmlFor="onchain-asset">Asset</Label>
          <Select
            id="onchain-asset"
            value={asset}
            onChange={(e) => setAsset(e.target.value as OnchainAsset | '')}
          >
            <option value="">Every asset</option>
            {ONCHAIN_ASSETS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="onchain-kind">Kind</Label>
          <Select
            id="onchain-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as OnchainEventKind | '')}
          >
            <option value="">Transfers, mints and burns</option>
            <option value="transfer">Transfers</option>
            <option value="mint">PAXG mints</option>
            <option value="burn">PAXG burns</option>
          </Select>
        </div>
      </div>

      {pages.isPending ? (
        <Spinner label="Loading the on-chain events" />
      ) : pages.isError ? (
        <Alert tone="crit" title="The on-chain events could not be loaded">
          {pages.error.message}
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>By asset</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">On-chain events per asset in the window</caption>
                  <thead>
                    <tr>
                      <Th>Asset</Th>
                      <Th className="text-right">Large transfers</Th>
                      <Th className="text-right">Worth (USD)</Th>
                      <Th className="text-right">Into exchanges</Th>
                      <Th className="text-right">Out of exchanges</Th>
                      <Th className="text-right">Minted / burned</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr
                        key={s.asset}
                        data-onchain-asset={s.asset}
                        data-transfers={s.transfers}
                        data-mints={s.mints}
                        data-burns={s.burns}
                      >
                        <Td>{s.asset}</Td>
                        <Td className="text-right font-mono">{s.transfers}</Td>
                        <Td className="text-right font-mono">{formatUsd(s.transferUsd, 0)}</Td>
                        <Td className="text-right font-mono">{formatUsd(s.toExchangeUsd, 0)}</Td>
                        <Td className="text-right font-mono">{formatUsd(s.fromExchangeUsd, 0)}</Td>
                        <Td className="text-right font-mono">
                          {s.asset === 'PAXG'
                            ? `${formatDecimal(s.minted)} / ${formatDecimal(s.burned)}`
                            : '—'}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Events</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {events.length === 0 ? (
                <Empty>No on-chain event in this window.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <caption className="sr-only">On-chain events in the window, newest first</caption>
                    <thead>
                      <tr>
                        <Th>Block time</Th>
                        <Th>Asset</Th>
                        <Th>Kind</Th>
                        <Th className="text-right">Amount</Th>
                        <Th className="text-right">Worth (USD)</Th>
                        <Th>From</Th>
                        <Th>To</Th>
                        <Th>Exchange flow</Th>
                        <Th className="text-right">Arrived after</Th>
                        <Th>Transaction</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((e) => (
                        <tr key={e.id} data-onchain-event={e.id} data-kind={e.kind} data-asset={e.asset}>
                          <Td className="whitespace-nowrap font-mono text-xs">
                            {formatInstant(e.blockTime, timeZone)}
                          </Td>
                          <Td>{e.asset}</Td>
                          <Td>{KIND_LABELS[e.kind]}</Td>
                          <Td className="text-right font-mono">{formatDecimal(e.amount)}</Td>
                          <Td className="text-right font-mono">
                            {e.usdValue ? formatUsd(e.usdValue, 0) : '—'}
                          </Td>
                          <Td className="font-mono text-xs" title={e.from ?? undefined}>
                            {party(e.from, e.fromOwner)}
                          </Td>
                          <Td className="font-mono text-xs" title={e.to ?? undefined}>
                            {party(e.to, e.toOwner)}
                          </Td>
                          <Td className="text-xs">{FLOW_LABELS[e.flow]}</Td>
                          <Td className="text-right font-mono text-xs">{formatDuration(deliveryMs(e))}</Td>
                          <Td>
                            <a
                              className="inline-flex items-center gap-1 font-mono text-xs underline"
                              href={explorerUrl(e.chain, e.txHash)}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {shortAddress(e.txHash)}
                              <ExternalLink className="size-3" aria-hidden />
                              <span className="sr-only">(opens a block explorer)</span>
                            </a>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
              {pages.hasNextPage ? (
                <div className="px-4 py-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={pages.isFetchingNextPage}
                    onClick={() => void pages.fetchNextPage()}
                  >
                    Load older events
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

      {can(user.role, 'settings.manage') ? <LabelsCard /> : null}
    </div>
  );
}

// ── Exchange addresses (admins) ─────────────────────────────────────────────────────────────────

function LabelsCard() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const labels = useQuery({
    queryKey: ['whales', 'labels'],
    queryFn: () => client.request<ExchangeLabel[]>('GET', '/api/v1/admin/whales/labels'),
  });
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['whales'] });

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    try {
      await client.request('POST', '/api/v1/admin/whales/labels', {
        chain: data.get('chain'),
        address: data.get('address'),
        owner: data.get('owner'),
        wallet: data.get('wallet'),
        source: data.get('source'),
      });
      form.reset();
      setMessage('Address added.');
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The address could not be added.');
    }
  };
  const remove = async (l: ExchangeLabel) => {
    try {
      await client.request('DELETE', `/api/v1/admin/whales/labels/${l.id}`);
      setMessage(`Removed ${l.owner}'s ${shortAddress(l.address)}.`);
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The address could not be removed.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Exchange addresses</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-fg-muted">
          Transfers to and from these addresses are shown as exchange flows. Add only addresses an exchange
          published itself, such as in a proof-of-reserves report, and record where. Solana wallets on this
          list are the ones watched.
        </p>
        {message ? (
          <p className="text-sm" role="status">
            {message}
          </p>
        ) : null}
        <form
          aria-label="Add an exchange address"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => void add(e)}
        >
          <div className="space-y-1">
            <Label htmlFor="label-chain">Chain</Label>
            <Select id="label-chain" name="chain" defaultValue="bitcoin">
              {CHAINS.map((c: Chain) => (
                <option key={c} value={c}>
                  {c === 'ethereum' ? 'Ethereum' : CHAIN_LABELS[c]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="label-owner">Exchange</Label>
            <Input id="label-owner" name="owner" required maxLength={60} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="label-address">Address</Label>
            <Input id="label-address" name="address" required maxLength={128} className="font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="label-wallet">Wallet</Label>
            <Select id="label-wallet" name="wallet" defaultValue="unknown">
              {WALLET_KINDS.map((w) => (
                <option key={w} value={w}>
                  {w === 'unknown' ? 'Not stated' : w[0]!.toUpperCase() + w.slice(1)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="label-source">Published at</Label>
            <Input id="label-source" name="source" required maxLength={500} placeholder="https://" />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm">
              Add address
            </Button>
          </div>
        </form>
        {labels.isPending ? (
          <Spinner label="Loading the addresses" />
        ) : labels.isError ? (
          <Alert tone="crit" title="The addresses could not be loaded">
            {labels.error.message}
          </Alert>
        ) : labels.data.length === 0 ? (
          <p className="text-sm text-fg-muted">No address is listed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">Listed exchange addresses</caption>
              <thead>
                <tr>
                  <Th>Exchange</Th>
                  <Th>Chain</Th>
                  <Th>Address</Th>
                  <Th>Wallet</Th>
                  <Th>Source</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {labels.data.map((l) => (
                  <tr key={l.id} data-label-id={l.id}>
                    <Td>{l.owner}</Td>
                    <Td>{l.chain === 'ethereum' ? 'Ethereum' : CHAIN_LABELS[l.chain]}</Td>
                    <Td className="font-mono text-xs" title={l.address}>
                      {shortAddress(l.address)}
                    </Td>
                    <Td className="text-xs">{l.wallet}</Td>
                    <Td className="max-w-48 truncate text-xs" title={l.source}>
                      {l.source}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Remove ${l.owner}'s ${shortAddress(l.address)}`}
                        onClick={() => void remove(l)}
                      >
                        Remove
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'exchange', label: 'Exchange flow' },
  { id: 'onchain', label: 'On-chain' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * The Whale Tracker (Phase 11; REQUIREMENTS §7, WH-01 and WH-02; ADR 025). Its two tabs never share a
 * list or a chart (criterion 11.3): exchange activity and blockchain transfers are different things.
 */
export function WhaleTrackerPage() {
  const [tab, setTab] = useState<TabId>('exchange');
  const refs = useRef<Record<TabId, HTMLButtonElement | null>>({ exchange: null, onchain: null });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? TABS.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    setTab(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Whale Tracker</h1>
        <p className="text-sm text-fg-muted">
          Large money moving: on the exchanges, and on the blockchains. The two are never mixed.
        </p>
      </header>
      <div
        role="tablist"
        aria-label="Whale Tracker views"
        className="flex gap-1 border-b border-border"
        onKeyDown={onKey}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`whales-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`whales-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={
              tab === t.id
                ? '-mb-px border-b-2 border-accent px-3 py-2 text-sm font-medium'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted hover:text-fg'
            }
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`whales-panel-${tab}`} aria-labelledby={`whales-tab-${tab}`} tabIndex={0}>
        {tab === 'exchange' ? <ExchangeFlowTab /> : <OnchainTab />}
      </div>
    </div>
  );
}
