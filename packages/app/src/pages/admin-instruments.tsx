import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import {
  ASSET_CLASSES,
  type CreateInstrumentRequest,
  CreateInstrumentRequestSchema,
  type Instrument,
  type UpdateInstrumentRequest,
} from '@cip/contracts';
import {
  Alert,
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
  type StatusTone,
  Switch,
  Table,
  Td,
  Th,
} from '@cip/ui';
import { ApiError } from '../api/client.js';
import { QUERY_KEYS } from '../api/queries.js';
import { VenueBadge } from '../components/market-badges.js';
import { useSession } from '../session.js';

const ASSET_CLASS_LABEL: Record<(typeof ASSET_CLASSES)[number], string> = {
  crypto: 'Crypto',
  tokenised_gold: 'Tokenised gold',
  stablecoin: 'Stablecoin',
};

const VENUE_STATUS: Record<Instrument['venueStatus'], [StatusTone, string]> = {
  trading: ['ok', 'Trading'],
  halted: ['crit', 'Halted'],
  delisted: ['crit', 'Delisted'],
  unknown: ['warn', 'Unknown'],
};

/** An API problem (RFC 9457) in full: title, detail, field errors and the correlation id. */
function ProblemAlert({ error, title }: { error: unknown; title: string }) {
  const problem = error instanceof ApiError ? error.problem : null;
  if (!problem)
    return (
      <Alert tone="crit" title={title}>
        {error instanceof Error ? error.message : 'The request failed.'}
      </Alert>
    );
  return (
    <Alert tone="crit" title={`${title}: ${problem.title}`}>
      {problem.detail ? <p>{problem.detail}</p> : null}
      {problem.errors && problem.errors.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {problem.errors.map((e) => (
            <li key={`${e.path}:${e.message}`}>
              <code className="font-mono text-xs">{e.path || '(body)'}</code>: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-xs">
        HTTP {problem.status} · {problem.code}
        {problem.correlationId ? ` · reference ${problem.correlationId}` : ''}
      </p>
    </Alert>
  );
}

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v);

const DEFAULTS: z.input<typeof CreateInstrumentRequestSchema> = {
  venue: 'binance',
  venueSymbol: '',
  base: '',
  quote: '',
  assetClass: 'crypto',
  role: 'monitored',
  isPrimaryVenue: false,
  underlyingCalendar: null,
  storeRawTrades: true,
};

function AddInstrumentForm({ onAdded }: { onAdded: (instrument: Instrument) => void }) {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof CreateInstrumentRequestSchema>, unknown, CreateInstrumentRequest>({
    resolver: zodResolver(CreateInstrumentRequestSchema),
    defaultValues: DEFAULTS,
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      aria-label="Add instrument"
      className="grid grid-cols-1 gap-4 md:grid-cols-3"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        try {
          const created = await client.request<Instrument>('POST', '/api/v1/admin/instruments', values);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminInstruments }),
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.instruments }),
          ]);
          form.reset(DEFAULTS);
          onAdded(created);
        } catch (err) {
          setError(err);
        }
      })}
    >
      {error ? (
        <div className="md:col-span-3">
          <ProblemAlert error={error} title="Instrument not added" />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="instrument-venue">Venue</Label>
        <Select id="instrument-venue" className="w-full" {...form.register('venue')}>
          <option value="binance">Binance</option>
          <option value="coinbase">Coinbase</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-symbol">Venue symbol</Label>
        <Input
          id="instrument-symbol"
          placeholder="XRPUSDT or XRP-USD"
          autoComplete="off"
          aria-invalid={!!errors.venueSymbol}
          aria-describedby={errors.venueSymbol ? 'instrument-symbol-error' : 'instrument-symbol-hint'}
          {...form.register('venueSymbol', { setValueAs: upper })}
        />
        {errors.venueSymbol ? (
          <p id="instrument-symbol-error" className="text-xs text-crit">
            Use the symbol as the venue lists it: BTCUSDT on Binance, BTC-USD on Coinbase.
          </p>
        ) : (
          <p id="instrument-symbol-hint" className="text-xs text-fg-muted">
            As the venue lists it: BTCUSDT on Binance, BTC-USD on Coinbase.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-asset-class">Asset class</Label>
        <Select id="instrument-asset-class" className="w-full" {...form.register('assetClass')}>
          {ASSET_CLASSES.map((c) => (
            <option key={c} value={c}>
              {ASSET_CLASS_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-base">Base asset</Label>
        <Input
          id="instrument-base"
          placeholder="XRP"
          autoComplete="off"
          aria-invalid={!!errors.base}
          aria-describedby={errors.base ? 'instrument-base-error' : undefined}
          {...form.register('base', { setValueAs: upper })}
        />
        {errors.base ? (
          <p id="instrument-base-error" className="text-xs text-crit">
            Use 2–10 capital letters or digits.
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-quote">Quote asset</Label>
        <Input
          id="instrument-quote"
          placeholder="USDT"
          autoComplete="off"
          aria-invalid={!!errors.quote}
          aria-describedby={errors.quote ? 'instrument-quote-error' : undefined}
          {...form.register('quote', { setValueAs: upper })}
        />
        {errors.quote ? (
          <p id="instrument-quote-error" className="text-xs text-crit">
            Use 2–10 capital letters or digits.
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-role">Role</Label>
        <Select id="instrument-role" className="w-full" {...form.register('role')}>
          <option value="monitored">Monitored</option>
          <option value="reference">Reference rate</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="instrument-calendar">Underlying market calendar</Label>
        <Select
          id="instrument-calendar"
          className="w-full"
          {...form.register('underlyingCalendar', { setValueAs: (v: unknown) => (v === '' ? null : v) })}
        >
          <option value="">None (24/7)</option>
          <option value="gold">Gold market</option>
        </Select>
      </div>
      <div className="flex items-center gap-2 self-end pb-2">
        <Checkbox id="instrument-primary" {...form.register('isPrimaryVenue')} />
        <Label htmlFor="instrument-primary">Primary venue for its base asset</Label>
      </div>
      <div className="flex items-center gap-2 self-end pb-2">
        <Checkbox id="instrument-raw-trades" {...form.register('storeRawTrades')} />
        <Label htmlFor="instrument-raw-trades">Store raw trades</Label>
      </div>
      <p className="text-xs text-fg-muted md:col-span-3">
        The symbol is checked against the venue&apos;s public API. A new instrument starts streaming without a
        restart and its history is backfilled; making it the primary venue demotes the current one.
      </p>
      <div className="md:col-span-3">
        <Button type="submit" busy={isSubmitting}>
          Add instrument
        </Button>
      </div>
    </form>
  );
}

/** Instrument administration (MD-02, MD-07): add, enable or disable, choose the primary venue. */
export function AdminInstrumentsPage() {
  const { client } = useSession();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Instrument | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const instruments = useQuery({
    queryKey: QUERY_KEYS.adminInstruments,
    queryFn: () => client.request<Instrument[]>('GET', '/api/v1/admin/instruments'),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateInstrumentRequest }) =>
      client.request<Instrument>('PATCH', `/api/v1/admin/instruments/${id}`, patch),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminInstruments }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.instruments }),
      ]),
    onError: (err) => setActionError(err),
  });
  const change = (i: Instrument, patch: UpdateInstrumentRequest, question: string) => {
    setActionError(null);
    setAdded(null);
    if (window.confirm(question)) update.mutate({ id: i.id, patch });
  };

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Instruments</h1>
        <Button variant="secondary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <Plus className="size-4" aria-hidden /> {adding ? 'Close' : 'Add instrument'}
        </Button>
      </header>
      {adding ? (
        <Card>
          <CardHeader>
            <CardTitle>Add instrument</CardTitle>
          </CardHeader>
          <CardContent>
            <AddInstrumentForm
              onAdded={(i) => {
                setAdded(i);
                setAdding(false);
              }}
            />
          </CardContent>
        </Card>
      ) : null}
      {added ? (
        <Alert tone="ok" title={`${added.displayName} added`}>
          It starts streaming without a restart; its history is being backfilled.
        </Alert>
      ) : null}
      {actionError ? <ProblemAlert error={actionError} title="Change refused" /> : null}
      <Card>
        <CardContent className="p-0">
          {instruments.isPending ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : instruments.isError ? (
            <div className="p-4">
              <Alert tone="crit" title="Instruments could not be loaded">
                {instruments.error.message}
              </Alert>
            </div>
          ) : instruments.data.length === 0 ? (
            <p className="p-4 text-sm text-fg-muted">No instruments are configured.</p>
          ) : (
            <Table>
              <caption className="sr-only">All instruments, enabled and disabled</caption>
              <thead>
                <tr>
                  <Th>Instrument</Th>
                  <Th>Venue</Th>
                  <Th>Role</Th>
                  <Th>Venue status</Th>
                  <Th>Primary venue</Th>
                  <Th>Enabled</Th>
                </tr>
              </thead>
              <tbody>
                {instruments.data.map((i) => {
                  const [tone, label] = VENUE_STATUS[i.venueStatus];
                  return (
                    <tr key={i.id}>
                      <Td>
                        <div className="font-medium">{i.displayName}</div>
                        <div className="font-mono text-xs text-fg-muted">
                          {i.venueSymbol} · {ASSET_CLASS_LABEL[i.assetClass]}
                          {i.profile ? ` · profile ${i.profile.name} v${i.profile.version}` : ''}
                        </div>
                      </Td>
                      <Td>
                        <VenueBadge venue={i.venue} />
                      </Td>
                      <Td className="text-sm">{i.role === 'reference' ? 'Reference rate' : 'Monitored'}</Td>
                      <Td>
                        <StatusBadge tone={tone} label={label} />
                      </Td>
                      <Td>
                        <Switch
                          aria-label={`Primary venue for ${i.base}: ${i.displayName}`}
                          checked={i.isPrimaryVenue}
                          disabled={update.isPending}
                          onCheckedChange={(on) =>
                            change(
                              i,
                              { isPrimaryVenue: on },
                              on
                                ? `Make ${i.displayName} the primary venue for ${i.base}? The current primary venue is demoted.`
                                : `Stop using ${i.displayName} as the primary venue for ${i.base}?`,
                            )
                          }
                        />
                      </Td>
                      <Td>
                        <Switch
                          aria-label={`Enabled: ${i.displayName}`}
                          checked={i.enabled}
                          disabled={update.isPending}
                          onCheckedChange={(on) =>
                            change(
                              i,
                              { enabled: on },
                              on
                                ? `Enable ${i.displayName}? Its feed starts without a restart.`
                                : `Disable ${i.displayName}? Its feed stops; its history is kept.`,
                            )
                          }
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
