import { describe, expect, it } from 'vitest';
import {
  FEW_OBSERVATIONS,
  HISTORICAL_NOTICE,
  HISTORICAL_OBSERVATIONS,
  RunComparisonExportQuerySchema,
  SETUP_EXPORT_MAX_ROWS,
  SetupExportQuerySchema,
  SetupStatsQuerySchema,
  SetupStatsSchema,
} from './history.js';
import {
  applyReplaySettings,
  REPLAY_SETTING_PATHS,
  ReplayRequestSchema,
  ReplaySettingsSchema,
  ReplayStatusSchema,
  type ReplaySettings,
  RunComparisonSchema,
  ReplayBaseSettingsSchema,
  replaySettingsOf,
} from './smc.js';

const ID = '019a6f00-0000-7000-8000-000000000001';

/** Enough of a version-4 profile for the replay settings. */
const profile = () => ({
  indicators: { rsi: 14 },
  smc: {
    atrPeriod: 14,
    setups: {
      patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
      mss: { maxBars: 12, requireDisplacement: true },
      timing: { entryExpiryBars: 24, maxHoldBars: 288 },
      checklist: {
        minRR: 2,
        mandatory: ['sweep', 'mss', 'levels_defined'],
        newsBlackoutMin: { before: 30, after: 30 },
      },
      quality: { blockConfirmOnLowLiquidity: false, maxSpreadBps: 5 },
    },
  },
});

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o);

describe('statistics queries', () => {
  it('group by pattern and count every setup by default', () => {
    expect(SetupStatsQuerySchema.parse({})).toEqual({ groupBy: ['pattern'], found: 'all' });
  });

  it('take comma-separated dimensions, once each', () => {
    expect(SetupStatsQuerySchema.parse({ groupBy: 'session,tfPair,rules' }).groupBy).toEqual([
      'session',
      'tfPair',
      'rules',
    ]);
    expect(SetupStatsQuerySchema.safeParse({ groupBy: 'pattern,pattern' }).success).toBe(false);
    expect(SetupStatsQuerySchema.safeParse({ groupBy: 'colour' }).success).toBe(false);
    expect(SetupStatsQuerySchema.safeParse({ groupBy: '' }).success).toBe(false);
  });

  it('bound the period and filter by how a setup was found, instrument and run', () => {
    expect(
      SetupStatsQuerySchema.parse({ from: '10', to: '20', found: 'live', instrumentId: ID, runId: ID }),
    ).toEqual({ groupBy: ['pattern'], from: 10, to: 20, found: 'live', instrumentId: ID, runId: ID });
    expect(SetupStatsQuerySchema.safeParse({ from: 20, to: 20 }).success).toBe(false);
    expect(SetupStatsQuerySchema.safeParse({ found: 'sometimes' }).success).toBe(false);
    expect(SetupStatsQuerySchema.safeParse({ cursor: 'x' }).success).toBe(false);
    expect(SetupExportQuerySchema.parse({ to: 5 })).toEqual({ to: 5, found: 'all' });
    expect(SetupExportQuerySchema.safeParse({ groupBy: 'pattern' }).success).toBe(false);
    expect(SetupExportQuerySchema.safeParse({ from: 9, to: 1 }).success).toBe(false);
    expect(RunComparisonExportQuerySchema.safeParse({ runId: ID, compareWith: ID }).success).toBe(true);
    expect(RunComparisonExportQuerySchema.safeParse({}).success).toBe(false);
  });

  it('label every answer as historical observations, never as a forecast (criterion 12.2)', () => {
    expect(HISTORICAL_OBSERVATIONS).toBe('Historical observations');
    expect(HISTORICAL_NOTICE.startsWith(`${HISTORICAL_OBSERVATIONS}:`)).toBe(true);
    expect(HISTORICAL_NOTICE).toMatch(/not a forecast/);
    const row = {
      key: {},
      detected: 0,
      warmup: 0,
      confirmed: 0,
      open: 0,
      resolved: 0,
      entered: 0,
      outcomes: { target_reached: 0, invalidated: 0, expired_no_entry: 0, expired_open: 0, ambiguous: 0 },
      avgMfeR: null,
      avgMaeR: null,
    };
    const answer = {
      label: HISTORICAL_OBSERVATIONS,
      notice: HISTORICAL_NOTICE,
      groupBy: ['pattern'],
      from: null,
      to: null,
      instrumentId: null,
      found: 'all',
      runId: null,
      runs: 0,
      totals: row,
      rows: [],
    };
    expect(SetupStatsSchema.safeParse(answer).success).toBe(true);
    expect(SetupStatsSchema.safeParse({ ...answer, label: 'Win rate' }).success).toBe(false);
    expect(FEW_OBSERVATIONS).toBeGreaterThan(0);
    expect(SETUP_EXPORT_MAX_ROWS).toBe(100_000);
  });
});

