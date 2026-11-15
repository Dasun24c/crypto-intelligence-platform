import { describe, expect, it } from 'vitest';
import { DelayTracker, HeartbeatTradeCheck, SequenceTracker, SilenceMonitor } from './gaps.js';

describe('SequenceTracker', () => {
  it('reports the exact missing range and ignores duplicates', () => {
    const s = new SequenceTracker();
    expect(s.observe(10)).toEqual({ kind: 'first' });
    expect(s.observe(11)).toEqual({ kind: 'ok' });
    expect(s.observe(11)).toEqual({ kind: 'duplicate' });
    expect(s.observe(15)).toEqual({ kind: 'gap', missingFrom: 12, missingTo: 14 });
    expect(s.lastSeen).toBe(15);
    s.reset();
    expect(s.observe(3)).toEqual({ kind: 'first' });
  });
});

describe('HeartbeatTradeCheck (Coinbase)', () => {
  it('waits one heartbeat before declaring trades missing, because channels can overtake each other', () => {
    const h = new HeartbeatTradeCheck();
    expect(h.onHeartbeat(105, 100)).toEqual({ kind: 'ok' }); // trades 101..105 may still be in flight
    expect(h.onHeartbeat(105, 105)).toEqual({ kind: 'ok' });
    expect(h.onHeartbeat(108, 105)).toEqual({ kind: 'ok' });
    expect(h.onHeartbeat(108, 106)).toEqual({ kind: 'gap', missingFrom: 107, missingTo: 108 });
    h.reset();
    expect(h.onHeartbeat(200, null)).toEqual({ kind: 'ok' });
  });
});

describe('SilenceMonitor (NFR-04)', () => {
  it('flags a stream after max(30 s, 3 × its expected interval)', () => {
    const m = new SilenceMonitor((stream) => (stream === 'kline' ? 20_000 : 100));
    m.touch('depth', 0);
    m.touch('kline', 0);
    expect(m.silent(30_000)).toEqual([]);
    expect(m.silent(30_001)).toEqual([{ stream: 'depth', since: 0 }]);
    expect(m.silent(60_001).map((s) => s.stream)).toEqual(['depth', 'kline']);
    m.forget('depth');
    expect(m.lastAt('depth')).toBeUndefined();
    expect(m.lastAt('kline')).toBe(0);
  });
});

describe('DelayTracker', () => {
  it('reports percentiles over the trailing minute and "delayed" above a 2 s median (criterion 2.5)', () => {
    const d = new DelayTracker();
    for (let i = 0; i < 10; i++) d.add(1_000 * i, 1_000 * i + 50);
    expect(d.percentile(50, 10_000)).toBe(50);
    expect(d.delayed(10_000)).toBe(false);
    for (let i = 10; i < 40; i++) d.add(1_000 * i, 1_000 * i + 3_000); // injected 3 s latency
    expect(d.delayed(43_000)).toBe(true);
    expect(d.percentile(95, 43_000)).toBe(3_000);
    expect(d.percentile(50, 200_000)).toBeNull(); // window empty
  });
});
