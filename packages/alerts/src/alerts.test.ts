import { describe, expect, it } from 'vitest';
import type { AlertCondition } from '@cip/contracts';
import {
  type AlertSource,
  AlertEvaluator,
  cooldownKey,
  decide,
  describeAlert,
  dryRun,
  type EvaluableRule,
  type InstrumentRef,
  inQuietHours,
  isLate,
  LATE_AFTER_MS,
  MemoryCooldown,
  quietMinutes,
  eventFromRow,
  ruleFromRow,
  SOURCE_OF,
} from './index.js';

const BTC = {
  id: '019a6f00-0000-7000-8000-000000000001',
  venue: 'binance' as const,
  name: 'BTC · Binance BTC/USDT',
};
const ETH = {
  id: '019a6f00-0000-7000-8000-000000000002',
  venue: 'coinbase' as const,
  name: 'ETH · Coinbase ETH-USD',
};
const T = Date.UTC(2026, 10, 12, 10, 0);
const MIN = 60_000;

function rule(condition: AlertCondition, extra: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: 'rule-1',
    ownerId: 'owner-1',
    name: 'test rule',
    scope: {},
    condition,
    severity: 'info',
    cooldownSec: 300,
    ...extra,
  };
}
const price = (at: number, p: string, instrument: InstrumentRef = BTC): AlertSource => ({
  kind: 'price',
  instrument,
  at,
  price: p,
});
const indicator = (
  candleTime: number,
  values: Partial<Record<'rsi' | 'macd_hist' | 'volume_z' | 'atr', number>>,
  tf: '5m' | '1h' = '1h',
): Extract<AlertSource, { kind: 'indicator' }> => ({
  kind: 'indicator',
  instrument: BTC,
  tf,
  candleTime,
  at: candleTime + 3_600_000,
  values: { rsi: null, macd_hist: null, volume_z: null, atr: null, ...values },
  decidedAt: candleTime + 3_600_000,
  processedAt: candleTime + 3_600_000 + 200,
});

/** Runs sources through one evaluator and returns the dedupe keys that matched. */
function keys(r: EvaluableRule, sources: AlertSource[]): string[] {
  const ev = new AlertEvaluator();
  return sources.flatMap((s) => ev.evaluate([r], s).map(({ match }) => match.dedupeKey));
}

