import { describe, expect, it, vi } from 'vitest';
import type { ReplaySettingValues, RunComparison, SetupStatsRow, StatsKey } from '@cip/contracts';
import {
  changedSettings,
  comparisonVerdict,
  countAndShare,
  fewObservations,
  formatR,
  fromUtcInput,
  keyText,
  rowId,
  saveFile,
  settingLabel,
  settingsSummary,
  settingValue,
  sideText,
  toUtcInput,
} from './history.js';

const BASE: ReplaySettingValues = {
  patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
  minRR: 2,
  mandatory: ['sweep', 'mss', 'levels_defined'],
  requireDisplacement: true,
  entryExpiryBars: 24,
  maxHoldBars: 288,
  newsBlackoutMin: { before: 30, after: 30 },
  blockConfirmOnLowLiquidity: false,
};

const KEY: StatsKey = {
  pattern: 'sweep_outside_fill_inside',
  variant: null,
  direction: 'bearish',
  tfPair: { context: '4h', setup: '15m' },
  instrumentId: 'i-1',
  session: 'new_york',
  rules: {
    rulesetVersion: 'indicators-1+smc-0.3.1',
    profile: { name: 'crypto-majors', version: 4 },
    paramsHash: 'abcdef0123456789',
    changedSettings: true,
  },
};

describe('statistics labels', () => {
  it('names each part of a group', () => {
    const name = (id: string) => (id === 'i-1' ? 'BTC/USDT · Binance' : id);
    expect(keyText(KEY, 'pattern', name)).toBe('P4 · Sweep outside, fill inside');
    expect(keyText(KEY, 'variant', name)).toBe('—');
    expect(keyText({ variant: 'A' }, 'variant', name)).toBe('Variant A');
    expect(keyText(KEY, 'direction', name)).toBe('Bearish');
    expect(keyText({ direction: 'bullish' }, 'direction', name)).toBe('Bullish');
    expect(keyText(KEY, 'tfPair', name)).toBe('4h / 15m');
    expect(keyText(KEY, 'instrument', name)).toBe('BTC/USDT · Binance');
    expect(keyText(KEY, 'session', name)).toBe('New York');
    expect(keyText(KEY, 'rules', name)).toBe(
      'indicators-1+smc-0.3.1 · crypto-majors v4 · changed settings (abcdef01)',
    );
    expect(keyText({ ...KEY, rules: { ...KEY.rules!, changedSettings: false } }, 'rules', name)).toBe(
      'indicators-1+smc-0.3.1 · crypto-majors v4',
    );
    for (const d of ['pattern', 'direction', 'tfPair', 'instrument', 'session', 'rules'] as const)
      expect(keyText({}, d, name)).toBe('—');
  });

  it('identifies a group by its key', () => {
    expect(rowId(KEY, ['pattern', 'session', 'tfPair', 'variant'])).toBe(
      'sweep_outside_fill_inside·new_york·4h/15m·',
    );
    expect(rowId(KEY, ['instrument', 'rules'])).toBe(
      'i-1·indicators-1+smc-0.3.1|crypto-majors|4|abcdef0123456789',
    );
    expect(rowId({}, ['tfPair', 'instrument', 'rules', 'direction'])).toBe('···');
  });

  it('shows shares of the resolved setups only, and excursions to two decimals', () => {
    expect(countAndShare(3, 12)).toBe('3 (25 %)');
    expect(countAndShare(0, 0)).toBe('0');
    expect(formatR(1.5799999)).toBe('1.58');
    expect(formatR(null)).toBe('—');
    const row = { resolved: 19 } as SetupStatsRow;
    expect(fewObservations(row)).toBe(true);
    expect(fewObservations({ ...row, resolved: 20 })).toBe(false);
  });
});