describe('replay settings', () => {
  it('accept the settings a replay may change, and at least one', () => {
    const all: ReplaySettings = {
      patterns: ['htf_order_block'],
      minRR: 3,
      mandatory: ['sweep'],
      requireDisplacement: false,
      entryExpiryBars: 12,
      maxHoldBars: 100,
      newsBlackoutMin: { before: 0, after: 90 },
      blockConfirmOnLowLiquidity: true,
    };
    expect(ReplaySettingsSchema.parse(all)).toEqual(all);
    expect(ReplaySettingsSchema.parse({ mandatory: [] })).toEqual({ mandatory: [] });
    for (const bad of [
      {},
      { patterns: [] },
      { patterns: ['htf_order_block', 'htf_order_block'] },
      { mandatory: ['sweep', 'sweep'] },
      { minRR: 0 },
      { minRR: 25 },
      { entryExpiryBars: 0 },
      { maxHoldBars: 1.5 },
      { newsBlackoutMin: { before: -1, after: 0 } },
      { newsBlackoutMin: { before: 0 } },
      { weights: { sweep: 100 } },
    ])
      expect(ReplaySettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('apply to a copy of the profile, in the rulebook order', () => {
    const before = profile();
    const after = applyReplaySettings(before, {
      patterns: ['sweep_outside_fill_inside', 'double_liquidity_trap'],
      mandatory: ['news_clear', 'sweep'],
      minRR: 3,
    });
    expect(after.smc.setups.patterns).toEqual(['double_liquidity_trap', 'sweep_outside_fill_inside']);
    expect(after.smc.setups.checklist.mandatory).toEqual(['sweep', 'news_clear']);
    expect(after.smc.setups.checklist.minRR).toBe(3);
    // The profile itself is unchanged, and so is everything not named.
    expect(before).toEqual(profile());
    expect(after.smc.setups.timing).toEqual(before.smc.setups.timing);
    expect(after.indicators).toEqual(before.indicators);
  });

  it('write each setting where REPLAY_SETTING_PATHS says it lives', () => {
    const settings: Required<ReplaySettings> = {
      patterns: ['eq_near_poi'],
      minRR: 4,
      mandatory: ['mss'],
      requireDisplacement: false,
      entryExpiryBars: 7,
      maxHoldBars: 9,
      newsBlackoutMin: { before: 5, after: 6 },
      blockConfirmOnLowLiquidity: true,
    };
    const after = applyReplaySettings(profile(), settings);
    for (const [name, path] of Object.entries(REPLAY_SETTING_PATHS))
      expect(at(after, path), name).toEqual(settings[name as keyof ReplaySettings]);
  });

  it('refuse a profile without setup settings (before version 4)', () => {
    expect(() => applyReplaySettings({ indicators: {}, smc: {} }, { minRR: 3 })).toThrow(/version 4/);
    expect(() => applyReplaySettings({ indicators: {} }, { minRR: 3 })).toThrow(/version 4/);
  });

  it('read back from a profile, as the replay form starts from them', () => {
    const values = replaySettingsOf(profile());
    expect(values).toEqual({
      patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
      minRR: 2,
      mandatory: ['sweep', 'mss', 'levels_defined'],
      requireDisplacement: true,
      entryExpiryBars: 24,
      maxHoldBars: 288,
      newsBlackoutMin: { before: 30, after: 30 },
      blockConfirmOnLowLiquidity: false,
    });
    // A profile's own values change nothing.
    expect(applyReplaySettings(profile(), values)).toEqual(profile());
    expect(
      ReplayBaseSettingsSchema.safeParse({
        instrumentId: ID,
        profile: { name: 'crypto-majors', version: 4 },
        settings: values,
      }).success,
    ).toBe(true);
    expect(() => replaySettingsOf({ indicators: {} })).toThrow(/version 4/);
    expect(() => replaySettingsOf(null)).toThrow(/version 4/);
  });

  it('come with a replay request, which still bounds its period', () => {
    expect(
      ReplayRequestSchema.safeParse({ instrumentId: ID, from: 0, to: 3_600_000, settings: { minRR: 3 } })
        .success,
    ).toBe(true);
    expect(
      ReplayRequestSchema.safeParse({ instrumentId: ID, from: 0, to: 3_600_000, settings: {} }).success,
    ).toBe(false);
    expect(ReplayRequestSchema.safeParse({ instrumentId: ID, from: 0, to: 32 * 86_400_000 }).success).toBe(
      false,
    );
  });
});

describe('run comparisons', () => {
  const side = {
    runId: ID,
    mode: 'live',
    profile: { name: 'crypto-majors', version: 4 },
    rulesetVersion: 'indicators-1+smc-0.3.1',
    digest: 'a'.repeat(64),
    events: 10,
    settings: null,
  };
  const comparison = {
    base: side,
    other: { ...side, mode: 'replay', settings: { minRR: 3 } },
    from: 0,
    to: 10,
    equal: false,
    sameOrigins: true,
    incomplete: false,
    settings: [{ path: 'smc.setups.checklist.minRR', base: 2, other: 3 }],
    eventTypes: [{ type: 'setup_transition', base: 4, other: 3 }],
    onlyInBase: 1,
    onlyInOther: 0,
    changed: 1,
    setups: [
      {
        key: 'su:1',
        pattern: 'eq_near_poi',
        variant: null,
        direction: 'bearish',
        contextTf: '1h',
        setupTf: '5m',
        createdAt: 5,
        base: { state: 'confirmed', resolution: null, score: 80, mandatoryPassed: true, transitions: 2 },
        other: null,
      },
    ],
    setupsTotal: 1,
  };

  it('carry both digests, the settings and the detections that differ', () => {
    expect(RunComparisonSchema.safeParse(comparison).success).toBe(true);
    expect(RunComparisonSchema.safeParse({ ...comparison, settings: [{ path: 'x' }] }).success).toBe(false);
  });

  it('come with a replay once it has completed', () => {
    const status = {
      runId: ID,
      instrumentId: ID,
      status: 'completed',
      from: 0,
      to: 10,
      settings: { minRR: 3 },
      sourceRunId: ID,
      digest: 'b'.repeat(64),
      events: 10,
      requestedAt: 1,
      finishedAt: 2,
      comparison,
      error: null,
    };
    expect(ReplayStatusSchema.safeParse(status).success).toBe(true);
    expect(ReplayStatusSchema.safeParse({ ...status, status: 'paused' }).success).toBe(false);
  });
});