describe('conditions (criterion 8.1, unit)', () => {
  it('price_cross fires on the crossing only, in the direction asked, never on the first price', () => {
    const above = rule({ kind: 'price_cross', price: '100000', direction: 'above' });
    expect(
      keys(above, [
        price(T, '100500'),
        price(T + 1000, '99999.9'),
        price(T + 2000, '100000'),
        price(T + 3000, '100100'),
      ]),
    ).toEqual([`price_cross:${BTC.id}:above:100000:${T + 2000}`]);
    const below = rule({ kind: 'price_cross', price: '100000', direction: 'below' });
    expect(keys(below, [price(T, '100001'), price(T + 1000, '99999'), price(T + 2000, '98000')])).toEqual([
      `price_cross:${BTC.id}:below:100000:${T + 1000}`,
    ]);
  });

  it('price_change_pct compares with the price a window ago, and fires again only after falling back', () => {
    const r = rule({ kind: 'price_change_pct', windowMin: 5, pct: 2 });
    const sources = [
      price(T, '100'),
      price(T + 2 * MIN, '101'),
      price(T + 4 * MIN, '101.9'), // the window (5 min) is not covered yet
      price(T + 5 * MIN, '102'), // +2 % against T
      price(T + 5 * MIN + 1000, '102.5'), // still beyond: no second alert
      price(T + 9 * MIN, '101'), // −0.9 % against minute T+4m (101.9): back inside
      // Minutes 6 to 8 had no price: the reference is the next one, minute 9 (101). −2.08 %.
      price(T + 11 * MIN, '98.9'),
    ];
    const fired = keys(r, sources);
    expect(fired[0]).toBe(`price_change_pct:${BTC.id}:${T + 5 * MIN}`);
    expect(fired).toHaveLength(2);
    expect(fired[1]).toBe(`price_change_pct:${BTC.id}:${T + 11 * MIN}`);
  });

  it('indicator_threshold: levels fire on every closed candle, crossings only when crossed', () => {
    const over = rule({ kind: 'indicator_threshold', tf: '1h', indicator: 'rsi', op: '>', value: 70 });
    expect(
      keys(over, [indicator(T, { rsi: 71 }), indicator(T + 1, { rsi: 72 }), indicator(T + 2, { rsi: 69 })]),
    ).toHaveLength(2);
    const under = rule({ kind: 'indicator_threshold', tf: '1h', indicator: 'rsi', op: '<', value: 30 });
    expect(
      keys(under, [indicator(T, { rsi: 29 }), indicator(T + 1, { rsi: null as unknown as number })]),
    ).toHaveLength(1);
    const up = rule({
      kind: 'indicator_threshold',
      tf: '1h',
      indicator: 'macd_hist',
      op: 'cross_above',
      value: 0,
    });
    expect(
      keys(up, [
        indicator(T, { macd_hist: 0.5 }),
        indicator(T + 1, { macd_hist: -0.2 }),
        indicator(T + 2, { macd_hist: 0.1 }),
      ]),
    ).toEqual([`indicator:${BTC.id}:1h:macd_hist:cross_above:0:${T + 2}`]);
    const down = rule({
      kind: 'indicator_threshold',
      tf: '1h',
      indicator: 'atr',
      op: 'cross_below',
      value: 10,
    });
    expect(
      keys(down, [indicator(T, { atr: 12 }), indicator(T + 1, { atr: 9 }), indicator(T + 2, { atr: 8 })]),
    ).toHaveLength(1);
    // Another timeframe is not this rule's.
    expect(keys(over, [indicator(T, { rsi: 90 }, '5m')])).toEqual([]);
  });

  it('volume_anomaly fires at or above the z-score', () => {
    const r = rule({ kind: 'volume_anomaly', tf: '1h', minZ: 3 });
    expect(
      keys(r, [indicator(T, { volume_z: 2.9 }), indicator(T + 1, { volume_z: 3 }), indicator(T + 2, {})]),
    ).toEqual([`volume:${BTC.id}:1h:${T + 1}`]);
  });

  it('smc_event filters by timeframe, event, level type and zone type', () => {
    const smc = (
      event: 'sweep' | 'false_breakout' | 'mss' | 'poi_entry',
      extra: Partial<Extract<AlertSource, { kind: 'smc' }>> = {},
    ): AlertSource => ({
      kind: 'smc',
      instrument: BTC,
      tf: '1h',
      event,
      id: `${event}-1`,
      at: T,
      price: '98000',
      direction: 'bearish',
      levelType: event === 'sweep' || event === 'false_breakout' ? 'pdh' : null,
      zoneType: event === 'poi_entry' ? 'order_block' : null,
      decidedAt: T,
      processedAt: T + 300,
      ...extra,
    });
    const r = rule({
      kind: 'smc_event',
      tfs: ['1h'],
      events: ['sweep', 'mss', 'poi_entry'],
      levelTypes: ['pdh'],
      zoneTypes: ['fvg'],
    });
    expect(
      keys(r, [
        smc('sweep'),
        smc('mss'),
        smc('false_breakout'),
        smc('poi_entry'),
        smc('sweep', { levelType: 'eql' }),
      ]),
    ).toEqual(['smc:sweep:sweep-1', 'smc:mss:mss-1']);
    expect(keys(r, [smc('poi_entry', { zoneType: 'fvg' }), smc('mss', { tf: '4h' })])).toEqual([
      'smc:poi_entry:poi_entry-1',
    ]);
  });

  it('setup_transition filters by state, pattern, direction and score', () => {
    const setup = (
      toState: 'triggered' | 'confirmed',
      score: number,
      pattern = 'htf_order_block' as const,
    ): AlertSource => ({
      kind: 'setup',
      instrument: ETH,
      tf: '15m',
      setupId: `s-${toState}-${score}`,
      pattern,
      direction: 'bullish',
      toState,
      score,
      at: T,
      decidedAt: T,
      processedAt: T + 500,
    });
    const r = rule({
      kind: 'setup_transition',
      toStates: ['confirmed'],
      patterns: ['htf_order_block'],
      directions: ['bullish'],
      minScore: 70,
    });
    expect(keys(r, [setup('confirmed', 80), setup('confirmed', 60), setup('triggered', 90)])).toEqual([
      'setup:s-confirmed-80:confirmed',
    ]);
    expect(
      keys(rule({ kind: 'setup_transition', toStates: ['confirmed'], directions: ['bearish'] }), [
        setup('confirmed', 80),
      ]),
    ).toEqual([]);
  });

  it('spread_threshold fires when the spread passes the threshold either way, again only after coming back', () => {
    const r = rule({ kind: 'spread_threshold', baseAsset: 'PAXG', absBps: 30 });
    const spread = (at: number, bps: number): AlertSource => ({ kind: 'spread', baseAsset: 'PAXG', at, bps });
    expect(
      keys(r, [spread(T, 10), spread(T + 1, 31), spread(T + 2, 40), spread(T + 3, 5), spread(T + 4, -35)]),
    ).toEqual([`spread:${T + 1}`, `spread:${T + 4}`]);
  });

  it('economic_event_upcoming fires inside the lead time for releases of the impact asked', () => {
    const r = rule({ kind: 'economic_event_upcoming', minImpact: 'high', minutesBefore: 30 });
    const cpi = {
      id: 'cpi-1',
      title: 'CPI',
      scheduledAt: T + 60 * MIN,
      impact: 'high' as const,
      currency: 'USD',
    };
    const gdp = { ...cpi, id: 'gdp-1', title: 'GDP', impact: 'medium' as const };
    type Release = Extract<AlertSource, { kind: 'economic_event' }>['event'];
    const at = (ms: number, event: Release = cpi): AlertSource => ({ kind: 'economic_event', at: ms, event });
    expect(
      keys(r, [
        at(T + 29 * MIN),
        at(T + 30 * MIN),
        at(T + 59 * MIN),
        at(T + 60 * MIN),
        at(T + 31 * MIN, gdp),
      ]),
    ).toEqual([`economic:cpi-1:${cpi.scheduledAt}:30`, `economic:cpi-1:${cpi.scheduledAt}:30`]);
    expect(
      keys(rule({ kind: 'economic_event_upcoming', minImpact: 'medium', minutesBefore: 30 }), [
        at(T + 31 * MIN, gdp),
      ]),
    ).toHaveLength(1);
  });

  it('gold_market_session fires on the changes asked for', () => {
    const r = rule({ kind: 'gold_market_session', on: ['open'] });
    const change = (c: 'open' | 'close', at: number): AlertSource => ({
      kind: 'gold_session',
      at,
      change: c,
      boundaryAt: at,
    });
    expect(keys(r, [change('close', T), change('open', T + MIN)])).toEqual([`gold_session:open:${T + MIN}`]);
  });

  it('large_trade and wall filter by size, side and event', () => {
    const trade = (id: string, side: 'buy' | 'sell', usd: string): AlertSource => ({
      kind: 'large_trade',
      instrument: BTC,
      id,
      at: T,
      side,
      price: '98000',
      usd,
      processedAt: T + 100,
    });
    expect(
      keys(rule({ kind: 'large_trade', minUsd: '1000000', sides: ['buy'] }), [
        trade('a', 'buy', '1500000'),
        trade('b', 'buy', '999999'),
        trade('c', 'sell', '5000000'),
      ]),
    ).toEqual(['large_trade:a']);
    expect(keys(rule({ kind: 'large_trade' }), [trade('d', 'sell', '10')])).toEqual(['large_trade:d']);
    const wall = (event: 'appeared' | 'pulled' | 'filled', usd: string): AlertSource => ({
      kind: 'wall',
      instrument: BTC,
      id: 'w1',
      at: T,
      event,
      side: 'bid',
      price: '97000',
      usd,
      processedAt: T + 100,
    });
    expect(
      keys(rule({ kind: 'wall', minUsd: '2000000', events: ['appeared', 'pulled'] }), [
        wall('appeared', '3000000'),
        wall('filled', '3000000'),
        wall('pulled', '1000000'),
      ]),
    ).toEqual(['wall:w1:appeared']);
  });

  it('feed_health fires on the events asked for', () => {
    const feed = (event: 'gap' | 'halted' | 'delayed', id: string): AlertSource => ({
      kind: 'feed',
      instrument: ETH,
      id,
      at: T,
      event,
      detail: 'detail',
      processedAt: T + 50,
    });
    expect(
      keys(rule({ kind: 'feed_health', events: ['halted', 'gap'] }), [
        feed('halted', 'h'),
        feed('delayed', 'd'),
        feed('gap', 'g'),
      ]),
    ).toEqual(['feed:halted:h', 'feed:gap:g']);
  });

  it('covers every condition kind, each reading one source kind', () => {
    // Twelve from Phase 8, the two practice-trading kinds of Phase 14, and two of Phase 16.
    expect(Object.keys(SOURCE_OF).sort()).toHaveLength(16);
  });
});

