import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import {
  type AnalysisStatus,
  type IndicatorPoint,
  type IndicatorSeries,
  type Instrument,
  type Tf,
  TIMEFRAMES,
  type Trend,
} from '@cip/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Label,
  Select,
  Spinner,
  Table,
  Td,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { MacdChart, PriceChart, RsiChart, VolumeChart } from '../components/analysis-charts.js';
import { RunStatusBadge } from '../components/analysis-status.js';
import { ReplayBadge } from '../components/market-badges.js';
import {
  type CandleSeriesView,
  POLL_MS,
  useCandleSeries,
  useIndicatorSeries,
} from '../live/analysis-hooks.js';
import { useSystemHealth } from '../live/market-hooks.js';
import {
  CHART_CANDLES,
  chartWindow,
  dataValue,
  DEFAULT_TF,
  formatIndicator,
  formatLag,
  INDICATOR_FIELDS,
  type IndicatorField,
  indicatorLabels,
  isTimeframe,
  pauseTitle,
  priceDecimals,
  TF_LABEL,
  TF_MS,
} from '../lib/analysis.js';
import { stepDecimals } from '../lib/decimal.js';
import { formatInstant } from '../lib/format.js';
import { defaultInstrument, groupInstruments } from '../lib/market.js';
import { useDisplayTimeZone } from '../session.js';

/** The platform's standard wording (requirements §3.7). */
const DISCLAIMER = 'Educational analysis — not financial advice.';

type Labels = Readonly<Record<IndicatorField, string>>;

function When({ ms, timeZone }: { ms: number; timeZone: string }) {
  return <time dateTime={new Date(ms).toISOString()}>{formatInstant(ms, timeZone)}</time>;
}

