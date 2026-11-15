import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  can,
  channels,
  type FeeRates,
  type Instrument,
  PRACTICE_BANNER,
  type PracticeAccount,
  type PracticeAccounts,
  type PracticeFill,
  type PracticeOrder,
  type PracticeSettings,
  PracticeSettingsSchema,
  REFUSAL_TEXT,
  RefusalReasonSchema,
  type Ticker,
  type Venue,
  VENUES,
} from '@cip/contracts';
import { dec } from '@cip/domain';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { useInstruments } from '../api/queries.js';
import { PracticeBanner } from '../components/practice-banner.js';
import { formatDecimal, stepDecimals } from '../lib/decimal.js';
import { formatInstant } from '../lib/format.js';
import { VENUE_LABEL } from '../lib/market.js';
import {
  applyAccount,
  balanceOf,
  estimateOrder,
  feePct,
  type FieldProblem,
  isLiveOrder,
  newClientOrderId,
  ORDER_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  pnlTotals,
  type Quote,
  signed,
  type TicketDraft,
  ticketProblems,
} from '../lib/practice.js';
import { type PracticeSearch, readPracticeSearch } from '../lib/search.js';
import { useLatest } from '../live/hooks.js';
import {
  PRACTICE_KEYS,
  useApplyOrder,
  useOpenPracticeOrders,
  usePracticeAccount,
  usePracticeChannel,
  usePracticeFills,
  usePracticeHistory,
  usePracticePositions,
} from '../live/practice.js';
import { useCurrentUser, useDisplayTimeZone, useSession } from '../session.js';

const FLAG_LABEL: Record<PracticeFill['flags'][number], string> = {
  thin_book: 'Thin book',
  underlying_closed: 'Gold market closed',
};
const FLAG_HINT: Record<PracticeFill['flags'][number], string> = {
  thin_book:
    'The order took a large share of the order book near the best price; a real fill would be less certain.',
  underlying_closed: 'The gold market was closed: PAXG traded without its reference price.',
};

const amount = (v: string | null, decimals = 0) => (v === null ? '—' : formatDecimal(v, decimals));
const priceDecimals = (i: Instrument | undefined) => (i ? stepDecimals(i.priceTick) : 0);

/** "Buy 0.5 BTC/USDT, limit 99.50" */
function describeOrder(o: PracticeOrder, i: Instrument | undefined): string {
  const pair = i ? `${i.base}/${i.quote}` : 'the pair';
  const price =
    o.type === 'stop'
      ? `, stop ${amount(o.stopPrice, priceDecimals(i))}`
      : o.limitPrice !== null
        ? `, ${o.type === 'target' ? 'target' : 'limit'} ${amount(o.limitPrice, priceDecimals(i))}`
        : ', market';
  return `${o.side === 'buy' ? 'Buy' : 'Sell'} ${formatDecimal(o.quantity)} ${pair}${price}`;
}

/**
 * Practice trading (Phase 14, REQUIREMENTS §11): buying and selling with practice balances. Orders are
 * simulated by the platform and fill from the venues' live trades and order books; nothing reaches an
 * exchange, and a person places every order (TRD-05).
 */
export function PracticeTradingPage() {
  const params: unknown = useSearch({ strict: false });
  const search = readPracticeSearch(params);
  const user = useCurrentUser();
  const instruments = useInstruments();
  const account = usePracticeAccount();
  const [announcement, setAnnouncement] = useState('');
  const tradeable = useMemo(
    () => (instruments.data ?? []).filter((i) => i.role === 'monitored' && i.enabled),
    [instruments.data],
  );
  const byId = useMemo(() => new Map((instruments.data ?? []).map((i) => [i.id, i])), [instruments.data]);
  usePracticeChannel((fill, order) => {
    const i = byId.get(fill.instrumentId);
    setAnnouncement(
      `Practice ${fill.side} ${order.status === 'filled' ? 'filled' : 'partly filled'}: ${formatDecimal(fill.quantity)} ${i?.base ?? ''} at ${formatDecimal(fill.price)}. Simulated.`,
    );
  });

  return (
    <div className="max-w-6xl space-y-6 border-t-4 border-practice pt-4" data-practice="">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Practice Trading</h1>
        <PracticeBanner />
        <p className="text-sm text-fg-muted">
          Buy and sell with practice balances. Orders are simulated inside the platform and fill from the
          venues&apos; live trades and order books; nothing reaches an exchange. Simulated results are not a
          guide to what real trading would return.
        </p>
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {instruments.isPending || account.isPending ? (
        <Spinner label="Loading your practice account" />
      ) : account.isError ? (
        <Alert tone="crit" title="Your practice account could not be loaded">
          {account.error.message}
        </Alert>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <TicketCard
              instruments={tradeable}
              accounts={account.data.accounts}
              fees={account.data.fees}
              search={search}
            />
            <BalancesCard
              accounts={account.data.accounts.filter((a) => tradeable.some((i) => i.venue === a.venue))}
              onAnnounce={setAnnouncement}
            />
          </div>
          <OpenOrdersCard byId={byId} onAnnounce={setAnnouncement} />
          <PositionsCard byId={byId} instruments={instruments.data ?? []} />
          <HistoryCard byId={byId} />
          {can(user.role, 'settings.manage') ? <SettingsCard /> : null}
        </>
      )}
    </div>
  );
}