describe('scope', () => {
  it('limits a rule to its instruments and venues; calendar and gold rules ignore it', () => {
    const r = rule(
      { kind: 'price_cross', price: '10', direction: 'above' },
      { scope: { instrumentIds: [ETH.id] } },
    );
    expect(keys(r, [price(T, '9'), price(T + 1, '11')])).toEqual([]);
    expect(keys(r, [price(T, '9', ETH), price(T + 1, '11', ETH)])).toHaveLength(1);
    const coinbase = rule(
      { kind: 'price_cross', price: '10', direction: 'above' },
      { scope: { venues: ['coinbase'] } },
    );
    expect(keys(coinbase, [price(T, '9'), price(T + 1, '11')])).toEqual([]);
    const gold = rule({ kind: 'gold_market_session', on: ['close'] }, { scope: { venues: ['coinbase'] } });
    expect(keys(gold, [{ kind: 'gold_session', at: T, change: 'close', boundaryAt: T }])).toHaveLength(1);
  });
});

describe('late (criterion 8.5)', () => {
  it('labels sources processed more than 120 s after they were decided', () => {
    const on = indicator(T, { rsi: 80 });
    expect(isLate(on)).toBe(false);
    expect(isLate({ ...on, processedAt: on.decidedAt + LATE_AFTER_MS + 1 })).toBe(true);
    expect(
      isLate({
        kind: 'feed',
        instrument: BTC,
        id: 'g',
        at: T,
        event: 'gap',
        detail: '',
        processedAt: T + 121_000,
      }),
    ).toBe(true);
    expect(isLate(price(T, '1'))).toBe(false);
    const ev = new AlertEvaluator();
    const [hit] = ev.evaluate(
      [rule({ kind: 'indicator_threshold', tf: '1h', indicator: 'rsi', op: '>', value: 70 })],
      { ...on, processedAt: on.decidedAt + 10 * MIN },
    );
    expect(hit?.match.late).toBe(true);
  });
});

