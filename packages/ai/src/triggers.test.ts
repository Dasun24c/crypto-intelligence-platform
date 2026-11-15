import { describe, expect, it } from 'vitest';
import type { AnalysisEventEntry, ScoredEvent } from './triggers.js';
import {
  DIGEST_EVERY_MS,
  digestJobId,
  digestSlot,
  eventJobId,
  scoreEvent,
  TRIGGER_COOLDOWN_MS,
  TRIGGER_WINDOW_MS,
  TriggerAggregator,
} from './triggers.js';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const T = Date.UTC(2026, 10, 16, 10);
const contextTfs = () => ['4h', '1h'] as const;

function setup(to: 'confirmed' | 'resolved' | 'triggered', id = 'setup-1'): AnalysisEventEntry {
  return {
    type: 'setup',
    data: { id, instrumentId: BTC, transition: { to, decidedAt: T } } as never,
  };
}
function smc(
  type: 'structure' | 'sweep',
  data: Record<string, unknown>,
  instrumentId = BTC,
): AnalysisEventEntry {
  return { type: 'smc', data: { instrumentId, time: T, type, data } as never };
}
function volume(z: number | null, tf = '1h', warmup = false): AnalysisEventEntry {
  return {
    type: 'indicators.closed',
    data: { instrumentId: BTC, tf, point: { t: T, volumeZ: z, warmup } } as never,
  };
}
const ev = (id: string, score = 50, instrumentId = BTC, bypassCooldown = false): ScoredEvent => ({
  instrumentId,
  ref: { kind: 'sweep', id, score, at: T },
  bypassCooldown,
});

describe('trigger scores (architecture §8)', () => {
  it('scores setups, context-timeframe MSS, day and week sweeps, and 1h volume anomalies', () => {
    expect(scoreEvent(setup('confirmed'), contextTfs)).toEqual({
      instrumentId: BTC,
      ref: { kind: 'setup.confirmed', id: 'setup-1', score: 100, at: T },
      bypassCooldown: true,
    });
    expect(scoreEvent(setup('resolved'), contextTfs)?.ref).toMatchObject({
      kind: 'setup.resolved',
      score: 60,
    });
    expect(scoreEvent(setup('triggered'), contextTfs)).toBeNull();
    expect(scoreEvent(smc('structure', { id: 's1', type: 'mss', tf: '4h' }), contextTfs)?.ref).toMatchObject({
      kind: 'structure.mss',
      score: 70,
    });
    // Not on a context timeframe, or not an MSS.
    expect(scoreEvent(smc('structure', { id: 's2', type: 'mss', tf: '15m' }), contextTfs)).toBeNull();
    expect(scoreEvent(smc('structure', { id: 's3', type: 'bos', tf: '4h' }), contextTfs)).toBeNull();
    expect(scoreEvent(smc('sweep', { id: 'w1', levelType: 'pwh' }), contextTfs)?.ref).toMatchObject({
      score: 50,
    });
    expect(scoreEvent(smc('sweep', { id: 'w2', levelType: 'eqh' }), contextTfs)).toBeNull();
    expect(scoreEvent({ type: 'smc', data: { type: 'zone.created' } } as never, contextTfs)).toBeNull();
    expect(scoreEvent(volume(-3.2), contextTfs)?.ref).toMatchObject({
      kind: 'volume.anomaly',
      score: 50,
      at: T + 3_600_000,
    });
    for (const quiet of [volume(2.9), volume(null), volume(4, '4h'), volume(4, '1h', true)])
      expect(scoreEvent(quiet, contextTfs)).toBeNull();
  });
});

describe('aggregation (criterion 9.4)', () => {
  it('turns a burst of 20 related events into one call, after its 60 s window', () => {
    const agg = new TriggerAggregator();
    for (let i = 0; i < 20; i++) agg.add(ev(`e${i}`, 50), T + i * 1_000);
    expect(agg.due(T + TRIGGER_WINDOW_MS - 1)).toEqual([]);
    const due = agg.due(T + TRIGGER_WINDOW_MS);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ instrumentId: BTC, windowStart: T, score: 1_000 });
    expect(due[0]!.refs).toHaveLength(20);
    expect(agg.due(T + 2 * TRIGGER_WINDOW_MS)).toEqual([]);
  });

  it('makes no call for a window under 100, and counts an event read twice once', () => {
    const agg = new TriggerAggregator();
    agg.add(ev('a', 50), T);
    agg.add(ev('a', 50), T + 1_000);
    expect(agg.isOpen(BTC)).toBe(true);
    expect(agg.due(T + TRIGGER_WINDOW_MS)).toEqual([]);
    expect(agg.openWindows).toBe(0);
    expect(agg.isOpen(BTC)).toBe(false);
  });

  it('cools an instrument down for 15 min after a call, except for a setup confirmation', () => {
    const agg = new TriggerAggregator();
    agg.add(ev('a', 100), T);
    expect(agg.due(T + TRIGGER_WINDOW_MS)).toHaveLength(1);
    const later = T + TRIGGER_WINDOW_MS + 60_000;
    expect(agg.add(ev('b', 100), later)).toBe('cooling');
    expect(agg.add(ev('c', 100, ETH), later)).toBe('opened');
    expect(agg.add(ev('d', 100, BTC, true), later)).toBe('opened');
    expect(agg.add(ev('e', 50), later + 1)).toBe('joined');
    expect(agg.due(later + TRIGGER_WINDOW_MS).map((d) => [d.instrumentId, d.score])).toEqual([
      [BTC, 150],
      [ETH, 100],
    ]);
    // After the cooldown, windows open again.
    const after = later + TRIGGER_WINDOW_MS + TRIGGER_COOLDOWN_MS;
    expect(agg.add(ev('f', 100), after)).toBe('opened');
  });

  it('keeps a cooldown known from before a takeover', () => {
    const agg = new TriggerAggregator();
    agg.coolDown(BTC, T + 5 * 60_000);
    expect(agg.cooling(BTC, T)).toBe(true);
    expect(agg.add(ev('a', 100), T)).toBe('cooling');
    expect(agg.cooling(BTC, T + 5 * 60_000)).toBe(false);
  });

  it('names digest slots and jobs deterministically', () => {
    expect(digestSlot(Date.UTC(2026, 10, 16, 7, 59))).toBe(Date.UTC(2026, 10, 16, 4));
    expect(digestSlot(Date.UTC(2026, 10, 16, 8))).toBe(Date.UTC(2026, 10, 16, 8));
    expect(DIGEST_EVERY_MS).toBe(4 * 3_600_000);
    expect(eventJobId(BTC, T)).toBe(`event.${BTC}.${T}`);
    expect(digestJobId(BTC, T)).toBe(`digest.${BTC}.${T}`);
  });
});