describe('replay settings', () => {
  it('send only what the form changed, in the rulebook order', () => {
    expect(changedSettings(BASE, structuredClone(BASE))).toBeNull();
    // The same patterns in another order are not a change.
    expect(changedSettings(BASE, { ...BASE, patterns: [...BASE.patterns].reverse() })).toBeNull();
    expect(
      changedSettings(BASE, {
        ...BASE,
        patterns: ['sweep_outside_fill_inside', 'double_liquidity_trap'],
        minRR: 3,
        mandatory: ['news_clear', 'sweep'],
      }),
    ).toEqual({
      patterns: ['double_liquidity_trap', 'sweep_outside_fill_inside'],
      minRR: 3,
      mandatory: ['sweep', 'news_clear'],
    });
    expect(
      changedSettings(BASE, {
        ...BASE,
        requireDisplacement: false,
        entryExpiryBars: 12,
        maxHoldBars: 100,
        newsBlackoutMin: { before: 30, after: 60 },
        blockConfirmOnLowLiquidity: true,
      }),
    ).toEqual({
      requireDisplacement: false,
      entryExpiryBars: 12,
      maxHoldBars: 100,
      newsBlackoutMin: { before: 30, after: 60 },
      blockConfirmOnLowLiquidity: true,
    });
  });

  it('read as a sentence', () => {
    expect(settingsSummary(null)).toBe('Live settings');
    expect(
      settingsSummary({ minRR: 3, patterns: ['eq_near_poi'], newsBlackoutMin: { before: 0, after: 90 } }),
    ).toBe('Patterns: P2; Minimum reward-to-risk (item 7): 3; News blackout: 0 min before, 90 min after');
    expect(settingsSummary({ requireDisplacement: false, mandatory: [] })).toBe(
      'Mandatory checklist items: None; MSS needs displacement: No',
    );
  });

  it('name each setting a comparison lists, and its values', () => {
    expect(settingLabel('smc.setups.checklist.minRR')).toBe('Minimum reward-to-risk (item 7)');
    expect(settingLabel('smc.setups.checklist.newsBlackoutMin.after')).toBe(
      'News blackout after an event (minutes)',
    );
    expect(settingLabel('rulesetVersion')).toBe('Rules version');
    expect(settingLabel('smc.swings.internalOrder')).toBe('smc.swings.internalOrder');
    expect(settingValue('smc.setups.patterns', ['double_liquidity_trap', 'x'])).toBe('P1, x');
    expect(settingValue('smc.setups.checklist.mandatory', ['sweep', 'y'])).toBe('Clear liquidity sweep; y');
    expect(settingValue('smc.setups.checklist.mandatory', [])).toBe('None');
    expect(settingValue('a', [1, { b: 2 }])).toBe('1, {"b":2}');
    expect(settingValue('a', true)).toBe('Yes');
    expect(settingValue('a', null)).toBe('—');
    expect(settingValue('a', 2.5)).toBe('2.5');
    expect(settingValue('a', 'gold v4')).toBe('gold v4');
    expect(settingValue('a', { before: 1 })).toBe('{"before":1}');
  });

  it('describe a setup as each run left it', () => {
    expect(sideText(null)).toBe('Not found');
    expect(
      sideText({
        state: 'resolved',
        resolution: 'target_reached',
        score: 80,
        mandatoryPassed: true,
        transitions: 3,
      }),
    ).toBe('Resolved (Target reached), score 80');
    expect(
      sideText({ state: 'confirmed', resolution: null, score: 65, mandatoryPassed: true, transitions: 1 }),
    ).toBe('Confirmed, score 65');
  });
});

describe('comparison verdicts (criterion 12.3)', () => {
  const side = {
    runId: 'r',
    mode: 'live' as const,
    profile: { name: 'crypto-majors', version: 4 },
    rulesetVersion: 'x',
    digest: 'd',
    events: 12,
    settings: null,
  };
  const c = (over: Partial<RunComparison>): RunComparison => ({
    base: side,
    other: { ...side, mode: 'replay' },
    from: 0,
    to: 1,
    equal: true,
    sameOrigins: true,
    incomplete: false,
    settings: [],
    eventTypes: [],
    onlyInBase: 0,
    onlyInOther: 0,
    changed: 0,
    setups: [],
    setupsTotal: 0,
    ...over,
  });

  it('says when a replay matches, and when it differs because of its settings', () => {
    expect(comparisonVerdict(c({}))).toMatchObject({ tone: 'ok', title: 'Matches the live run' });
    expect(comparisonVerdict(c({ base: { ...side, mode: 'replay' } })).title).toBe(
      'Matches the other replay',
    );
    const changed = comparisonVerdict(
      c({
        equal: false,
        settings: [{ path: 'smc.setups.checklist.minRR', base: 2, other: 3 }],
        changed: 2,
        onlyInOther: 1,
      }),
    );
    expect(changed).toMatchObject({ tone: 'info', title: 'Settings differ from the live run' });
    expect(changed.detail).toBe('3 detections differ, from the settings listed below.');
    expect(
      comparisonVerdict(c({ equal: false, settings: [{ path: 'p', base: 1, other: 2 }], changed: 1 })).detail,
    ).toBe('1 detection differs, from the settings listed below.');
    expect(
      comparisonVerdict(c({ equal: false, settings: [{ path: 'p', base: 1, other: 2 }] })).detail,
    ).toMatch(/number their events differently/);
    // Changed settings that change nothing still say so: never "matches".
    expect(comparisonVerdict(c({ settings: [{ path: 'p', base: 1, other: 2 }] }))).toMatchObject({
      tone: 'info',
      title: 'Settings differ from the live run',
      detail: expect.stringMatching(/made no difference/) as string,
    });
  });

  it('flags a difference with the same settings as a fault, and waits for an incomplete live run', () => {
    expect(comparisonVerdict(c({ equal: false, changed: 1 }))).toMatchObject({ tone: 'crit' });
    expect(comparisonVerdict(c({ equal: false, onlyInBase: 2 })).detail).toMatch(/^2 detections differ/);
    expect(comparisonVerdict(c({ equal: false, sameOrigins: false }))).toMatchObject({
      tone: 'info',
      title: 'Same detections, numbered differently',
    });
    expect(comparisonVerdict(c({ incomplete: true }))).toMatchObject({
      tone: 'info',
      title: 'Not comparable yet',
    });
    expect(comparisonVerdict(c({ incomplete: true, base: { ...side, mode: 'replay' } })).detail).toMatch(
      /^The other run/,
    );
  });
});

describe('dates and files', () => {
  it('reads and writes the period inputs as UTC', () => {
    const t = Date.UTC(2026, 10, 22, 9, 30);
    expect(toUtcInput(t)).toBe('2026-11-22T09:30');
    expect(fromUtcInput('2026-11-22T09:30')).toBe(t);
    expect(fromUtcInput('2026-11-22')).toBeNull();
    expect(fromUtcInput('2026-13-40T99:99')).toBeNull();
  });

  it('saves a file through a temporary link', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    vi.useFakeTimers();
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    saveFile(new Blob(['a,b']), 'x.csv');
    expect(clicked).toEqual(['x.csv']);
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