describe('cooldown and de-duplication', () => {
  it('lets exactly one of 100 identical triggers inside the cooldown through (criterion 8.3)', async () => {
    const r = rule({ kind: 'feed_health', events: ['halted'] }, { cooldownSec: 300 });
    const ev = new AlertEvaluator();
    const gate = new MemoryCooldown();
    const decisions: string[] = [];
    for (let i = 0; i < 100; i++) {
      const source: AlertSource = {
        kind: 'feed',
        instrument: BTC,
        id: `halt-${i}`,
        at: T + i * 1000,
        event: 'halted',
        detail: '',
        processedAt: T + i * 1000,
      };
      for (const { match } of ev.evaluate([r], source))
        decisions.push(await decide(r, match, ev.memory, gate));
    }
    expect(decisions.filter((d) => d === 'fire')).toHaveLength(1);
    expect(decisions.filter((d) => d === 'cooldown')).toHaveLength(99);
  });

  it('never fires the same occurrence twice, and counts the cooldown per rule and subject', async () => {
    const r = rule({ kind: 'feed_health', events: ['gap'] }, { cooldownSec: 0 });
    const ev = new AlertEvaluator();
    const gate = new MemoryCooldown();
    const gap: AlertSource = {
      kind: 'feed',
      instrument: BTC,
      id: 'g1',
      at: T,
      event: 'gap',
      detail: '',
      processedAt: T,
    };
    const [first] = ev.evaluate([r], gap);
    expect(await decide(r, first!.match, ev.memory, gate)).toBe('fire');
    const [again] = ev.evaluate([r], gap);
    expect(await decide(r, again!.match, ev.memory, gate)).toBe('seen');
    const cooled = new MemoryCooldown();
    expect(cooled.tryAcquire(cooldownKey('r', BTC.id), T, 60_000)).toBe(true);
    expect(cooled.tryAcquire(cooldownKey('r', ETH.id), T, 60_000)).toBe(true);
    expect(cooled.tryAcquire(cooldownKey('r', BTC.id), T + 59_999, 60_000)).toBe(false);
    expect(cooled.tryAcquire(cooldownKey('r', BTC.id), T + 60_000, 60_000)).toBe(true);
  });
});