function LiveNote({ polling }: { polling: boolean }) {
  return (
    <span className={cn('text-xs', polling ? 'text-warn' : 'text-fg-muted')}>
      {polling ? `live connection down: refreshing every ${POLL_MS / 1_000} s` : 'live updates'}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------------------------

function PauseNotice({ status }: { status: AnalysisStatus }) {
  const title = pauseTitle(status);
  if (title === null) return null;
  const lag = `Lag: ${formatLag(status.lagSec)}.`;
  return (
    <Alert tone="warn" title={title}>
      {status.pauseReason === 'warming_up' ? (
        <>
          {status.detail ? `${status.detail}. ` : ''}
          The analyzer waits until a timeframe has enough stored history, then catches up. {lag}
        </>
      ) : status.pauseReason === 'data_gap' ? (
        <>Analysis waits at the gap until the backfill repairs it; no candle is skipped. {lag}</>
      ) : (
        lag
      )}
    </Alert>
  );
}

function RunCard({
  instrument,
  series,
  status,
  healthKnown,
  polling,
  error,
}: {
  instrument: Instrument;
  series: IndicatorSeries;
  status: AnalysisStatus | null;
  healthKnown: boolean;
  polling: boolean;
  error: Error | null;
}) {
  const timeZone = useDisplayTimeZone();
  const run = series.run;
  const failed = error ? (
    <p className="text-xs text-warn">
      The last refresh failed: {error.message} The values shown are from the last successful one.
    </p>
  ) : null;
  if (run === null)
    return (
      <div className="space-y-2">
        <Alert tone="info" title="Not analysed yet">
          {instrument.profile === null
            ? `${instrument.displayName} has no instrument profile, and only instruments with a profile are analysed.`
            : `${instrument.displayName} has not been analysed yet. Analysis starts when an analyzer takes the instrument on; values then appear as candles close.`}
        </Alert>
        {failed}
      </div>
    );
  const current = status?.runId === run.id ? status : null;
  const runStatus = current?.status ?? run.status;
  const open = runStatus === 'running' || runStatus === 'warming_up';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Analysis run</CardTitle>
        <LiveNote polling={polling} />
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Status">
            <RunStatusBadge status={runStatus} />
          </Fact>
          <Fact label="Profile">
            {run.profile.name} v{run.profile.version}
          </Fact>
          <Fact label="Run started">
            <When ms={run.from} timeZone={timeZone} />
          </Fact>
          <Fact label="Lag">{current ? formatLag(current.lagSec) : '—'}</Fact>
        </dl>
        <p className="text-xs text-fg-muted">
          Candles before the run started are warm-up: stored history the analyzer used to prime the
          indicators. They are shaded in the charts.
        </p>
        {current?.paused ? <PauseNotice status={current} /> : null}
        {runStatus === 'warming_up' && !current?.paused ? (
          <Alert tone="info" title="Warming up">
            The analyzer is computing this run&apos;s first values from stored history. The run goes live once
            every timeframe has caught up.
          </Alert>
        ) : null}
        {!open ? (
          <Alert tone="info" title="This run has ended">
            The values shown are its last ones. New values appear when a new run starts.
          </Alert>
        ) : null}
        {open && current === null && healthKnown ? (
          <p className="text-xs text-warn">
            No analyzer reports this instrument right now, so newer values may be missing.
          </p>
        ) : null}
        {failed}
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Latest values
// -----------------------------------------------------------------------------------------------

const TREND: Record<Trend, { icon: typeof Minus; label: string; className: string }> = {
  bullish: { icon: ArrowUpRight, label: 'Bullish', className: 'text-bull' },
  bearish: { icon: ArrowDownRight, label: 'Bearish', className: 'text-bear' },
  neutral: { icon: Minus, label: 'Neutral', className: 'text-fg-muted' },
};

function TrendValue({ trend }: { trend: Trend }) {
  const t = TREND[trend];
  return (
    <span className={cn('inline-flex items-center gap-1', t.className)}>
      <t.icon className="size-3.5" aria-hidden />
      {t.label}
    </span>
  );
}

function Missing({ why }: { why: string }) {
  return (
    <>
      <span aria-hidden>—</span> <span className="font-sans text-xs text-fg-muted">{why}</span>
    </>
  );
}

/** A value formatted for reading; the exact number is in the cell's `data-value` and tooltip. */
function IndicatorValue({
  field,
  point,
  tf,
  dp,
}: {
  field: IndicatorField;
  point: IndicatorPoint;
  tf: Tf;
  dp: number;
}) {
  switch (field) {
    case 'volumeAnomaly':
      return point.volumeAnomaly === null ? <Missing why="warming up" /> : point.volumeAnomaly ? 'Yes' : 'No';
    case 'trend':
      return point.trend === null ? <Missing why="warming up" /> : <TrendValue trend={point.trend} />;
    case 'vwap':
      // VWAP is anchored daily, so the daily timeframe never has one.
      if (point.vwap === null) return <Missing why={tf === '1d' ? 'not computed on 1d' : 'warming up'} />;
      return formatIndicator(point.vwap, dp);
    case 'rsi':
    case 'volumeZ':
    case 'trendStrength': {
      const value = point[field];
      return value === null ? <Missing why="warming up" /> : formatIndicator(value, 2);
    }
    default: {
      const value = point[field];
      return value === null ? <Missing why="warming up" /> : formatIndicator(value, dp);
    }
  }
}

function LatestValues({
  instrument,
  series,
  tf,
  labels,
  className,
}: {
  instrument: Instrument;
  series: IndicatorSeries;
  tf: Tf;
  labels: Labels;
  className?: string;
}) {
  const timeZone = useDisplayTimeZone();
  const point = series.points.at(-1);
  const dp = priceDecimals(stepDecimals(instrument.priceTick));
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Latest closed candle</CardTitle>
        <span className="text-xs text-fg-muted">{TF_LABEL[tf]}</span>
      </CardHeader>
      <CardContent className="space-y-3 p-0 pb-3">
        {point ? (
          <>
            <p className="px-4 pt-3 text-xs text-fg-muted">
              Opened <When ms={point.t} timeZone={timeZone} />, closed{' '}
              <When ms={point.t + TF_MS[tf]} timeZone={timeZone} />.
              {point.warmup ? ' A warm-up candle: it closed before the run started.' : ''}
            </p>
            <Table
              data-t={point.t}
              data-tf={tf}
              data-instrument={instrument.id}
              data-run={series.run?.id}
              data-warmup={String(point.warmup)}
            >
              <caption className="sr-only">Indicator values of the latest closed candle</caption>
              <tbody>
                {INDICATOR_FIELDS.map((field) => {
                  const value = point[field];
                  return (
                    <tr key={field}>
                      <th
                        scope="row"
                        className="border-b border-border/60 px-3 py-2 text-left text-sm font-normal text-fg-muted"
                      >
                        {labels[field]}
                      </th>
                      <Td
                        className="text-right font-mono tabular-nums"
                        data-indicator={field}
                        data-value={dataValue(value)}
                        title={typeof value === 'number' ? String(value) : undefined}
                      >
                        <IndicatorValue field={field} point={point} tf={tf} dp={dp} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        ) : (
          <p className="p-4 text-sm text-fg-muted">
            No {TF_LABEL[tf]} candle has been analysed yet. Values appear here as candles close.
          </p>
        )}
        <p className="px-4 text-xs text-fg-muted">
          The trend reads the order of the close and the three EMAs and the slope of {labels.emaMid}: it
          describes recent prices and is not a prediction. A value shown as warming up needs more candles
          before it can be computed.
        </p>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Charts
// -----------------------------------------------------------------------------------------------

function Charts({
  instrument,
  series,
  candles,
  tf,
  labels,
  className,
}: {
  instrument: Instrument;
  series: IndicatorSeries;
  candles: CandleSeriesView;
  tf: Tf;
  labels: Labels;
  className?: string;
}) {
  const timeZone = useDisplayTimeZone();
  const points = series.points;
  const w = chartWindow(candles.candles, points, tf);
  const dp = priceDecimals(stepDecimals(instrument.priceTick));
  const runFrom = series.run?.from ?? null;
  let body: ReactNode;
  if (!w)
    body = candles.pending ? (
      <Spinner label="Loading candles" />
    ) : candles.error ? (
      <Alert tone="crit" title="Candles could not be loaded">
        {candles.error.message}
      </Alert>
    ) : (
      <p className="text-sm text-fg-muted">No {TF_LABEL[tf]} candle is stored for this instrument yet.</p>
    );
  else
    body = (
      <div className="space-y-6">
        {candles.error && candles.candles.length === 0 ? (
          <Alert tone="warn" title="Candles could not be loaded">
            {candles.error.message} The indicator lines are shown without the candles.
          </Alert>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-fg">Price</h3>
          <PriceChart
            title={`${instrument.displayName}, ${TF_LABEL[tf]} candles with ${labels.emaFast}, ${labels.emaMid}, ${labels.emaSlow} and ${labels.vwap}`}
            candles={candles.candles}
            points={points}
            window={w}
            runFrom={runFrom}
            labels={labels}
            tf={tf}
            dp={dp}
            quote={instrument.quote}
            timeZone={timeZone}
          />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-fg">{labels.rsi}</h3>
          <RsiChart
            points={points}
            window={w}
            runFrom={runFrom}
            label={labels.rsi}
            tf={tf}
            timeZone={timeZone}
          />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-fg">{labels.macd}</h3>
          <MacdChart
            points={points}
            window={w}
            runFrom={runFrom}
            labels={labels}
            tf={tf}
            dp={dp}
            timeZone={timeZone}
          />
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-fg">Volume</h3>
          <VolumeChart
            candles={candles.candles}
            points={points}
            window={w}
            runFrom={runFrom}
            labels={labels}
            tf={tf}
            base={instrument.base}
            timeZone={timeZone}
          />
        </section>
      </div>
    );
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Charts</CardTitle>
        <span className="text-xs text-fg-muted">
          last {CHART_CANDLES} candles of {TF_LABEL[tf]}; blank stretches have no data
        </span>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------------------------

function AnalysisView({ instrument, tf }: { instrument: Instrument; tf: Tf }) {
  const health = useSystemHealth();
  // `?.` on analysis too: a server from before Phase 3 does not send it.
  const status = health.data?.analysis?.find((a) => a.instrumentId === instrument.id) ?? null;
  const indicators = useIndicatorSeries(instrument.id, tf, status?.runId ?? null);
  const candles = useCandleSeries(instrument.id, tf);
  const labels = useMemo(
    () => indicatorLabels(indicators.series?.params ?? null),
    [indicators.series?.params],
  );

  if (!indicators.series)
    return indicators.pending ? (
      <Spinner label="Loading indicator values" />
    ) : (
      <Alert tone="crit" title="Indicator values could not be loaded">
        {indicators.error?.message ?? 'The server did not answer.'}
      </Alert>
    );
  const series = indicators.series;
  return (
    <div className="space-y-6">
      <RunCard
        instrument={instrument}
        series={series}
        status={status}
        healthKnown={health.data !== undefined}
        polling={indicators.polling}
        error={indicators.error}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* First for screen readers and narrow screens; the right-hand column on wide ones. */}
        <LatestValues
          instrument={instrument}
          series={series}
          tf={tf}
          labels={labels}
          className="self-start xl:col-start-3 xl:row-start-1"
        />
        <Charts
          instrument={instrument}
          series={series}
          candles={candles}
          tf={tf}
          labels={labels}
          className="xl:col-span-2 xl:col-start-1 xl:row-start-1"
        />
      </div>
    </div>
  );
}

interface AnalysisSearch {
  instrument?: string;
  tf?: Tf;
}

function readSearch(search: unknown): AnalysisSearch {
  const s = (search ?? {}) as { instrument?: unknown; tf?: unknown };
  return {
    ...(typeof s.instrument === 'string' ? { instrument: s.instrument } : {}),
    ...(isTimeframe(s.tf) ? { tf: s.tf } : {}),
  };
}

/**
 * Technical Analysis (Phase 3): one instrument's indicators on one timeframe, from the analyzer's
 * current run. Values come from `GET /indicators/{id}` and the `indicators:{id}:{tf}` channel; the
 * candles from the market data API. The view is linkable: `/analysis?instrument=<id>&tf=<tf>`.
 */
export function TechnicalAnalysisPage() {
  const instruments = useInstruments();
  // Read through `unknown`: the registered route types are circular from inside a route component.
  const search: unknown = useSearch({ from: '/analysis' });
  const navigate = useNavigate();
  const groups = useMemo(() => groupInstruments(instruments.data ?? []), [instruments.data]);
  const list = instruments.data ?? [];
  const requested = readSearch(search);
  const tf = requested.tf ?? DEFAULT_TF;
  const selected = list.find((i) => i.id === requested.instrument) ?? defaultInstrument(list);
  const show = (instrument: string, timeframe: Tf) =>
    void navigate({ to: '/analysis', search: { instrument, tf: timeframe } });

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
        There is nothing to analyse. An administrator can enable or add instruments.
      </Alert>
    );
  else
    body = (
      <>
        {requested.instrument !== undefined && requested.instrument !== selected.id ? (
          <Alert tone="warn" title="That instrument is not available">
            The link points to an instrument that is not enabled. Showing {selected.displayName} instead.
          </Alert>
        ) : null}
        {selected.venue === 'replay' ? (
          <Alert tone="warn" title="Replay instrument">
            {selected.displayName} plays back recorded market data. It is not the live market.
          </Alert>
        ) : null}
        <AnalysisView key={`${selected.id}:${tf}`} instrument={selected} tf={tf} />
      </>
    );

  return (
    <div className="max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Technical Analysis {selected?.venue === 'replay' ? <ReplayBadge /> : null}
          </h1>
          <p className="text-sm text-fg-muted">
            RSI, MACD, moving averages, VWAP, ATR, volume anomalies and trend, computed by the analyzer on
            closed candles.
          </p>
          <p className="text-xs text-fg-muted">
            Indicators describe recent prices; they are not predictions. {DISCLAIMER}
          </p>
        </div>
        {selected ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="analysis-instrument">Instrument</Label>
              <Select
                id="analysis-instrument"
                className="block w-full min-w-72"
                value={selected.id}
                onChange={(e) => show(e.target.value, tf)}
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
            <div className="space-y-1.5">
              <Label htmlFor="analysis-tf">Timeframe</Label>
              <Select
                id="analysis-tf"
                className="block"
                value={tf}
                onChange={(e) => {
                  if (isTimeframe(e.target.value)) show(selected.id, e.target.value);
                }}
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {TF_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ) : null}
      </header>
      {body}
    </div>
  );
}
