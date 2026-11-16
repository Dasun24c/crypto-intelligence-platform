import { describe, expect, it } from 'vitest';
import {
  AI_DISCLAIMER,
  AI_EVENTS_STREAM,
  AI_MESSAGE_TYPES,
  AI_QUEUE,
  AI_STATUS_KEY,
  AiAnalysesQuerySchema,
  AiAnalysisDetailSchema,
  type AiContext,
  AiContextSchema,
  AiRequestSchema,
  type AiResponse,
  AiResponseSchema,
  AiSettingsSchema,
  AiSnapshotSchema,
  AiStatusReportSchema,
  AiUsageQuerySchema,
  DEFAULT_AI_SETTINGS,
} from './ai.js';
import { channels, isDurableChannel } from './market.js';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const SETUP = '019a6f00-0000-7000-8000-0000000a2040';

const context: AiContext = {
  contextVersion: '1',
  asOf: Date.UTC(2026, 10, 20, 10),
  instrument: { id: 'instr', displayName: 'BTC · Binance BTC/USDT', assetClass: 'crypto', venue: 'binance' },
  market: { id: 'mkt', last: '65432.10', change24hPct: -1.84, volume24hUsd: 1_834_500_000, spreadBps: 0.03 },
  indicators: [{ id: 'ind:1h:rsi', tf: '1h', name: 'rsi', value: 38.6 }],
  structure: [{ id: 'str:4h', tf: '4h', trend: 'undefined', lastEvent: null }],
  levels: [],
  zones: [],
  setups: [],
  recentEvents: [],
  calendar: [],
  dataQuality: [],
};

const answer: AiResponse = {
  stance: 'neutral',
  confidence: 'low',
  headline: 'A calm market',
  summary: 'Nothing settles the direction yet.',
  observations: [{ text: 'The market is live.', refs: ['mkt'] }],
  supportingIndicators: [{ ref: 'ind:1h:rsi', reading: 'RSI on 1h is 38.6.' }],
  risks: [{ text: 'Conditions can change.', refs: ['mkt'] }],
  invalidation: { text: 'A structure shift.', refs: ['str:4h'] },
  competingScenario: { text: 'A breakout either way.', refs: ['mkt'] },
  dataQualityNotes: [],
};

describe('AI contracts (Phase 9, ADR 023)', () => {
  it('label every AI text, and name the queue, the stream, the status key and the channel', () => {
    expect(AI_DISCLAIMER).toBe(
      "AI-generated observations from the platform's data. Not financial advice and not a prediction.",
    );
    expect([AI_QUEUE, AI_EVENTS_STREAM, AI_STATUS_KEY]).toEqual(['ai', 'ai:events', 'ai:status']);
    expect(channels.ai).toBe('ai');
    expect(isDurableChannel('ai')).toBe(true);
    expect(AI_MESSAGE_TYPES).toEqual([
      'ai.queued',
      'ai.started',
      'ai.completed',
      'ai.rejected',
      'ai.failed',
      'ai.budget',
    ]);
  });

  it('take a request from a fixed list: a setup review names its setup, and only it does', () => {
    expect(AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'market_summary' }).success).toBe(true);
    expect(
      AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'setup_review', setupId: SETUP }).success,
    ).toBe(true);
    const missing = AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'setup_review' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['setupId']);
    expect(AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'refresh', setupId: SETUP }).success).toBe(
      false,
    );
    // No free text reaches the model.
    expect(AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'say buy now' }).success).toBe(false);
    expect(AiRequestSchema.safeParse({ instrumentId: BTC, reason: 'refresh', note: 'hello' }).success).toBe(
      false,
    );
  });

  it('accept the default settings, and need prices for the model and its fallback', () => {
    expect(AiSettingsSchema.parse(DEFAULT_AI_SETTINGS)).toEqual(DEFAULT_AI_SETTINGS);
    expect(DEFAULT_AI_SETTINGS).toMatchObject({ dailyCapUsd: 5, monthlyCapUsd: 100, model: 'grok-4.3' });
    const noPrice = AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, model: 'grok-9' });
    expect(noPrice.error?.issues.map((i) => i.message)).toEqual(['the model needs its prices']);
    const noFallbackPrice = AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, fallbackModel: 'grok-1' });
    expect(noFallbackPrice.error?.issues.map((i) => i.message)).toEqual([
      'the fallback model needs its prices',
    ]);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, fallbackModel: null }).success).toBe(true);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, dailyCapUsd: -1 }).success).toBe(false);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, reasoningEffort: 'none' }).success).toBe(
      false,
    );
  });

  it('read list filters from a query string', () => {
    expect(AiAnalysesQuerySchema.parse({ status: 'accepted,rejected', from: '5', limit: '2' })).toMatchObject(
      {
        status: ['accepted', 'rejected'],
        from: 5,
        limit: 2,
      },
    );
    expect(AiAnalysesQuerySchema.parse({ status: ['failed'] }).status).toEqual(['failed']);
    expect(AiAnalysesQuerySchema.safeParse({ status: 'maybe' }).success).toBe(false);
    expect(AiUsageQuerySchema.parse({ from: '1', to: '2' })).toEqual({ from: 1, to: 2 });
  });

  it('keep the answer strict: every field, nothing else', () => {
    expect(AiResponseSchema.parse(answer)).toEqual(answer);
    expect(AiResponseSchema.safeParse({ ...answer, priceTarget: '70000' }).success).toBe(false);
    expect(AiResponseSchema.safeParse({ ...answer, risks: [] }).success).toBe(false);
    expect(AiContextSchema.parse(context)).toEqual(context);
  });

  it('describe an analysis in full, a status report and the channel snapshot', () => {
    const budget = {
      state: 'ok' as const,
      daily: { spentUsd: '0.42', capUsd: '5', usedPct: 8.4 },
      monthly: { spentUsd: '12.3', capUsd: '100', usedPct: 12.3 },
      enabled: true,
    };
    const summary = {
      id: SETUP,
      instrumentId: BTC,
      trigger: 'on_demand' as const,
      reason: 'market_summary' as const,
      status: 'accepted' as const,
      stance: 'neutral' as const,
      confidence: 'low' as const,
      headline: answer.headline,
      error: null,
      cacheSourceId: null,
      modelReported: 'grok-4.3',
      costUsd: '0.0095',
      createdAt: 1,
    };
    expect(
      AiAnalysisDetailSchema.safeParse({
        ...summary,
        triggerRefs: [{ kind: 'request', id: 'market_summary', score: 100, at: 1 }],
        setupId: null,
        requestedBy: null,
        context: null,
        contextHash: '',
        promptVersion: 'ai-1',
        modelRequested: 'grok-4.3',
        response: answer,
        validation: { errors: [], warnings: [] },
        repairAttempted: false,
        usage: {
          inputTokens: 6_000,
          cachedInputTokens: 0,
          outputTokens: 800,
          reasoningTokens: 0,
          costUsd: '0.0095',
          latencyMs: 1_200,
        },
      }).success,
    ).toBe(true);
    expect(
      AiStatusReportSchema.safeParse({
        status: 'down',
        detail: 'no Grok API key is configured',
        keyConfigured: false,
        model: null,
        budget,
        checkedAt: 1,
      }).success,
    ).toBe(true);
    expect(AiSnapshotSchema.safeParse({ budget, latest: [summary] }).success).toBe(true);
  });
});