describe('quiet hours', () => {
  const night = { start: '22:00', end: '07:00', timeZone: 'Asia/Colombo' };
  // Colombo is UTC+5:30 all year.
  const colombo = (h: number, m = 0, day = 12) => Date.UTC(2026, 10, day, h, m) - 5.5 * 3_600_000;

  it('covers a window that crosses midnight, in the rule’s time zone', () => {
    expect(inQuietHours(night, colombo(23))).toBe(true);
    expect(inQuietHours(night, colombo(6, 59))).toBe(true);
    expect(inQuietHours(night, colombo(7))).toBe(false);
    expect(inQuietHours(night, colombo(21, 59))).toBe(false);
    expect(inQuietHours(null, colombo(23))).toBe(false);
    expect(
      inQuietHours({ start: '12:00', end: '13:00', timeZone: 'UTC' }, Date.UTC(2026, 10, 12, 12, 30)),
    ).toBe(true);
    expect(quietMinutes(night)).toBe(9 * 60);
  });

  it('applies on the days a window starts, and follows daylight saving', () => {
    // 12 November 2026 is a Thursday (4); the window that starts on it ends on Friday morning.
    const weekdays = { ...night, days: [4] };
    expect(inQuietHours(weekdays, colombo(23, 0, 12))).toBe(true);
    expect(inQuietHours(weekdays, colombo(3, 0, 13))).toBe(true);
    expect(inQuietHours(weekdays, colombo(23, 0, 13))).toBe(false);
    expect(
      inQuietHours({ start: '09:00', end: '17:00', timeZone: 'UTC', days: [6] }, Date.UTC(2026, 10, 12, 10)),
    ).toBe(false);
    // New York: 22:30 local is 03:30 UTC in winter and 02:30 UTC in summer.
    const ny = { start: '22:00', end: '23:00', timeZone: 'America/New_York' };
    expect(inQuietHours(ny, Date.UTC(2026, 11, 2, 3, 30))).toBe(true);
    expect(inQuietHours(ny, Date.UTC(2026, 6, 2, 2, 30))).toBe(true);
    expect(inQuietHours(ny, Date.UTC(2026, 6, 2, 3, 30))).toBe(false);
  });
});

