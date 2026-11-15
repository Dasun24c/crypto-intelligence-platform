import type { CalendarStatus, ChartOverlay, EconomicEvent, SetupDetail, SetupSummary } from '@cip/contracts';
import { SETUP_DISCLAIMER } from '@cip/contracts';

/** Phase 7 test data: setups, overlays and the economic calendar. */
export const H = 3_600_000;
export const T0 = Date.UTC(2026, 10, 10, 0, 0);
const BTC = '019a6f00-0000-7000-8000-000000000001';
const RUN = '019a7300-0000-7000-8000-000000000001';
const id = (n: number) => `019a7400-0000-7000-8000-${String(n).padStart(12, '0')}`;

export function setupSummary(n: number, extra: Partial<SetupSummary> = {}): SetupSummary {
  return {
    id: id(n),
    instrumentId: BTC,
    runId: RUN,
    pattern: 'sweep_outside_fill_inside',
    variant: null,
    direction: 'bearish',
    contextTf: '1h',
    setupTf: '5m',
    state: 'confirmed',
    resolution: null,
    displayLabel: 'Confirmed',
    levels: { entry: '98.2', invalidation: '102.48', target1: '96', target2: null, rr: 0.514 },
    score: 62.5,
    mandatoryPassed: true,
    qualityFlags: [],
    flags: [],
    createdAt: T0,
    updatedAt: T0 + n * 60_000,
    resolvedAt: null,
    disclaimer: SETUP_DISCLAIMER,
    ...extra,
  };
}

export function setupDetail(n: number, extra: Partial<SetupDetail> = {}): SetupDetail {
  return {
    ...setupSummary(n),
    transitions: [
      {
        from: null,
        to: 'forming',
        reason: 'preconditions',
        candleTime: T0,
        decidedAt: T0 + 300_000,
        processedAt: T0 + 300_500,
        late: false,
        evidence: { range: 'r1' },
      },
      {
        from: 'triggered',
        to: 'confirmed',
        reason: 'mss_confirmed',
        candleTime: T0 + H,
        decidedAt: T0 + H + 300_000,
        processedAt: T0 + H + 300_400,
        late: false,
        evidence: { entryZone: 'z1' },
      },
    ],
    checklist: [
      { item: 'htf_bias', credit: 0, weight: 15, mandatory: false, evidence: { trend: 'undefined' } },
      { item: 'liquidity_marked', credit: 1, weight: 10, mandatory: false, evidence: {} },
      { item: 'poi_present', credit: 0.5, weight: 15, mandatory: false, evidence: {} },
      { item: 'sweep', credit: 1, weight: 15, mandatory: true, evidence: {} },
      { item: 'mss', credit: 1, weight: 20, mandatory: true, evidence: {} },
      { item: 'levels_defined', credit: 1, weight: 5, mandatory: true, evidence: {} },
      { item: 'risk_reward', credit: 0, weight: 15, mandatory: false, evidence: { rr: 0.514, minRR: 2 } },
      { item: 'news_clear', credit: 0, weight: 5, mandatory: false, evidence: { events: [id(900)] } },
    ],
    checklistByState: {},
    outcome: null,
    targets: { target1: null, target2: null },
    refs: { sweeps: [], mss: null, entryZone: null, levels: [], range: null, poi: null },
    ...extra,
  };
}

