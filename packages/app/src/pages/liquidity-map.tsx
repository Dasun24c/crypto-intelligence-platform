import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { type ChartOverlay, SETUP_DISCLAIMER, type Tf } from '@cip/contracts';
import { Alert, Checkbox, Label, Select, Spinner } from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { LiquidityChart } from '../charts/liquidity-chart.js';
import { OVERLAY_KIND_LABELS, OVERLAY_KINDS, type OverlayKind } from '../charts/overlay-items.js';
import { ReplayBadge } from '../components/market-badges.js';
import { PaxgDisclaimer } from '../components/paxg-disclaimer.js';
import { useLiquidityWindow } from '../live/smc-hooks.js';
import { isTimeframe, TF_LABEL } from '../lib/analysis.js';
import { MAP_TIMEFRAMES, readLiquiditySearch } from '../lib/search.js';
import { defaultInstrument, groupInstruments } from '../lib/market.js';
import { useDisplayTimeZone } from '../session.js';

const DEFAULT_MAP_TF: Tf = '1h';

const COUNT: Record<OverlayKind, (o: ChartOverlay) => number> = {
  closure: (o) => o.closures.length,
  range: (o) => o.ranges.length,
  zone: (o) => o.zones.length,
  level: (o) => o.levels.length,
  setup: (o) => o.setups.length,
  swing: (o) => o.swings.length,
  structure: (o) => o.structure.length,
  sweep: (o) => o.sweeps.length,
};

/** Which overlay layers to draw; every layer is on until the user turns it off. */
function LayerToggles({
  overlay,
  visible,
  onChange,
  gold,
}: {
  overlay: ChartOverlay | null;
  visible: ReadonlySet<OverlayKind>;
  onChange: (next: Set<OverlayKind>) => void;
  gold: boolean;
}) {
  const legendId = useId();
  return (
    <fieldset aria-labelledby={legendId} className="flex flex-wrap gap-x-5 gap-y-2">
      <legend id={legendId} className="sr-only">
        Overlay layers
      </legend>
      {OVERLAY_KINDS.filter((k) => k !== 'closure' || gold).map((k) => {
        const id = `layer-${k}`;
        return (
          <div key={k} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={visible.has(k)}
              onChange={(e) => {
                const next = new Set(visible);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                onChange(next);
              }}
            />
            <Label htmlFor={id} className="text-sm font-normal">
              {OVERLAY_KIND_LABELS[k]}
              {overlay ? <span className="text-fg-muted"> ({COUNT[k](overlay)})</span> : null}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

function MapView({
  instrumentId,
  tf,
  priceTick,
  name,
  gold,
}: {
  instrumentId: string;
  tf: Tf;
  priceTick: string;
  name: string;
  gold: boolean;
}) {
  const timeZone = useDisplayTimeZone();
  const view = useLiquidityWindow(instrumentId, tf);
  const [visible, setVisible] = useState<Set<OverlayKind>>(() => new Set(OVERLAY_KINDS));
  const overlay = view.overlay;
  const setupLevels = (overlay?.setups ?? []).some(
    (s) => s.levels.entry !== null || s.levels.target1 !== null,
  );

  let notice: ReactNode = null;
  if (view.error)
    notice = (
      <Alert tone="crit" title="The chart could not be loaded">
        {view.error.message}
      </Alert>
    );
  else if (overlay && overlay.run === null)
    notice = (
      <Alert tone="info" title="Not analysed yet">
        {name} has not been analysed yet, so the chart shows candles only. Detections appear once an analyzer
        takes the instrument on.
      </Alert>
    );
  else if (overlay?.run?.status === 'warming_up')
    notice = (
      <Alert tone="info" title="Warming up">
        The analyzer is still computing this instrument&apos;s history; detections fill in as it catches up.
      </Alert>
    );

  return (
    <div className="space-y-4">
      <LayerToggles overlay={overlay} visible={visible} onChange={setVisible} gold={gold} />
      {notice}
      {gold ? <PaxgDisclaimer /> : null}
      {view.pending && view.candles.length === 0 ? (
        <Spinner label="Loading candles and detections" />
      ) : (
        <LiquidityChart
          instrumentId={instrumentId}
          tf={tf}
          candles={view.candles}
          overlay={overlay}
          ready={view.ready}
          visible={visible}
          priceTick={priceTick}
          timeZone={timeZone}
          label={`${name}, ${TF_LABEL[tf]} candles with SMC overlays`}
        />
      )}
      {setupLevels && visible.has('setup') ? (
        <p className="text-xs text-fg-muted">Setup levels are hypothetical. {SETUP_DISCLAIMER}.</p>
      ) : null}
    </div>
  );
}

/**
 * Liquidity Map (REQUIREMENTS §6, Phase 7): one instrument's candles on a structure timeframe with
 * every SMC detection of the analyzer's run drawn over them, from `GET /smc/{id}/overlay` for the
 * chart's own window. Linkable: `/liquidity?instrument=<id>&tf=<tf>`.
 */
export function LiquidityMapPage() {
  const instruments = useInstruments();
  const search: unknown = useSearch({ from: '/liquidity' });
  const navigate = useNavigate();
  const list = useMemo(() => instruments.data ?? [], [instruments.data]);
  const groups = useMemo(() => groupInstruments(list), [list]);
  const requested = readLiquiditySearch(search);
  const tf = requested.tf ?? DEFAULT_MAP_TF;
  const selected = list.find((i) => i.id === requested.instrument) ?? defaultInstrument(list);
  const show = (instrument: string, timeframe: Tf) =>
    void navigate({ to: '/liquidity', search: { instrument, tf: timeframe } });

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
        There is nothing to chart. An administrator can enable or add instruments.
      </Alert>
    );
  else
    body = (
      <MapView
        key={`${selected.id}:${tf}`}
        instrumentId={selected.id}
        tf={tf}
        priceTick={selected.priceTick}
        name={selected.displayName}
        gold={selected.underlyingCalendar === 'gold'}
      />
    );

  return (
    <div className="max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Liquidity Map {selected?.venue === 'replay' ? <ReplayBadge /> : null}
          </h1>
          <p className="text-sm text-fg-muted">
            Swing points, BOS, CHOCH and MSS, liquidity levels, order blocks, FVGs, supply and demand zones,
            sweeps and setups, as the SMC engine detected them on closed candles.
          </p>
        </div>
        {selected ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="map-instrument">Instrument</Label>
              <Select
                id="map-instrument"
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
              <Label htmlFor="map-tf">Timeframe</Label>
              <Select
                id="map-tf"
                className="block"
                value={tf}
                onChange={(e) => {
                  if (isTimeframe(e.target.value)) show(selected.id, e.target.value);
                }}
              >
                {MAP_TIMEFRAMES.map((t) => (
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