describe('dry run (criterion 8.6)', () => {
  it('lists what the rule fires, in time order, with its cooldown measured in source time', async () => {
    const r = rule({ kind: 'feed_health', events: ['gap'] }, { cooldownSec: 600 });
    const gap = (id: string, at: number): AlertSource => ({
      kind: 'feed',
      instrument: BTC,
      id,
      at,
      event: 'gap',
      detail: 'missing',
      processedAt: at,
    });
    const result = await dryRun(r, [
      gap('c', T + 11 * MIN),
      gap('a', T),
      gap('b', T + 5 * MIN),
      price(T, '1'),
    ]);
    expect(result.evaluated).toBe(3);
    expect(result.suppressed).toBe(1);
    expect(result.wouldHaveFired.map((m) => m.dedupeKey)).toEqual(['feed:gap:a', 'feed:gap:c']);
  });
});

describe('messages', () => {
  it('state what happened; setup alerts say their levels are hypothetical', () => {
    const ev = new AlertEvaluator();
    const [setup] = ev.evaluate([rule({ kind: 'setup_transition', toStates: ['confirmed'] })], {
      kind: 'setup',
      instrument: ETH,
      tf: '15m',
      setupId: 's1',
      pattern: 'double_liquidity_trap',
      direction: 'bearish',
      toState: 'confirmed',
      score: 85,
      at: T,
      decidedAt: T,
      processedAt: T,
    });
    expect(setup?.match.title).toBe(
      'ETH · Coinbase ETH-USD 15m: Pattern 1, double liquidity trap, bearish, confirmed',
    );
    expect(setup?.match.body).toMatch(/hypothetical\. Educational analysis — not financial advice\.$/);
    const titles = [
      [
        rule({ kind: 'spread_threshold', baseAsset: 'PAXG', absBps: 30 }),
        { kind: 'spread', baseAsset: 'PAXG', at: T, bps: -42.25 },
      ],
      [
        rule({ kind: 'gold_market_session', on: ['close'] }),
        { kind: 'gold_session', at: T, change: 'close', boundaryAt: T },
      ],
      [
        rule({ kind: 'large_trade' }),
        {
          kind: 'large_trade',
          instrument: BTC,
          id: 't',
          at: T,
          side: 'buy',
          price: '98000',
          usd: '1250000',
          processedAt: T,
        },
      ],
      [
        rule({ kind: 'wall', events: ['appeared'] }),
        {
          kind: 'wall',
          instrument: BTC,
          id: 'w',
          at: T,
          event: 'appeared',
          side: 'ask',
          price: '99000',
          usd: '850000',
          processedAt: T,
        },
      ],
    ] as const;
    expect(
      titles.map(([r, s]) => new AlertEvaluator().evaluate([r], s as AlertSource)[0]?.match.title),
    ).toEqual([
      'PAXG spread 42.3 bps',
      'Gold market closed',
      'BTC · Binance BTC/USDT: large buy $1.3M',
      'BTC · Binance BTC/USDT: ask wall appeared $850k',
    ]);
    expect(
      describeAlert(rule({ kind: 'feed_health', events: ['gap'] }), price(T, '1'), {
        dedupeKey: '',
        subject: '',
        refs: {},
        facts: { change: 1, reference: '1' },
      }).title,
    ).toMatch(/up 1% in 0 min/);
  });
});