// ── the order ticket ─────────────────────────────────────────────────────────────────────────────

const FIELD_ID: Record<keyof TicketDraft, string> = {
  side: 't-side-buy',
  type: 't-type-market',
  quantity: 't-qty',
  limitPrice: 't-limit',
  stop: 't-stop',
  target: 't-target',
};

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-crit">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Choice<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm text-fg-muted">{legend}</legend>
      <div className="flex gap-4">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-sm">
            <input
              id={`t-${name}-${o.value}`}
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="accent-practice"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="font-mono text-sm">{children}</dd>
    </div>
  );
}

const EMPTY_DRAFT: TicketDraft = {
  side: 'buy',
  type: 'market',
  quantity: '',
  limitPrice: '',
  stop: '',
  target: '',
};

function TicketCard({
  instruments,
  accounts,
  fees,
  search,
}: {
  instruments: readonly Instrument[];
  accounts: readonly PracticeAccount[];
  fees: Partial<Record<Venue, FeeRates>>;
  search: PracticeSearch;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const applyOrder = useApplyOrder();
  const fromSetup = search.setup !== undefined && instruments.some((i) => i.id === search.instrument);
  const [instrumentId, setInstrumentId] = useState(search.instrument ?? '');
  const instrument = instruments.find((i) => i.id === instrumentId) ?? instruments[0];
  const [draft, setDraft] = useState<TicketDraft>(() =>
    fromSetup
      ? {
          side: 'buy',
          type: search.limit ? 'limit' : 'market',
          quantity: search.quantity ?? '',
          limitPrice: search.limit ?? '',
          stop: search.stop ?? '',
          target: search.target ?? '',
        }
      : EMPTY_DRAFT,
  );
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{
    tone: 'ok' | 'warn' | 'crit';
    title: string;
    body?: string;
  } | null>(null);
  const clientOrderId = useRef<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const ticker = useLatest<Ticker>(instrument ? channels.ticker(instrument.id) : null);
  const quote: Quote = { bid: ticker.data?.bid ?? null, ask: ticker.data?.ask ?? null };
  const account = accounts.find((a) => a.venue === instrument?.venue);
  const venueFees = instrument ? fees[instrument.venue] : undefined;
  const estimate = estimateOrder(draft, quote, venueFees);
  const pd = priceDecimals(instrument);

  useEffect(() => {
    if (step === 'review') reviewHeading.current?.focus();
  }, [step]);

  if (!instrument)
    return (
      <Card aria-labelledby="ticket-title">
        <CardHeader>
          <CardTitle id="ticket-title">Place a practice order</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-fg-muted">No pair is available for practice orders.</p>
        </CardContent>
      </Card>
    );

  const set = (patch: Partial<TicketDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems((ps) => ps.filter((p) => !(p.field in patch)));
    setOutcome(null);
  };
  const errorOf = (field: keyof TicketDraft) => problems.find((p) => p.field === field)?.message;

  const review = (e: FormEvent) => {
    e.preventDefault();
    const found = ticketProblems(draft, instrument, quote);
    setProblems(found);
    setOutcome(null);
    if (found.length) {
      document.getElementById(FIELD_ID[found[0]!.field])?.focus();
      return;
    }
    clientOrderId.current = newClientOrderId();
    setStep('review');
  };

  const back = () => {
    clientOrderId.current = null;
    setStep('edit');
  };

  const place = async () => {
    const key = clientOrderId.current;
    if (!key) return;
    setSending(true);
    try {
      const order = await session.client.request<PracticeOrder>('POST', '/api/v1/practice/orders', {
        clientOrderId: key,
        instrumentId: instrument.id,
        side: draft.side,
        type: draft.type,
        quantity: draft.quantity.trim(),
        ...(draft.type === 'limit' ? { limitPrice: draft.limitPrice.trim() } : {}),
        ...(draft.side === 'buy' && draft.stop.trim() ? { stop: draft.stop.trim() } : {}),
        ...(draft.side === 'buy' && draft.target.trim() ? { target: draft.target.trim() } : {}),
        ...(fromSetup && instrument.id === search.instrument ? { setupId: search.setup } : {}),
      });
      applyOrder(order);
      setOutcome({
        tone: 'ok',
        title: 'Practice order submitted',
        body: `${describeOrder(order, instrument)}. It fills from the live market; its progress shows under Open practice orders.`,
      });
      clientOrderId.current = null;
      setStep('edit');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ORDER_REFUSED') {
        const reason = RefusalReasonSchema.safeParse(err.problem?.reason);
        setOutcome({
          tone: 'crit',
          title: 'The practice order was refused',
          body: err.problem?.detail ?? (reason.success ? REFUSAL_TEXT[reason.data] : undefined),
        });
        void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.done });
        clientOrderId.current = null;
        setStep('edit');
      } else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && err.problem?.errors?.length) {
        setProblems(
          err.problem.errors
            .filter((x): x is { path: keyof TicketDraft; message: string } => x.path in FIELD_ID)
            .map((x) => ({ field: x.path, message: x.message })),
        );
        setOutcome({ tone: 'crit', title: 'Check the order', body: err.problem.detail });
        clientOrderId.current = null;
        setStep('edit');
      } else {
        // The outcome is unknown (the connection, say): keep the confirmation and its key, so trying
        // again can never place the order twice.
        setOutcome({
          tone: 'warn',
          title: 'The order could not be sent',
          body: `${err instanceof Error ? err.message : 'No answer.'} Try again: the same order is sent, so it is never placed twice.`,
        });
      }
    } finally {
      setSending(false);
    }
  };

  const base = instrument.base;
  const quoteAsset = instrument.quote;
  const free = (asset: string) => formatDecimal(balanceOf(account, asset).available);
  const groups = VENUES.map((venue) => ({
    venue,
    items: instruments.filter((i) => i.venue === venue),
  })).filter((g) => g.items.length);

  return (
    <Card aria-labelledby="ticket-title" className="border-practice/40">
      <CardHeader>
        <CardTitle id="ticket-title">Place a practice order</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {fromSetup ? (
          <Alert tone="info" title="Filled in from a setup">
            The levels and the quantity come from the setup and the position-size calculator. Check them:
            nothing is placed until you confirm the order.
          </Alert>
        ) : null}
        {step === 'edit' ? (
          <form onSubmit={review} noValidate className="space-y-4" aria-label="Practice order">
            <div className="space-y-1">
              <Label htmlFor="t-pair">Pair</Label>
              <Select
                id="t-pair"
                value={instrument.id}
                onChange={(e) => {
                  setInstrumentId(e.target.value);
                  set({ limitPrice: '', stop: '', target: '' });
                }}
              >
                {groups.map((g) => (
                  <optgroup key={g.venue} label={VENUE_LABEL[g.venue]}>
                    {g.items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="flex flex-wrap gap-8">
              <Choice
                legend="Side"
                name="side"
                options={[
                  { value: 'buy', label: 'Buy' },
                  { value: 'sell', label: 'Sell' },
                ]}
                value={draft.side}
                onChange={(side) => set({ side, stop: '', target: '' })}
              />
              <Choice
                legend="Order type"
                name="type"
                options={[
                  { value: 'market', label: 'Market' },
                  { value: 'limit', label: 'Limit' },
                ]}
                value={draft.type}
                onChange={(type) => set({ type })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="t-qty"
                label={`Quantity (${base})`}
                value={draft.quantity}
                onChange={(quantity) => set({ quantity })}
                hint={`In steps of ${formatDecimal(instrument.qtyStep)}`}
                error={errorOf('quantity')}
              />
              {draft.type === 'limit' ? (
                <Field
                  id="t-limit"
                  label={`Limit price (${quoteAsset})`}
                  value={draft.limitPrice}
                  onChange={(limitPrice) => set({ limitPrice })}
                  hint={
                    draft.side === 'buy' ? 'Buys at this price or lower' : 'Sells at this price or higher'
                  }
                  error={errorOf('limitPrice')}
                />
              ) : null}
            </div>
            {draft.side === 'buy' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id="t-stop"
                  label={`Protective stop (${quoteAsset}, optional)`}
                  value={draft.stop}
                  onChange={(stop) => set({ stop })}
                  hint="Sells what was bought if a trade reaches it"
                  error={errorOf('stop')}
                />
                <Field
                  id="t-target"
                  label={`Target (${quoteAsset}, optional)`}
                  value={draft.target}
                  onChange={(target) => set({ target })}
                  hint="Sells at this price or higher; the stop and target cancel each other"
                  error={errorOf('target')}
                />
              </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 rounded-md bg-surface-2 p-3 sm:grid-cols-4">
              <Fact label="Best bid (live)">{amount(quote.bid, pd)}</Fact>
              <Fact label="Best ask (live)">{amount(quote.ask, pd)}</Fact>
              <Fact label={`Free ${quoteAsset}`}>{free(quoteAsset)}</Fact>
              <Fact label={`Free ${base}`}>{free(base)}</Fact>
            </dl>
            {ticker.status.state !== 'pending' && ticker.data === null ? (
              <p className="text-sm text-warn" role="status">
                No live price for this pair now: a market order would be refused until its data streams again.
              </p>
            ) : null}
            {estimate && venueFees ? (
              <p className="text-sm text-fg-muted" data-estimate="">
                Worth about {formatDecimal(dec(estimate.value).round(2).toString())} {quoteAsset}; fee about{' '}
                {formatDecimal(dec(estimate.fee).round(4).toString())} {quoteAsset} (
                {draft.type === 'market'
                  ? `${feePct(venueFees.taker)} taker`
                  : `${feePct(venueFees.maker)} maker or ${feePct(venueFees.taker)} taker`}
                ). A market order walks the book, so a large one pays more than the best price.
              </p>
            ) : null}
            <Button type="submit">Review order</Button>
          </form>
        ) : (
          <section
            aria-labelledby="ticket-review-title"
            className="space-y-3 rounded-md border border-practice/60 p-3"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !sending) back();
            }}
          >
            <h3 id="ticket-review-title" ref={reviewHeading} tabIndex={-1} className="font-medium">
              Confirm your practice order
            </h3>
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Pair">{instrument.displayName}</Fact>
              <Fact label="Order">
                {draft.side === 'buy' ? 'Buy' : 'Sell'}, {draft.type === 'market' ? 'market' : 'limit'}
              </Fact>
              <Fact label={`Quantity (${base})`}>{formatDecimal(draft.quantity.trim())}</Fact>
              <Fact label={draft.type === 'limit' ? 'Limit price' : 'Best price now'}>
                {amount(estimate?.price ?? null, pd)}
              </Fact>
              {estimate ? (
                <Fact
                  label={
                    draft.side === 'buy'
                      ? `Cost with fee, about (${quoteAsset})`
                      : `Proceeds after fee, about (${quoteAsset})`
                  }
                >
                  {formatDecimal(dec(estimate.total).round(4).toString())}
                </Fact>
              ) : null}
              {draft.side === 'buy' && draft.stop.trim() ? (
                <Fact label="Protective stop">{formatDecimal(draft.stop.trim(), pd)}</Fact>
              ) : null}
              {draft.side === 'buy' && draft.target.trim() ? (
                <Fact label="Target">{formatDecimal(draft.target.trim(), pd)}</Fact>
              ) : null}
              <Fact label="Account">{VENUE_LABEL[instrument.venue]} practice balance</Fact>
            </dl>
            <p className="text-xs text-fg-muted">
              {PRACTICE_BANNER} A market order fills against the order book as it is when it is taken up, so
              its price can differ from this estimate.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void place()} busy={sending}>
                Place practice order
              </Button>
              <Button variant="secondary" onClick={back} disabled={sending}>
                Back to edit
              </Button>
            </div>
          </section>
        )}
        {outcome ? (
          <Alert tone={outcome.tone} title={outcome.title}>
            {outcome.body}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── balances ─────────────────────────────────────────────────────────────────────────────────────

function BalancesCard({
  accounts,
  onAnnounce,
}: {
  accounts: readonly PracticeAccount[];
  onAnnounce: (text: string) => void;
}) {
  return (
    <Card aria-labelledby="balances-title" className="border-practice/40">
      <CardHeader>
        <CardTitle id="balances-title">Practice balances</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {accounts.map((a) => (
          <AccountBalances key={a.id} account={a} onAnnounce={onAnnounce} />
        ))}
        <p className="text-xs text-fg-muted">
          One practice balance per venue: a Binance balance cannot pay for a Coinbase order. Practice money
          only.
        </p>
      </CardContent>
    </Card>
  );
}

function AccountBalances({
  account: a,
  onAnnounce,
}: {
  account: PracticeAccount;
  onAnnounce: (t: string) => void;
}) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const venue = VENUE_LABEL[a.venue];
  const starting = Object.entries(a.startingBalances)
    .map(([asset, v]) => `${formatDecimal(v)} ${asset}`)
    .join(' and ');

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await client.request<PracticeAccount>('POST', '/api/v1/practice/account/reset', {
        venue: a.venue,
      });
      queryClient.setQueryData<PracticeAccounts>(PRACTICE_KEYS.account, (prev) =>
        prev ? { ...prev, accounts: applyAccount(prev.accounts, account) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.all });
      onAnnounce(`${venue} practice account reset to ${starting}.`);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The account could not be reset.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`acct-${a.venue}`} className="space-y-2" data-account={a.venue}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`acct-${a.venue}`} className="font-medium">
          {venue}
          {a.resetEpoch > 0 ? <Badge className="ml-2">Reset {a.resetEpoch}×</Badge> : null}
        </h3>
        {confirming ? null : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Reset {venue} account
          </Button>
        )}
      </div>
      <Table>
        <caption className="sr-only">{venue} practice balances</caption>
        <thead>
          <tr>
            <Th>Asset</Th>
            <Th className="text-right">Free</Th>
            <Th className="text-right">Held by open orders</Th>
            <Th className="text-right">Started with</Th>
          </tr>
        </thead>
        <tbody>
          {a.balances.map((b) => (
            <tr key={b.asset}>
              <Td>{b.asset}</Td>
              <Td className="text-right font-mono">{formatDecimal(b.available)}</Td>
              <Td className="text-right font-mono">{formatDecimal(b.reserved)}</Td>
              <Td className="text-right font-mono">{formatDecimal(a.startingBalances[b.asset] ?? '0')}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {confirming ? (
        <div
          className="space-y-2 rounded-md border border-warn/40 p-3"
          role="group"
          aria-label={`Reset ${venue} account`}
        >
          <p className="text-sm">
            Reset the {venue} practice account? Its open orders are cancelled and its balances start again at{' '}
            {starting}. Earlier orders and fills stay in the history.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" busy={busy} onClick={() => void reset()}>
              Reset the account
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <Alert tone="crit" title="The account could not be reset">
          {error}
        </Alert>
      ) : null}
    </section>
  );
}

// ── open orders ──────────────────────────────────────────────────────────────────────────────────

function priceOf(o: PracticeOrder, i: Instrument | undefined): string {
  if (o.type === 'stop') return `Stop ${amount(o.stopPrice, priceDecimals(i))}`;
  if (o.limitPrice !== null) return amount(o.limitPrice, priceDecimals(i));
  return 'Market';
}

function OpenOrdersCard({
  byId,
  onAnnounce,
}: {
  byId: ReadonlyMap<string, Instrument>;
  onAnnounce: (text: string) => void;
}) {
  const { client } = useSession();
  const open = useOpenPracticeOrders();
  const applyOrder = useApplyOrder();
  const timeZone = useDisplayTimeZone();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (o: PracticeOrder) => {
    setCancelling(o.id);
    setError(null);
    try {
      const after = await client.request<PracticeOrder>('POST', `/api/v1/practice/orders/${o.id}/cancel`);
      applyOrder(after);
      onAnnounce(
        isLiveOrder(after)
          ? `Cancelling ${describeOrder(o, byId.get(o.instrumentId))}.`
          : `${describeOrder(o, byId.get(o.instrumentId))}: ${ORDER_STATUS_LABEL[after.status].toLowerCase()}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The order could not be cancelled.');
    } finally {
      setCancelling(null);
    }
  };

  const orders = open.data ?? [];
  return (
    <Card aria-labelledby="open-title">
      <CardHeader>
        <CardTitle id="open-title">Open practice orders</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {open.isPending ? (
          <Spinner label="Loading open orders" />
        ) : orders.length === 0 ? (
          <p className="text-sm text-fg-muted">No open practice orders.</p>
        ) : (
          <Table>
            <caption className="sr-only">Open practice orders</caption>
            <thead>
              <tr>
                <Th>Placed</Th>
                <Th>Pair</Th>
                <Th>Side</Th>
                <Th>Type</Th>
                <Th className="text-right">Quantity</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Filled</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const i = byId.get(o.instrumentId);
                return (
                  <tr key={o.id} data-order={o.id}>
                    <Td>{formatInstant(o.createdAt, timeZone)}</Td>
                    <Td>{i ? `${i.base}/${i.quote} · ${VENUE_LABEL[i.venue]}` : o.instrumentId}</Td>
                    <Td>{o.side === 'buy' ? 'Buy' : 'Sell'}</Td>
                    <Td>
                      {ORDER_TYPE_LABEL[o.type]}
                      {o.parentId ? <span className="text-fg-muted"> (attached)</span> : null}
                    </Td>
                    <Td className="text-right font-mono">{formatDecimal(o.quantity)}</Td>
                    <Td className="text-right font-mono">{priceOf(o, i)}</Td>
                    <Td className="text-right font-mono">{formatDecimal(o.filledQuantity)}</Td>
                    <Td>
                      <Badge tone={o.status === 'partially_filled' ? 'info' : 'neutral'}>
                        {ORDER_STATUS_LABEL[o.status]}
                      </Badge>
                      {o.underlyingClosed ? (
                        <Badge tone="warn" className="ml-1">
                          Gold market closed
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={cancelling === o.id}
                        aria-label={`Cancel ${describeOrder(o, i)}`}
                        onClick={() => void cancel(o)}
                      >
                        Cancel
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {error ? (
          <Alert tone="crit" title="The order could not be cancelled">
            {error}
          </Alert>
        ) : null}
        <p className="text-xs text-fg-muted">
          A limit order fills only when a live trade goes through its price. Cancelling a stop or a target
          also cancels its pair.
        </p>
      </CardContent>
    </Card>
  );
}

// ── holdings and results ─────────────────────────────────────────────────────────────────────────

function PositionsCard({
  byId,
  instruments,
}: {
  byId: ReadonlyMap<string, Instrument>;
  instruments: readonly Instrument[];
}) {
  const positions = usePracticePositions();
  const list = positions.data ?? [];
  const totals = pnlTotals(list, instruments);
  return (
    <Card aria-labelledby="positions-title">
      <CardHeader>
        <CardTitle id="positions-title">Holdings and results (simulated)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {positions.isPending ? (
          <Spinner label="Loading holdings" />
        ) : list.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing bought in the current practice period yet.</p>
        ) : (
          <>
            <Table>
              <caption className="sr-only">Practice holdings and results, simulated</caption>
              <thead>
                <tr>
                  <Th>Pair</Th>
                  <Th className="text-right">Holding</Th>
                  <Th className="text-right">Average cost</Th>
                  <Th className="text-right">Last price</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Unrealised</Th>
                  <Th className="text-right">Realised</Th>
                  <Th className="text-right">Fees paid</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const i = byId.get(p.instrumentId);
                  const pd = priceDecimals(i);
                  return (
                    <tr key={p.instrumentId} data-position={p.instrumentId}>
                      <Td>{i ? `${i.base}/${i.quote} · ${VENUE_LABEL[i.venue]}` : p.instrumentId}</Td>
                      <Td className="text-right font-mono">{formatDecimal(p.quantity)}</Td>
                      <Td className="text-right font-mono">
                        {formatDecimal(
                          dec(p.averageCost)
                            .round(pd + 2)
                            .toString(),
                        )}
                      </Td>
                      <Td className="text-right font-mono">{amount(p.lastPrice, pd)}</Td>
                      <Td className="text-right font-mono">
                        {p.marketValue === null ? '—' : formatDecimal(dec(p.marketValue).round(2).toString())}
                      </Td>
                      <Td className="text-right font-mono">
                        {p.unrealisedPnl === null ? '—' : signed(dec(p.unrealisedPnl).round(2).toString())}
                      </Td>
                      <Td className="text-right font-mono">
                        {signed(dec(p.realisedPnl).round(2).toString())}
                      </Td>
                      <Td className="text-right font-mono">
                        {formatDecimal(dec(p.fees).round(4).toString())}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <ul className="space-y-1 text-sm" aria-label="Results by currency">
              {totals.map((t) => (
                <li key={t.quote} data-total={t.quote}>
                  <span className="font-medium">{t.quote}</span>: realised{' '}
                  {signed(dec(t.realised).round(2).toString())}, unrealised{' '}
                  {t.unrealised === null ? 'unknown' : signed(dec(t.unrealised).round(2).toString())}, fees{' '}
                  {formatDecimal(dec(t.fees).round(4).toString())} (simulated)
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-xs text-fg-muted">
          Simulated results of practice orders in the current period of each account, not a forecast of what
          real trading would return. Average cost includes buying fees; a sale&apos;s fee counts when it is
          sold. Values use the pair&apos;s last trade price.
        </p>
      </CardContent>
    </Card>
  );
}

// ── history ──────────────────────────────────────────────────────────────────────────────────────

function HistoryCard({ byId }: { byId: ReadonlyMap<string, Instrument> }) {
  const history = usePracticeHistory();
  const fills = usePracticeFills();
  const timeZone = useDisplayTimeZone();
  const orders = history.data?.pages.flatMap((p) => p.items) ?? [];
  const fillList = fills.data?.pages.flatMap((p) => p.items) ?? [];
  const pair = (id: string) => {
    const i = byId.get(id);
    return i ? `${i.base}/${i.quote} · ${VENUE_LABEL[i.venue]}` : id;
  };
  return (
    <Card aria-labelledby="history-title">
      <CardHeader>
        <CardTitle id="history-title">Practice history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="done-title" className="space-y-2">
          <h3 id="done-title" className="font-medium">
            Finished orders
          </h3>
          {history.isPending ? (
            <Spinner label="Loading finished orders" />
          ) : orders.length === 0 ? (
            <p className="text-sm text-fg-muted">No finished practice orders yet.</p>
          ) : (
            <Table>
              <caption className="sr-only">Finished practice orders</caption>
              <thead>
                <tr>
                  <Th>Placed</Th>
                  <Th>Pair</Th>
                  <Th>Order</Th>
                  <Th className="text-right">Filled</Th>
                  <Th className="text-right">Average price</Th>
                  <Th>Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} data-done={o.id}>
                    <Td>{formatInstant(o.createdAt, timeZone)}</Td>
                    <Td>{pair(o.instrumentId)}</Td>
                    <Td>
                      {o.side === 'buy' ? 'Buy' : 'Sell'} {formatDecimal(o.quantity)},{' '}
                      {ORDER_TYPE_LABEL[o.type].toLowerCase()}
                      {o.source === 'setup' ? <Badge className="ml-1">From a setup</Badge> : null}
                    </Td>
                    <Td className="text-right font-mono">{formatDecimal(o.filledQuantity)}</Td>
                    <Td className="text-right font-mono">
                      {amount(o.averagePrice, priceDecimals(byId.get(o.instrumentId)))}
                    </Td>
                    <Td>
                      <Badge
                        tone={o.status === 'filled' ? 'ok' : o.status === 'refused' ? 'crit' : 'neutral'}
                      >
                        {ORDER_STATUS_LABEL[o.status]}
                      </Badge>
                      {o.refusalReason ? (
                        <span className="ml-2 text-xs text-fg-muted">{REFUSAL_TEXT[o.refusalReason]}</span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {history.hasNextPage ? (
            <Button
              size="sm"
              variant="secondary"
              busy={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Show older orders
            </Button>
          ) : null}
        </section>
        <section aria-labelledby="fills-title" className="space-y-2">
          <h3 id="fills-title" className="font-medium">
            Fills (simulated)
          </h3>
          {fills.isPending ? (
            <Spinner label="Loading fills" />
          ) : fillList.length === 0 ? (
            <p className="text-sm text-fg-muted">No practice fills yet.</p>
          ) : (
            <Table>
              <caption className="sr-only">Simulated practice fills</caption>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Pair</Th>
                  <Th>Side</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th className="text-right">Fee</Th>
                  <Th>Filled as</Th>
                </tr>
              </thead>
              <tbody>
                {fillList.map((f) => (
                  <tr key={f.id} data-fill={f.id}>
                    <Td>{formatInstant(f.filledAt, timeZone)}</Td>
                    <Td>{pair(f.instrumentId)}</Td>
                    <Td>{f.side === 'buy' ? 'Buy' : 'Sell'}</Td>
                    <Td className="text-right font-mono">
                      {formatDecimal(f.price, priceDecimals(byId.get(f.instrumentId)))}
                    </Td>
                    <Td className="text-right font-mono">{formatDecimal(f.quantity)}</Td>
                    <Td className="text-right font-mono">
                      {formatDecimal(f.fee)} {f.feeAsset}
                    </Td>
                    <Td>
                      {f.liquidity === 'maker' ? 'Resting (maker)' : 'Taking (taker)'}
                      {f.flags.map((flag) => (
                        <Badge key={flag} tone="warn" className="ml-1" title={FLAG_HINT[flag]}>
                          {FLAG_LABEL[flag]}
                        </Badge>
                      ))}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {fills.hasNextPage ? (
            <Button
              size="sm"
              variant="secondary"
              busy={fills.isFetchingNextPage}
              onClick={() => void fills.fetchNextPage()}
            >
              Show older fills
            </Button>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}

// ── settings (admins) ────────────────────────────────────────────────────────────────────────────

/** Fees are typed as percentages ("0.1") and stored as fractions ("0.001"). */
const toPct = (fraction: string) => dec(fraction).times(100).toString();
const toFraction = (pct: string) => dec(pct).div(100).toString();

function SettingsCard() {
  const { client } = useSession();
  const settings = useQuery({
    queryKey: ['admin', 'settings', 'practice'],
    queryFn: async () =>
      PracticeSettingsSchema.parse(await client.request<unknown>('GET', '/api/v1/admin/settings/practice')),
  });
  return (
    <Card aria-labelledby="practice-settings-title">
      <CardHeader>
        <CardTitle id="practice-settings-title">Practice settings (admin)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <PracticeBanner />
        {settings.isPending ? (
          <Spinner label="Loading the practice settings" />
        ) : settings.isError ? (
          <Alert tone="crit" title="The practice settings could not be loaded">
            {settings.error.message}
          </Alert>
        ) : (
          <SettingsForm initial={settings.data} />
        )}
        <p className="text-xs text-fg-muted">
          Defaults: Binance 0.1 % maker and taker; Coinbase 0.5 % maker and 0.9 % taker (its lowest tier for
          US accounts, November 2026). Real fees vary by region, tier and account.
        </p>
      </CardContent>
    </Card>
  );
}

interface SettingsDraft {
  fees: Record<string, { maker: string; taker: string }>;
  balances: Record<string, Record<string, string>>;
}

function SettingsForm({ initial }: { initial: PracticeSettings }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsDraft>(() => ({
    fees: Object.fromEntries(
      Object.entries(initial.fees).map(([v, f]) => [v, { maker: toPct(f.maker), taker: toPct(f.taker) }]),
    ),
    balances: Object.fromEntries(Object.entries(initial.startingBalances).map(([v, b]) => [v, { ...b }])),
  }));
  const [state, setState] = useState<{ tone: 'ok' | 'crit'; title: string; body?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState(null);
    let body: PracticeSettings;
    try {
      body = PracticeSettingsSchema.parse({
        fees: Object.fromEntries(
          Object.entries(form.fees).map(([v, f]) => [
            v,
            { maker: toFraction(f.maker), taker: toFraction(f.taker) },
          ]),
        ),
        startingBalances: Object.fromEntries(
          Object.entries(form.balances).map(([v, b]) => [
            v,
            Object.fromEntries(Object.entries(b).map(([a, x]) => [a, x.trim()])),
          ]),
        ),
      });
    } catch {
      setState({
        tone: 'crit',
        title: 'Check the values',
        body: 'Fees are percentages of 0 or more; starting balances are amounts above zero.',
      });
      return;
    }
    setSaving(true);
    try {
      await client.request('PUT', '/api/v1/admin/settings/practice', body);
      void queryClient.invalidateQueries({ queryKey: PRACTICE_KEYS.account });
      setState({
        tone: 'ok',
        title: 'Practice settings saved',
        body: 'The broker uses the new fees within about 30 seconds. New starting balances apply to accounts opened or reset from now on.',
      });
    } catch (err) {
      setState({
        tone: 'crit',
        title: 'The settings could not be saved',
        body: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <form onSubmit={(e) => void save(e)} className="space-y-4" aria-label="Practice settings">
        <Table>
          <caption className="sr-only">Fees and starting balances per venue</caption>
          <thead>
            <tr>
              <Th>Venue</Th>
              <Th>Maker fee (%)</Th>
              <Th>Taker fee (%)</Th>
              <Th>Starting balances</Th>
            </tr>
          </thead>
          <tbody>
            {VENUES.map((v) => (
              <tr key={v}>
                <Td>{VENUE_LABEL[v]}</Td>
                {(['maker', 'taker'] as const).map((side) => (
                  <Td key={side}>
                    <Input
                      aria-label={`${VENUE_LABEL[v]} ${side} fee, percent`}
                      inputMode="decimal"
                      className="w-24"
                      value={form.fees[v]?.[side] ?? ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          fees: { ...form.fees, [v]: { ...form.fees[v]!, [side]: e.target.value } },
                        })
                      }
                    />
                  </Td>
                ))}
                <Td>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(form.balances[v] ?? {}).map(([asset, value]) => (
                      <label key={asset} className="flex items-center gap-1 text-sm">
                        <Input
                          aria-label={`${VENUE_LABEL[v]} starting ${asset}`}
                          inputMode="decimal"
                          className="w-28"
                          value={value}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              balances: {
                                ...form.balances,
                                [v]: { ...form.balances[v], [asset]: e.target.value },
                              },
                            })
                          }
                        />
                        {asset}
                      </label>
                    ))}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Button type="submit" busy={saving}>
          Save practice settings
        </Button>
      </form>
      {state ? (
        <Alert tone={state.tone} title={state.title}>
          {state.body}
        </Alert>
      ) : null}
    </>
  );
}
