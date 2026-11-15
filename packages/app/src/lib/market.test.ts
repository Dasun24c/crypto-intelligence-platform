// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Closure } from '@cip/contracts';
import {
  BTC_BINANCE,
  BTC_COINBASE,
  BTC_REPLAY,
  feed,
  INSTRUMENTS,
  PAXG_BINANCE,
  USDT_COINBASE,
} from '../test/fixtures.js';
import { formatDuration, formatTime, safeTimeZone } from './format.js';
import {
  applyFeedEvents,
  defaultInstrument,
  goldMarketState,
  groupInstruments,
  instrumentFeed,
} from './market.js';

const H = 3_600_000;
const T = Date.UTC(2026, 10, 13, 12); // Friday 12:00 UTC
const closure = (from: number, to: number, reason: Closure['reason']): Closure => ({
  calendar: 'gold',
  from,
  to,
  reason,
  source: 'generated',
});

describe('instrument groups', () => {
  it('orders BTC, ETH, SOL, PAXG, then other assets, then reference rates; primary venue first', () => {
    const xrp = { ...BTC_BINANCE, id: 'x', base: 'XRP', isPrimaryVenue: true };
    const groups = groupInstruments([
      USDT_COINBASE,
      xrp,
      BTC_COINBASE,
      PAXG_BINANCE,
      BTC_REPLAY,
      BTC_BINANCE,
    ]);
    expect(groups.map((g) => g.key)).toEqual(['BTC', 'PAXG', 'XRP', 'reference']);
    expect(groups[0]!.instruments.map((i) => i.id)).toEqual([BTC_BINANCE.id, BTC_COINBASE.id, BTC_REPLAY.id]);
    expect(groups[1]!.title).toBe('PAXG (gold-backed token)');
    expect(groups[3]!.title).toBe('Reference rates');
    expect(defaultInstrument(INSTRUMENTS)?.id).toBe(BTC_BINANCE.id);
    expect(defaultInstrument([])).toBeNull();
  });
});

describe('gold-market hours', () => {
  it('is closed inside a closure, until its end', () => {
    expect(goldMarketState([closure(T - H, T + 2 * H, 'daily_break')], T)).toEqual({
      open: false,
      changesAt: T + 2 * H,
      reason: 'daily_break',
    });
  });

  it('treats touching or overlapping closures as one closed period, naming the holiday', () => {
    const state = goldMarketState(
      [
        closure(T, T + 49 * H, 'weekend'),
        closure(T - 2 * H, T + H, 'holiday'),
        closure(T + 49 * H, T + 50 * H, 'daily_break'),
      ],
      T + 30 * 60_000,
    );
    expect(state).toEqual({ open: false, changesAt: T + 50 * H, reason: 'holiday' });
  });

  it('is open between closures, with the next closing time', () => {
    const state = goldMarketState(
      [closure(T - 5 * H, T - 4 * H, 'daily_break'), closure(T + 3 * H, T + 4 * H, 'daily_break')],
      T,
    );
    expect(state).toEqual({ open: true, changesAt: T + 3 * H, reason: null });
    // The end of a closure is already open.
    expect(goldMarketState([closure(T - H, T, 'daily_break')], T)).toEqual({
      open: true,
      changesAt: null,
      reason: null,
    });
  });

  it('cannot say anything without a calendar', () => {
    expect(goldMarketState([], T)).toBeNull();
  });
});

describe('feed status', () => {
  it('applies live transitions newer than the polled list and keeps the open-gap counts', () => {
    const base = [feed(BTC_BINANCE.id, 'trades', { openGaps: 2 }), feed(BTC_BINANCE.id, 'depth')];
    const down = {
      ...feed(BTC_BINANCE.id, 'trades', { state: 'disconnected', detail: 'disconnected' }),
      previous: 'connected',
    };
    const merged = applyFeedEvents(
      base,
      1_000,
      new Map([[`${BTC_BINANCE.id}:trades`, { event: down, ts: 2_000 }]]),
    );
    expect(merged.find((f) => f.stream === 'trades')).toMatchObject({ state: 'disconnected', openGaps: 2 });
    // An older event does not override a newer list.
    const stale = applyFeedEvents(
      base,
      3_000,
      new Map([[`${BTC_BINANCE.id}:trades`, { event: down, ts: 2_000 }]]),
    );
    expect(stale.find((f) => f.stream === 'trades')?.state).toBe('connected');
  });

  it("summarises an instrument's streams by the worst one", () => {
    const feeds = [
      feed(BTC_BINANCE.id, 'trades'),
      feed(BTC_BINANCE.id, 'depth', { state: 'degraded', detail: 'delayed', openGaps: 1 }),
      feed(BTC_BINANCE.id, 'ticker', { state: 'disconnected', detail: 'not streaming' }),
    ];
    expect(instrumentFeed(feeds, BTC_BINANCE.id)).toEqual({
      state: 'disconnected',
      detail: 'depth: delayed; ticker: not streaming',
      openGaps: 1,
    });
    expect(instrumentFeed([feed(BTC_BINANCE.id, 'trades')], BTC_BINANCE.id).detail).toBe('streaming');
    const allDown = (['trades', 'depth'] as const).map((s) =>
      feed(BTC_BINANCE.id, s, { state: 'disconnected', detail: 'not streaming' }),
    );
    expect(instrumentFeed(allDown, BTC_BINANCE.id).detail).toBe('not streaming');
    expect(instrumentFeed(feeds, BTC_REPLAY.id).state).toBeNull();
  });
});

describe('time display', () => {
  it('formats durations to the minute, and falls back to UTC for an unknown zone', () => {
    expect(formatDuration(30_000)).toBe('less than a minute');
    expect(formatDuration(35 * 60_000)).toBe('35 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(formatDuration(52 * H)).toBe('2 d 4 h');
    expect(formatDuration(48 * H)).toBe('2 d');
    expect(safeTimeZone('Not/AZone')).toBe('UTC');
    expect(formatTime(T, 'Asia/Colombo')).toBe('17:30:00');
    expect(formatTime(T, 'Not/AZone')).toBe('12:00:00');
  });
});