describe('stored rows', () => {
  const row = {
    id: 'rule-9',
    owner_id: 'user-9',
    name: 'Stored',
    enabled: true,
    scope: { instrumentIds: [BTC.id] },
    condition: { kind: 'feed_health', events: ['halted'] },
    severity: 'warning' as const,
    cooldown_sec: 120,
    channels: ['in_app', 'desktop', 'pager'],
    quiet_hours: { start: '22:00', end: '07:00', timeZone: 'UTC' },
    version: 3,
    created_at: new Date(T),
    updated_at: new Date(T + 1),
  };

  it('reads a stored rule as the contracts describe it, dropping channels it does not know', () => {
    expect(ruleFromRow(row)).toEqual({
      id: 'rule-9',
      ownerId: 'user-9',
      name: 'Stored',
      enabled: true,
      scope: { instrumentIds: [BTC.id] },
      condition: { kind: 'feed_health', events: ['halted'] },
      severity: 'warning',
      cooldownSec: 120,
      channels: ['in_app', 'desktop'],
      quietHours: { start: '22:00', end: '07:00', timeZone: 'UTC' },
      version: 3,
      createdAt: T,
      updatedAt: T + 1,
    });
    expect(ruleFromRow({ ...row, scope: null, quiet_hours: null })).toMatchObject({
      scope: {},
      quietHours: null,
    });
  });

  it('never evaluates a rule whose stored JSON no longer validates', () => {
    expect(ruleFromRow({ ...row, condition: { kind: 'telepathy' } })).toBeNull();
    expect(ruleFromRow({ ...row, scope: { instrumentIds: ['not-a-uuid'] } })).toBeNull();
    expect(
      ruleFromRow({ ...row, quiet_hours: { start: '25:00', end: '07:00', timeZone: 'UTC' } }),
    ).toBeNull();
  });

  it('reads a stored event, with its instrument when the references name one', () => {
    const event = {
      id: 'e1',
      rule_id: 'rule-9',
      fired_at: new Date(T),
      severity: 'info' as const,
      title: 't',
      body: 'b',
      source_refs: { instrumentId: BTC.id, tf: '1h' },
      late: true,
    };
    expect(eventFromRow(event, 'Stored')).toEqual({
      id: 'e1',
      ruleId: 'rule-9',
      ruleName: 'Stored',
      firedAt: T,
      severity: 'info',
      title: 't',
      body: 'b',
      instrumentId: BTC.id,
      sourceRefs: { instrumentId: BTC.id, tf: '1h' },
      late: true,
    });
    expect(eventFromRow({ ...event, source_refs: { baseAsset: 'PAXG' } }, 'x').instrumentId).toBeNull();
    expect(eventFromRow({ ...event, source_refs: { instrumentId: 'BTC' } }, 'x').instrumentId).toBeNull();
  });

  it('counts a repeated source once in a dry run', async () => {
    const r = rule({ kind: 'feed_health', events: ['gap'] }, { cooldownSec: 0 });
    const gap: AlertSource = {
      kind: 'feed',
      instrument: BTC,
      id: 'g',
      at: T,
      event: 'gap',
      detail: '',
      processedAt: T,
    };
    const result = await dryRun(r, [gap, { ...gap, at: T + 1 }]);
    expect(result.wouldHaveFired).toHaveLength(1);
    expect(result.suppressed).toBe(0);
  });
});

