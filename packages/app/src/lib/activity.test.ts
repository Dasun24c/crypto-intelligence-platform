// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DataGap } from '@cip/contracts';
import { BTC_BINANCE, largeTrade, spread, wall } from '../test/fixtures.js';
import {
  gapClosure,
  gapFromEvent,
  liveGapsReducer,
  liveSpreadsReducer,
  liveTradesReducer,
  liveWallsReducer,
  mergeGaps,
  mergeTrades,
  mergeWalls,
  NO_LIVE_GAPS,
  NO_LIVE_TRADES,
  NO_LIVE_WALLS,
  spreadSeries,
} from './activity.js';

const ID = BTC_BINANCE.id;

describe('large trades', () => {
  it('merges REST pages, live trades and resync snapshots, newest first, each once', () => {
    const [t1, t2, t3, t4] = [1, 2, 3, 4].map((n) => largeTrade(n, ID));
    let live = liveTradesReducer(NO_LIVE_TRADES, { type: 'trade', trade: t3! });
    live = liveTradesReducer(live, { type: 'trade', trade: t2! }); // also in the REST page
    live = liveTradesReducer(live, { type: 'snapshot', trades: [t4!, t3!] });
    expect(mergeTrades([t2!, t1!], live).map((t) => t.id)).toEqual([t4!.id, t3!.id, t2!.id, t1!.id]);
  });
});

describe('walls', () => {
  it('moves an ended wall out of the standing list, and never back', () => {
    const standing = wall(1, ID);
    const ended = { ...standing, endedReason: 'filled' as const, lastSeen: standing.lastSeen + 1 };
    const live = liveWallsReducer(NO_LIVE_WALLS, { type: 'wall', wall: ended });
    // A slow REST answer still listing the wall as standing does not resurrect it.
    const merged = mergeWalls([standing], [], live);
    expect(merged.standing).toEqual([]);
    expect(merged.ended.map((w) => w.endedReason)).toEqual(['filled']);
  });

  it('takes the standing walls from a resync snapshot, keeping the ended history', () => {
    const a = wall(1, ID, { maxNotionalUsd: '100' });
    const b = wall(2, ID, { maxNotionalUsd: '900' });
    const gone = wall(3, ID, { endedReason: 'pulled' });
    let live = liveWallsReducer(NO_LIVE_WALLS, { type: 'wall', wall: gone });
    live = liveWallsReducer(live, { type: 'wall', wall: a });
    live = liveWallsReducer(live, { type: 'snapshot', standing: [b] });
    const merged = mergeWalls([a], [], live);
    expect(merged.standing.map((w) => w.id)).toEqual([b.id]);
    expect(merged.ended.map((w) => w.id)).toEqual([gone.id]);
    // Largest first.
    expect(mergeWalls([a, b], [], NO_LIVE_WALLS).standing.map((w) => w.id)).toEqual([b.id, a.id]);
  });
});

describe('data gaps', () => {
  const rest: DataGap = {
    id: 'g1',
    instrumentId: ID,
    stream: 'trades',
    from: 1,
    to: 2,
    detectedAt: 10,
    detectedBy: 'reconnect',
    status: 'repaired',
    resolvedAt: 20,
    details: { fetched: 3 },
  };

  it('reads gap messages and refuses malformed ones', () => {
    expect(
      gapFromEvent(
        { gapId: 'g2', instrumentId: ID, stream: 'depth', from: 5, to: null, detectedBy: 'sequence' },
        30,
      ),
    ).toMatchObject({ id: 'g2', status: 'open', detectedAt: 30, to: null, detectedBy: 'sequence' });
    expect(gapFromEvent({ instrumentId: ID }, 30)).toBeNull();
    expect(gapFromEvent(null, 30)).toBeNull();
    expect(gapClosure({ gapId: 'g2', status: 'unrepairable', reason: 'venue outage' })).toEqual({
      gapId: 'g2',
      status: 'unrepairable',
    });
    expect(gapClosure('nope')).toBeNull();
  });

  it('follows gaps as they open and close; a status never goes backwards', () => {
    const opened = gapFromEvent(
      { gapId: 'g2', instrumentId: ID, stream: 'depth', from: 5, to: null, detectedBy: 'sequence' },
      30,
    )!;
    let live = liveGapsReducer(NO_LIVE_GAPS, { type: 'opened', gap: opened });
    expect(mergeGaps([rest], live).map((g) => [g.id, g.status])).toEqual([
      ['g2', 'open'],
      ['g1', 'repaired'],
    ]);
    live = liveGapsReducer(live, { type: 'closed', gapId: 'g2', status: 'repaired', at: 40 });
    expect(mergeGaps([rest], live)[0]).toMatchObject({ id: 'g2', status: 'repaired', resolvedAt: 40 });
    // A stale "open" (from a snapshot) does not undo a repair that REST already reports.
    const snapshot = liveGapsReducer(NO_LIVE_GAPS, { type: 'snapshot', open: [{ ...rest, status: 'open' }] });
    expect(mergeGaps([rest], snapshot)[0]?.status).toBe('repaired');
  });
});

describe('cross-venue spread', () => {
  it('joins stored rows and live points from the window start, one per timestamp', () => {
    let live = liveSpreadsReducer([], spread(30, 2));
    live = liveSpreadsReducer(live, spread(40, 3));
    expect(spreadSeries([spread(5, 9), spread(20, 1), spread(30, 1.9)], live, 10)).toEqual([
      { ts: 20, bps: 1 },
      { ts: 30, bps: 2 },
      { ts: 40, bps: 3 },
    ]);
  });
});