export function overlay(extra: Partial<ChartOverlay> = {}): ChartOverlay {
  return {
    instrumentId: BTC,
    tf: '1h',
    run: { id: RUN, status: 'running', from: T0 - 10 * H, profile: { name: 'crypto-majors', version: 4 } },
    swings: [
      {
        id: id(1),
        tf: '1h',
        kind: 'high',
        level: 'external',
        price: '105',
        candleTime: T0 + 2 * H,
        confirmedAt: T0 + 6 * H,
        flags: [],
      },
    ],
    structure: [
      {
        id: id(2),
        tf: '1h',
        level: 'external',
        type: 'bos',
        direction: 'bullish',
        brokenSwingId: id(1),
        breakPrice: '105',
        breakCandleTime: T0 + 8 * H,
        isInitial: false,
        displacement: null,
        flags: [],
      },
    ],
    ranges: [
      {
        id: id(3),
        tf: '1h',
        high: '106',
        low: '99',
        equilibrium: '102.5',
        windowStart: T0 + H,
        detectedAt: T0 + 5 * H,
        endedAt: null,
        endReason: null,
        flags: [],
      },
    ],
    levels: [
      {
        id: id(4),
        tf: '1h',
        type: 'session_high',
        side: 'buy_side',
        price: '104.5',
        touches: 2,
        sessionName: 'london',
        location: 'internal',
        knownAt: T0 + 3 * H,
        status: 'swept',
        statusChangedAt: T0 + 7 * H,
        sweepCount: 1,
        flags: [],
      },
    ],
    sweeps: [
      {
        id: id(5),
        tf: '1h',
        levelId: id(4),
        levelType: 'session_high',
        groupId: id(6),
        kind: 'wick',
        side: 'buy_side',
        levelPrice: '104.5',
        extremePrice: '104.9',
        penetrationAtr: 0.3,
        breachAt: T0 + 7 * H,
        confirmedAt: T0 + 8 * H,
        notionalBeyondUsd: '1200',
        flags: ['thin_book'],
      },
    ],
    zones: [
      {
        id: id(7),
        tf: '1h',
        type: 'order_block',
        direction: 'bearish',
        top: '105.2',
        bottom: '104.6',
        originFrom: T0 + 2 * H,
        originTo: T0 + 2 * H,
        knownAt: T0 + 4 * H,
        htf: true,
        location: 'external',
        status: 'partially_filled',
        fillPct: 35,
        firstTouchAt: T0 + 6 * H,
        statusChangedAt: T0 + 6 * H,
        structureEventId: null,
        linkedZoneId: null,
        sweptLiquidityAtOrigin: false,
        flags: [],
      },
    ],
    setups: [setupSummary(8, { setupTf: '1h', createdAt: T0 + 4 * H })],
    closures: [],
    ...extra,
  };
}

export function economicEvent(n: number, extra: Partial<EconomicEvent> = {}): EconomicEvent {
  return {
    id: id(900 + n),
    source: 'fred',
    sourceRef: `10:${n}`,
    release: 'cpi',
    title: 'Consumer Price Index (CPI)',
    country: 'US',
    currency: 'USD',
    category: 'inflation',
    impact: 'high',
    scheduledAt: Date.UTC(2026, 11, 10, 13, 30),
    timeConfirmed: false,
    actual: null,
    forecast: null,
    previous: null,
    updatedAt: T0,
    ...extra,
  };
}

export function calendarStatus(extra: Partial<CalendarStatus> = {}): CalendarStatus {
  return {
    available: true,
    availableFrom: T0,
    status: 'ok',
    detail: 'FRED and BEA synced',
    sources: [
      {
        source: 'fred',
        configured: true,
        lastSuccessAt: T0,
        lastSync: {
          source: 'fred',
          startedAt: T0,
          finishedAt: T0,
          status: 'ok',
          inserted: 8,
          updated: 0,
          unchanged: 0,
          cancelled: 0,
          error: null,
        },
      },
      {
        source: 'bea',
        configured: true,
        lastSuccessAt: T0,
        lastSync: {
          source: 'bea',
          startedAt: T0,
          finishedAt: T0,
          status: 'ok',
          inserted: 20,
          updated: 0,
          unchanged: 0,
          cancelled: 0,
          error: null,
        },
      },
    ],
    blackouts: [
      {
        profile: 'crypto-majors',
        version: 4,
        beforeMin: 30,
        afterMin: 30,
        currencies: ['USD'],
        instrumentIds: [BTC],
      },
      { profile: 'gold', version: 4, beforeMin: 60, afterMin: 60, currencies: ['USD'], instrumentIds: [] },
    ],
    ...extra,
  };
}
