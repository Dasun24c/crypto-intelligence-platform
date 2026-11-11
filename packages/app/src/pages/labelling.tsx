import { useState } from 'react';
import type { Candle, ChartOverlay, Instrument, Tf } from '@cip/contracts';
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
  Table,
  Td,
  Th,
} from '@cip/ui';
import { useInstruments } from '../api/queries.js';
import { TF_MS } from '../lib/analysis.js';
import {
  buildFixture,
  type Candidate,
  candidatesFrom,
  candidatesOf,
  candlesOf,
  CLASSES,
  CONCEPTS,
  type FixtureMeta,
  MANUAL_KINDS,
  type ManualKind,
  manualCandidate,
  parseFixture,
  type Verdict,
} from '../lib/labelling.js';
import { useCurrentUser, useSession } from '../session.js';

/** Candles before the labelled window, so the engine has state when the window starts. */
const WARMUP = 100;
const TFS: Tf[] = ['5m', '15m', '1h', '4h', '1d'];

interface Loaded {
  instrument: Pick<Instrument, 'id' | 'venue' | 'venueSymbol' | 'priceTick' | 'profile' | 'displayName'>;
  tf: Tf;
  candles: Candle[];
  /** Open time of the first labelled candle: earlier candles are warm-up. */
  windowFrom: number;
  overlay: ChartOverlay | null;
  closures: ChartOverlay['closures'];
}

/**
 * Fixture labelling (rulebook §12), development only. One analyst loads a window of stored candles,
 * marks which detections it must and must not produce (the platform's own detections are offered as
 * a starting point, never as the answer) and downloads the fixture; a second analyst opens the file,
 * checks the labels and downloads it with their name as reviewer. Fixtures are committed under
 * packages/smc-engine/fixtures/, where CI runs them.
 */
export function LabellingPage() {
  const { platform } = useSession();
  if (!platform.devTools)
    return (
      <Alert tone="info" title="Development only">
        Fixture labelling is part of the development build (the web dev server, or a build with
        CIP_PUBLIC_DEV_TOOLS=true).
      </Alert>
    );
  return <Labelling />;
}