describe('practice trading alerts (ADR 021)', () => {
  const practice = (over: Partial<Extract<AlertSource, { kind: 'practice' }>> = {}): AlertSource => ({
    kind: 'practice',
    userId: 'owner-1',
    instrument: BTC,
    at: T,
    event: 'order_done',
    orderId: 'order-1',
    side: 'buy',
    quantity: '0.1',
    price: '100.5',
    processedAt: T,
    ...over,
  });

  it("fire for the owner's own orders only, once per order and outcome", () => {
    const e = new AlertEvaluator();
    const filled = rule({ kind: 'practice_order_filled' });
    const [hit] = e.evaluate([filled], practice());
    expect(hit?.match).toMatchObject({
      dedupeKey: 'practice:order-1:done',
      subject: 'order-1',
      title: 'BTC · Binance BTC/USDT: practice buy filled',
      body: 'Bought 0.1 at 100.5 on average. Practice trading: simulated, no real money.',
      instrumentId: BTC.id,
      late: false,
    });
    expect(e.evaluate([filled], practice({ userId: 'someone-else' }))).toEqual([]);
    expect(e.evaluate([filled], practice({ event: 'stop_filled' }))).toEqual([]);
    // Read long after it filled (the analyzer catching up): labelled late.
    const [caughtUp] = e.evaluate(
      [filled],
      practice({ orderId: 'order-2', processedAt: T + LATE_AFTER_MS + 1 }),
    );
    expect(caughtUp?.match.late).toBe(true);
  });

  it('tell a stop from a target, as the rule asks', () => {
    const e = new AlertEvaluator();
    const stops = rule({ kind: 'practice_exit', on: ['stop'] });
    const both = rule({ kind: 'practice_exit', on: ['stop', 'target'] }, { id: 'rule-2' });
    const stop = practice({ event: 'stop_filled', side: 'sell', orderId: 'leg-1' });
    const target = practice({ event: 'target_filled', side: 'sell', orderId: 'leg-2' });
    expect(e.evaluate([stops, both], stop).map((m) => [m.rule.id, m.match.title])).toEqual([
      ['rule-1', 'BTC · Binance BTC/USDT: practice stop reached'],
      ['rule-2', 'BTC · Binance BTC/USDT: practice stop reached'],
    ]);
    expect(e.evaluate([stops, both], target).map((m) => [m.rule.id, m.match.dedupeKey])).toEqual([
      ['rule-2', 'practice:leg-2:target'],
    ]);
    expect(e.evaluate([stops], practice())).toEqual([]);
    expect(e.evaluate([both], target)[0]?.match.body).toBe(
      'Sold 0.1 at 100.5 on average. Practice trading: simulated, no real money.',
    );
  });

  it('respect the rule scope by instrument', () => {
    const e = new AlertEvaluator();
    const onlyEth = rule({ kind: 'practice_order_filled' }, { scope: { instrumentIds: [ETH.id] } });
    expect(e.evaluate([onlyEth], practice())).toEqual([]);
    expect(e.evaluate([onlyEth], practice({ instrument: ETH }))).toHaveLength(1);
  });

  it('tell the owner when their automatic practice trading places an order (ADR 022)', () => {
    const e = new AlertEvaluator();
    const auto = rule({ kind: 'practice_auto_order' });
    const placed = practice({ event: 'auto_placed', price: '99', quantity: '0.5' });
    const [hit] = e.evaluate([auto], placed);
    expect(hit?.match).toMatchObject({
      dedupeKey: 'practice:order-1:auto',
      subject: 'order-1',
      title: 'BTC · Binance BTC/USDT: automatic practice buy placed',
      body: 'Your automatic practice trading placed a limit buy of 0.5 at 99, with its stop and target, on a setup that matched your rules. Practice trading: simulated, no real money.',
      instrumentId: BTC.id,
    });
    // Its fills are ordinary practice fills; other owners' orders are not theirs.
    expect(e.evaluate([auto], practice())).toEqual([]);
    expect(e.evaluate([rule({ kind: 'practice_order_filled' })], placed)).toEqual([]);
    expect(e.evaluate([auto], practice({ event: 'auto_placed', userId: 'someone-else' }))).toEqual([]);
  });

  it('tell the owner once when the daily loss limit pauses it', () => {
    const e = new AlertEvaluator();
    const paused = rule({ kind: 'practice_auto_paused' }, { scope: { instrumentIds: [ETH.id] } });
    const until = Date.UTC(2026, 10, 17);
    const source: AlertSource = {
      kind: 'practice_pause',
      userId: 'owner-1',
      at: T,
      until,
      result: '-310.5',
      asset: 'USDT',
      processedAt: T + LATE_AFTER_MS + 1,
    };
    const [hit] = e.evaluate([paused], source);
    expect(hit?.match).toMatchObject({
      dedupeKey: `practice-pause:owner-1:${until}`,
      subject: 'owner-1',
      title: 'Automatic practice trading paused',
      body: "Today's closed automatic trades come to -310.5 USDT, which reaches your daily loss limit. It places nothing more until 00:00 UTC. Practice trading: simulated, no real money.",
      instrumentId: null,
      late: true,
    });
    expect(e.evaluate([paused], { ...source, userId: 'someone-else' })).toEqual([]);
    expect(e.evaluate([rule({ kind: 'practice_auto_order' })], source)).toEqual([]);
  });
});