const isoMinute = (t: number) => new Date(t).toISOString().slice(0, 16);
const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function Labelling() {
  const { client } = useSession();
  const user = useCurrentUser();
  const instruments = useInstruments();
  const [instrumentId, setInstrumentId] = useState('');
  const [tf, setTf] = useState<Tf>('15m');
  const [end, setEnd] = useState(() => isoMinute(Math.floor(Date.now() / 3_600_000) * 3_600_000));
  const [count, setCount] = useState(120);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [kind, setKind] = useState<ManualKind>('swing high (internal)');
  const [added, setAdded] = useState(0);
  const [meta, setMeta] = useState<FixtureMeta>({
    id: '',
    concept: 'sweeps',
    class: 'bullish',
    description: '',
    labelledBy: user.displayName,
    reviewedBy: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instrument = instruments.data?.find((i) => i.id === (instrumentId || instruments.data?.[0]?.id));

  async function load() {
    if (!instrument) return;
    setBusy(true);
    setError(null);
    try {
      const size = TF_MS[tf];
      const to = Date.parse(`${end}:00Z`);
      const windowFrom = to - count * size;
      const from = windowFrom - WARMUP * size;
      const [candles, overlay] = await Promise.all([
        client.request<Candle[]>(
          'GET',
          `/api/v1/market/${instrument.id}/candles?tf=${tf}&from=${from}&to=${to}&limit=5000`,
        ),
        client.request<ChartOverlay>(
          'GET',
          `/api/v1/smc/${instrument.id}/overlay?tf=${tf}&from=${windowFrom}&to=${to}&limit=5000`,
        ),
      ]);
      setLoaded({ instrument, tf, candles, windowFrom, overlay, closures: overlay.closures });
      setCandidates(candidatesFrom(overlay, windowFrom, to));
      setVerdicts({});
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function review(file: File) {
    const parsed = parseFixture(await file.text());
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const f = parsed.fixture;
    const fileTf = (Object.keys(f.candles)[0] ?? '15m') as Tf;
    const candles = candlesOf(f, fileTf);
    const labels = candidatesOf(f);
    setLoaded({
      instrument: {
        id: '',
        venue: (f.source.split(':')[1] ?? 'binance') as Instrument['venue'],
        venueSymbol: f.source.split(':')[2] ?? '',
        priceTick: f.tick ?? '0.01',
        profile: { name: f.profile, version: 0 },
        displayName: f.source,
      },
      tf: fileTf,
      candles,
      windowFrom: candles[0]?.t ?? 0,
      overlay: null,
      closures: f.context.closures.map((c) => ({
        from: Date.parse(c.from),
        to: Date.parse(c.to),
        reason: c.reason,
      })),
    });
    setCandidates(labels.candidates);
    setVerdicts(labels.verdicts);
    setMeta({
      id: f.id,
      concept: (CONCEPTS as readonly string[]).includes(f.concept)
        ? (f.concept as FixtureMeta['concept'])
        : 'sweeps',
      class: (CLASSES as readonly string[]).includes(f.class) ? (f.class as FixtureMeta['class']) : 'bullish',
      description: f.description,
      labelledBy: f.labelledBy ?? '',
      reviewedBy: user.displayName,
    });
    setError(null);
  }

  function download() {
    if (!loaded) return;
    const fixture = buildFixture({
      meta,
      instrument: loaded.instrument,
      tf: loaded.tf,
      candles: loaded.candles,
      closures: loaded.closures,
      candidates,
      verdicts,
    });
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(fixture, null, 2)}\n`], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meta.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function addManual() {
    if (!loaded || selected === null) return;
    const c = loaded.candles[selected];
    if (!c) return;
    const candidate = manualCandidate(kind, loaded.tf, c.t, added + 1);
    setAdded(added + 1);
    setCandidates([...candidates, candidate].sort((a, b) => a.at - b.at));
    setVerdicts({ ...verdicts, [candidate.id]: 'expected' });
  }

  const labelledCount = Object.values(verdicts).length;
  const canExport =
    loaded !== null && meta.id.trim() !== '' && meta.description.trim() !== '' && labelledCount > 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Fixture labelling</h1>
        <p className="text-sm text-fg-muted">
          Development only. Label what the rulebook says a window must (and must not) detect; the
          platform&apos;s detections are suggestions to accept or reject, not the answer.
        </p>
      </div>
      {error ? (
        <Alert tone="crit" title="Something went wrong">
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Window</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="lab-instrument">Instrument</Label>
            <Select
              id="lab-instrument"
              value={instrument?.id ?? ''}
              onChange={(e) => setInstrumentId(e.target.value)}
            >
              {instruments.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.displayName}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lab-tf">Timeframe</Label>
            <Select id="lab-tf" value={tf} onChange={(e) => setTf(e.target.value as Tf)}>
              {TFS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lab-end">Window ends (UTC)</Label>
            <Input id="lab-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lab-count">Candles</Label>
            <Input
              id="lab-count"
              type="number"
              min={20}
              max={500}
              value={count}
              onChange={(e) => setCount(Math.max(20, Math.min(500, Number(e.target.value) || 20)))}
            />
          </div>
          <Button onClick={() => void load()} busy={busy} disabled={!instrument}>
            Load
          </Button>
          <div className="space-y-1">
            <Label htmlFor="lab-review">Or review a fixture file</Label>
            <Input
              id="lab-review"
              type="file"
              accept="application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void review(file);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {loaded ? (
        <>
          <LabelChart
            loaded={loaded}
            candidates={candidates}
            verdicts={verdicts}
            selected={selected}
            onSelect={setSelected}
          />
          <Card>
            <CardHeader>
              <CardTitle>Detections in the window</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="lab-kind">Add a detection the platform missed</Label>
                  <Select id="lab-kind" value={kind} onChange={(e) => setKind(e.target.value as ManualKind)}>
                    {Object.keys(MANUAL_KINDS).map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </Select>
                </div>
                <Button variant="secondary" onClick={addManual} disabled={selected === null}>
                  {selected === null
                    ? 'Select a candle on the chart'
                    : `Add at ${utc(loaded.candles[selected]!.t)}`}
                </Button>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Decided</Th>
                    <Th>Detection</Th>
                    <Th>Label</Th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <Td className="whitespace-nowrap">{utc(c.at)}</Td>
                      <Td>{c.summary}</Td>
                      <Td>
                        <fieldset className="flex gap-3" aria-label={`Label for ${c.summary}`}>
                          {(['expected', 'not_expected', 'none'] as const).map((v) => (
                            <label key={v} className="flex items-center gap-1 text-sm">
                              <input
                                type="radio"
                                name={c.id}
                                checked={(verdicts[c.id] ?? 'none') === v}
                                onChange={() => {
                                  const next = { ...verdicts };
                                  if (v === 'none') delete next[c.id];
                                  else next[c.id] = v;
                                  setVerdicts(next);
                                }}
                              />
                              {v === 'expected'
                                ? 'Must detect'
                                : v === 'not_expected'
                                  ? 'Must not'
                                  : 'Unlabelled'}
                            </label>
                          ))}
                        </fieldset>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Fixture</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="lab-id">Id</Label>
                <Input
                  id="lab-id"
                  value={meta.id}
                  placeholder="sweep-btc-asia-001"
                  onChange={(e) => setMeta({ ...meta, id: e.target.value })}
                />
              </div>
              <div className="flex gap-3">
                <div className="space-y-1">
                  <Label htmlFor="lab-concept">Concept</Label>
                  <Select
                    id="lab-concept"
                    value={meta.concept}
                    onChange={(e) => setMeta({ ...meta, concept: e.target.value as FixtureMeta['concept'] })}
                  >
                    {CONCEPTS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lab-class">Case</Label>
                  <Select
                    id="lab-class"
                    value={meta.class}
                    onChange={(e) => setMeta({ ...meta, class: e.target.value as FixtureMeta['class'] })}
                  >
                    {CLASSES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="lab-description">What the window shows, and why each label holds</Label>
                <Input
                  id="lab-description"
                  value={meta.description}
                  onChange={(e) => setMeta({ ...meta, description: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lab-by">Labelled by</Label>
                <Input
                  id="lab-by"
                  value={meta.labelledBy}
                  onChange={(e) => setMeta({ ...meta, labelledBy: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lab-reviewer">Reviewed by (a second person)</Label>
                <Input
                  id="lab-reviewer"
                  value={meta.reviewedBy ?? ''}
                  onChange={(e) =>
                    setMeta({ ...meta, reviewedBy: e.target.value.trim() ? e.target.value : null })
                  }
                />
              </div>
              <div className="flex items-center gap-3 sm:col-span-2">
                <Button onClick={download} disabled={!canExport}>
                  Download fixture
                </Button>
                <span className="text-sm text-fg-muted">
                  {labelledCount} labelled · {loaded.candles.length} candles ({WARMUP} before the window for
                  warm-up)
                </span>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** Candles with the platform's detections drawn over them; a click selects a candle. */
function LabelChart({
  loaded,
  candidates,
  verdicts,
  selected,
  onSelect,
}: {
  loaded: Loaded;
  candidates: readonly Candidate[];
  verdicts: Readonly<Record<string, Verdict>>;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const { candles, windowFrom, overlay, tf } = loaded;
  const W = 960;
  const H = 380;
  const pad = { l: 56, r: 8, t: 8, b: 8 };
  if (candles.length === 0) return <Alert tone="warn" title="No candles stored for this window" />;
  const highs = candles.map((c) => Number(c.h));
  const lows = candles.map((c) => Number(c.l));
  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const slot = (W - pad.l - pad.r) / candles.length;
  const first = candles[0]!.t;
  const x = (t: number) => pad.l + ((t - first) / TF_MS[tf]) * slot;
  const y = (p: number) => pad.t + ((top - p) / (top - bottom || 1)) * (H - pad.t - pad.b);
  const marked = new Set(candidates.filter((c) => verdicts[c.id] === 'expected').map((c) => c.at));
  return (
    <Card>
      <CardContent>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${candles.length} ${tf} candles of ${loaded.instrument.displayName}`}
        >
          <rect
            x={pad.l}
            y={0}
            width={Math.max(0, x(windowFrom) - pad.l)}
            height={H}
            className="fill-surface-2"
          />
          {overlay?.ranges.map((r) => (
            <rect
              key={r.id}
              x={x(r.windowStart)}
              y={y(Number(r.high))}
              width={Math.max(slot, x(r.endedAt ?? candles.at(-1)!.t + TF_MS[tf]) - x(r.windowStart))}
              height={Math.max(1, y(Number(r.low)) - y(Number(r.high)))}
              className="fill-info/10 stroke-info/50"
            />
          ))}
          {overlay?.levels.map((l) => (
            <line
              key={l.id}
              x1={x(l.knownAt)}
              x2={W - pad.r}
              y1={y(Number(l.price))}
              y2={y(Number(l.price))}
              className="stroke-warn/60"
              strokeDasharray="4 3"
            />
          ))}
          {candles.map((c, i) => {
            const up = Number(c.c) >= Number(c.o);
            const cx = x(c.t) + slot / 2;
            return (
              <g key={c.t} onClick={() => onSelect(i)} className="cursor-pointer">
                <rect
                  x={x(c.t)}
                  y={pad.t}
                  width={slot}
                  height={H - pad.t - pad.b}
                  className={selected === i ? 'fill-accent/20' : 'fill-transparent'}
                />
                <line
                  x1={cx}
                  x2={cx}
                  y1={y(Number(c.h))}
                  y2={y(Number(c.l))}
                  className={up ? 'stroke-ok' : 'stroke-crit'}
                />
                <rect
                  x={x(c.t) + slot * 0.15}
                  width={slot * 0.7}
                  y={y(Math.max(Number(c.o), Number(c.c)))}
                  height={Math.max(1, Math.abs(y(Number(c.o)) - y(Number(c.c))))}
                  className={up ? 'fill-ok' : 'fill-crit'}
                />
                {marked.has(c.t + TF_MS[tf]) ? (
                  <circle cx={cx} cy={pad.t + 4} r={3} className="fill-accent" />
                ) : null}
              </g>
            );
          })}
          {overlay?.swings.map((s) => (
            <text
              key={s.id}
              x={x(s.candleTime) + slot / 2}
              y={y(Number(s.price)) + (s.kind === 'high' ? -4 : 12)}
              textAnchor="middle"
              className="fill-fg-muted text-[9px]"
            >
              {s.kind === 'high' ? '▼' : '▲'}
            </text>
          ))}
          {overlay?.structure.map((b) => (
            <text
              key={b.id}
              x={x(b.breakCandleTime)}
              y={y(Number(b.breakPrice)) - 3}
              className="fill-fg text-[10px]"
            >
              {b.type.toUpperCase()}
            </text>
          ))}
          {overlay?.sweeps.map((w) => (
            <circle
              key={w.id}
              cx={x(w.breachAt) + slot / 2}
              cy={y(Number(w.extremePrice))}
              r={3.5}
              className="fill-none stroke-accent"
            />
          ))}
          <text x={4} y={14} className="fill-fg-muted text-[10px]">
            {top}
          </text>
          <text x={4} y={H - 4} className="fill-fg-muted text-[10px]">
            {bottom}
          </text>
        </svg>
        <p className="mt-2 text-xs text-fg-muted">
          Shaded: warm-up candles before the window. ▲▼ swings, BOS/CHOCH/MSS breaks, dashed levels, boxed
          ranges, circled sweep extremes. Click a candle to add a detection at it.
        </p>
      </CardContent>
    </Card>
  );
}
