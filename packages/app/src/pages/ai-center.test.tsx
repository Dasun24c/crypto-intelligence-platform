import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_DISCLAIMER,
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiBudgetStatus,
  type AiContext,
  type AiResponse,
  type AiUsage,
  channels,
  type SetupSummary,
} from '@cip/contracts';
import { type ApiRequest, json, mockApi, problem, renderApp, signedIn } from '../test/harness.js';
import { BTC_BINANCE, health, INSTRUMENTS, PAXG_BINANCE } from '../test/fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ANALYSED = INSTRUMENTS.map((i) =>
  i.id === BTC_BINANCE.id || i.id === PAXG_BINANCE.id
    ? { ...i, profile: { name: 'crypto-majors', version: 4 } }
    : i,
);
const T = Date.UTC(2026, 10, 20, 10, 0);
const id = (n: number) => `019a6f00-0000-7000-8000-0000000a${String(n).padStart(4, '0')}`;

const CONTEXT: AiContext = {
  contextVersion: '1',
  asOf: T,
  instrument: { id: 'instr', displayName: BTC_BINANCE.displayName, assetClass: 'crypto', venue: 'binance' },
  market: { id: 'mkt', last: '65432.10', change24hPct: -1.84, volume24hUsd: 1_834_500_000, spreadBps: 0.03 },
  indicators: [{ id: 'ind:1h:rsi', tf: '1h', name: 'rsi', value: 38.6 }],
  structure: [],
  levels: [
    { id: 'lvl:3f2a9c1e', tf: '1h', type: 'pdl', price: '64150.00', distanceAtr: 3.2, status: 'swept' },
  ],
  zones: [],
  setups: [],
  recentEvents: [],
  calendar: [],
  dataQuality: [],
};

const ANSWER: AiResponse = {
  stance: 'bullish',
  confidence: 'medium',
  headline: 'A bullish shift after the previous day low was swept',
  summary: 'Price swept the previous day low at 64150.00 and then shifted structure up.',
  observations: [{ text: 'The previous day low at 64150.00 was swept.', refs: ['lvl:3f2a9c1e'] }],
  supportingIndicators: [{ ref: 'ind:1h:rsi', reading: 'RSI on 1h is 38.6.' }],
  risks: [{ text: 'The market can reverse.', refs: ['mkt'] }],
  invalidation: { text: 'A close back below the swept low.', refs: ['lvl:3f2a9c1e'] },
  competingScenario: { text: 'The sweep may be a genuine breakdown.', refs: ['lvl:3f2a9c1e'] },
  dataQualityNotes: [],
};

function summary(n: number, over: Partial<AiAnalysisSummary> = {}): AiAnalysisSummary {
  return {
    id: id(n),
    instrumentId: BTC_BINANCE.id,
    trigger: 'event',
    reason: null,
    status: 'accepted',
    stance: 'bullish',
    confidence: 'medium',
    headline: ANSWER.headline,
    error: null,
    cacheSourceId: null,
    modelReported: 'grok-4.3-1120',
    costUsd: '0.0095',
    createdAt: T - n * 60_000,
    ...over,
  };
}

function detail(s: AiAnalysisSummary, over: Partial<AiAnalysisDetail> = {}): AiAnalysisDetail {
  return {
    ...s,
    triggerRefs: [{ kind: 'sweep', id: 'w1', score: 50, at: T }],
    setupId: null,
    requestedBy: null,
    context: CONTEXT,
    contextHash: 'a'.repeat(64),
    promptVersion: 'ai-1',
    modelRequested: 'grok-4.3',
    response: ANSWER,
    validation: { errors: [], warnings: [] },
    repairAttempted: false,
    usage: {
      inputTokens: 6_000,
      cachedInputTokens: 0,
      outputTokens: 800,
      reasoningTokens: 120,
      costUsd: s.costUsd,
      latencyMs: 4_200,
    },
    ...over,
  };
}

const ACCEPTED = summary(1);
const REJECTED = summary(2, { status: 'rejected', stance: null, confidence: null, headline: null });
const FAILED = summary(3, {
  status: 'failed',
  stance: null,
  confidence: null,
  headline: null,
  error: 'no_key',
  costUsd: '0',
});

function budget(state: AiBudgetStatus['state'] = 'ok', enabled = true): AiBudgetStatus {
  const spent = state === 'exhausted' ? '4.99' : state === 'throttled' ? '4.10' : '0.42';
  return {
    state,
    daily: { spentUsd: spent, capUsd: '5', usedPct: Math.round((Number(spent) / 5) * 1000) / 10 },
    monthly: { spentUsd: '12.3', capUsd: '100', usedPct: 12.3 },
    enabled,
  };
}

function usage(state: AiBudgetStatus['state'] = 'ok', enabled = true): AiUsage {
  return {
    days: [
      {
        day: '2026-11-20',
        calls: 3,
        accepted: 1,
        rejected: 1,
        failed: 1,
        cacheHits: 0,
        skipped: 0,
        inputTokens: 12_000,
        outputTokens: 1_600,
        costUsd: '0.019',
      },
    ],
    budget: budget(state, enabled),
  };
}

const PROVIDER = {
  status: 'ok' as const,
  detail: 'grok-4.3',
  keyConfigured: true,
  model: 'grok-4.3',
  budget: budget(),
  checkedAt: T,
};

function api(
  o: { usage?: AiUsage; provider?: typeof PROVIDER | null; post?: unknown; setups?: SetupSummary[] } = {},
) {
  return mockApi({
    'GET /api/v1/instruments': ANALYSED,
    'GET /api/v1/system/health': health([], o.provider === null ? {} : { ai: o.provider ?? PROVIDER }),
    'GET /api/v1/ai/usage': o.usage ?? usage(),
    'GET /api/v1/ai/analyses': (r: ApiRequest) => {
      const status = r.url.searchParams.get('status')?.split(',');
      return {
        items: [ACCEPTED, REJECTED, FAILED].filter((a) => !status || status.includes(a.status)),
        nextCursor: null,
      };
    },
    [`GET /api/v1/ai/analyses/${ACCEPTED.id}`]: detail(ACCEPTED),
    [`GET /api/v1/ai/analyses/${REJECTED.id}`]: detail(REJECTED, {
      response: { ...ANSWER, observations: [{ text: 'A rally is guaranteed.', refs: ['lvl:deadbeef'] }] },
      validation: {
        errors: [
          { rule: 'V2', path: 'observations.0.refs.0', message: '"lvl:deadbeef" is not in the context' },
          { rule: 'V4', path: 'observations.0.text', message: '"guaranteed" is not allowed' },
        ],
        warnings: [],
        firstAttemptErrors: [{ rule: 'V3', path: 'summary', message: '12345.67 is not in the context' }],
      },
      repairAttempted: true,
    }),
    'GET /api/v1/setups': { items: o.setups ?? [], nextCursor: null },
    'POST /api/v1/ai/analyses': o.post ?? json(202, { analysisId: id(99) }),
  });
}

const row = (n: number) => document.querySelector<HTMLElement>(`tr[data-analysis-id="${id(n)}"]`)!;

describe('AI Intelligence Center', () => {
  it('shows the history, the budget and Grok, with the disclaimer; a viewer reads but does not ask', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp('/ai', session, user);
    expect(await screen.findByRole('heading', { name: 'AI Intelligence Center', level: 1 })).toBeTruthy();
    expect(document.querySelector('[data-disclaimer="ai"]')!.textContent).toBe(AI_DISCLAIMER);
    await waitFor(() => expect(row(1)).toBeTruthy());
    expect(within(row(1)).getByText(ANSWER.headline)).toBeTruthy();
    expect(within(row(1)).getByText('Accepted')).toBeTruthy();
    // A rejected answer has no headline: it is never shown as an analysis.
    expect(within(row(2)).getByText('Rejected by the checks')).toBeTruthy();
    expect(within(row(2)).queryByText(ANSWER.headline)).toBeNull();
    expect(within(row(3)).getByText('No Grok API key was configured.')).toBeTruthy();
    const budgetCard = document.querySelector<HTMLElement>('[data-ai="budget"]')!;
    expect(within(budgetCard).getByText('Within budget')).toBeTruthy();
    expect(within(budgetCard).getByText('$0.4200 of $5.00')).toBeTruthy();
    expect(
      within(budgetCard).getByRole('meter', { name: 'Today (UTC): spent' }).getAttribute('aria-valuenow'),
    ).toBe('8.4');
    await waitFor(() => expect(within(budgetCard).getByText('grok-4.3')).toBeTruthy());
    expect(screen.queryByRole('form', { name: 'Request an analysis' })).toBeNull();
    expect(document.querySelector('[data-usage-day="2026-11-20"]')!.textContent).toContain('$0.0190');
  });

  it('opens an accepted analysis with what each statement cites, and how it was made', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp('/ai', session, user);
    await waitFor(() => expect(row(1)).toBeTruthy());
    await userEvent.setup().click(within(row(1)).getByRole('button', { name: /Open the analysis/ }));
    const answer = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-answer="${id(1)}"]`);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(answer).getByRole('heading', { name: ANSWER.headline })).toBeTruthy();
    expect(within(answer).getByText(/it is not a forecast/)).toBeTruthy();
    // Each cited id with the context item it points at.
    const cited = answer.querySelectorAll('[data-ref="lvl:3f2a9c1e"]');
    expect(cited.length).toBeGreaterThan(0);
    expect(cited[0]!.textContent).toBe('lvl:3f2a9c1e Previous day low at 64150.00 (1h, swept)');
    expect(answer.querySelector('[data-ref="ind:1h:rsi"]')!.textContent).toContain('RSI (1h): 38.6');
    expect(within(answer).getByText(AI_DISCLAIMER)).toBeTruthy();
    const provenance = document.querySelector<HTMLElement>(`[data-provenance="${id(1)}"]`)!;
    expect(within(provenance).getByText('6,000 in (0 cached), 800 out, 120 reasoning')).toBeTruthy();
    expect(within(provenance).getByText('4.2 s')).toBeTruthy();
    expect(provenance.textContent).toContain('"last": "65432.10"');
  });

  it('shows a rejected answer only as what the checks found, kept for review', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp(`/ai?analysis=${id(2)}`, session, user);
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-detail="${id(2)}"]`);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(panel).getByText('Rejected by the checks', { selector: 'p' })).toBeTruthy();
    expect(panel.querySelector('[data-answer]')).toBeNull();
    const found = panel.querySelector<HTMLElement>('[data-issues="What the checks found"]')!;
    expect(found.textContent).toContain('"guaranteed" is not allowed');
    expect(panel.querySelector('[data-issues^="In the first answer"]')!.textContent).toContain('12345.67');
    // The answer itself only inside the disclosure, as plain text.
    expect(within(panel).getByText('The rejected answer, as received')).toBeTruthy();
  });

  it('says "AI budget reached" and holds requests while the budget is exhausted (criterion 9.3)', async () => {
    api({ usage: usage('exhausted') });
    const { session, user } = await signedIn('analyst');
    renderApp('/ai', session, user);
    expect(await screen.findByRole('alert', { name: undefined })).toBeTruthy();
    expect(screen.getAllByText('AI budget reached').length).toBeGreaterThan(0);
    const form = await screen.findByRole('form', { name: 'Request an analysis' });
    expect(within(form).getByText('AI budget reached.')).toBeTruthy();
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Ask Grok' }).disabled).toBe(true);
  });

  it('lets an analyst ask for a setup review and follows it on the ai channel', async () => {
    const setup = {
      id: id(50),
      instrumentId: BTC_BINANCE.id,
      pattern: 'htf_order_block',
      direction: 'bullish',
      state: 'confirmed',
    } as SetupSummary;
    const { find } = api({ setups: [setup] });
    const { session, user, server } = await signedIn('analyst');
    renderApp(`/ai?instrument=${BTC_BINANCE.id}&setup=${id(50)}&reason=setup_review`, session, user);
    const form = await screen.findByRole('form', { name: 'Request an analysis' });
    await waitFor(() => expect(within(form).getByLabelText<HTMLSelectElement>('Setup').value).toBe(id(50)));
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Ask Grok' }));
    await waitFor(() => expect(find('POST', '/api/v1/ai/analyses')).toHaveLength(1));
    expect(find('POST', '/api/v1/ai/analyses')[0]!.body).toEqual({
      instrumentId: BTC_BINANCE.id,
      reason: 'setup_review',
      setupId: id(50),
    });
    expect(await within(form).findByText(/^Queued\./)).toBeTruthy();

    server.push(channels.ai, 'ai.queued', {
      analysisId: id(99),
      instrumentId: BTC_BINANCE.id,
      trigger: 'on_demand',
      reason: 'setup_review',
      queuedAt: Date.now(),
    });
    const flight = () => document.querySelector<HTMLElement>(`[data-in-flight="${id(99)}"]`);
    await waitFor(() => expect(flight()?.textContent).toContain('Queued'));
    server.push(channels.ai, 'ai.started', {
      analysisId: id(99),
      instrumentId: BTC_BINANCE.id,
      trigger: 'on_demand',
    });
    await waitFor(() => expect(flight()?.textContent).toContain('Grok is answering'));
    const lists = find('GET', '/api/v1/ai/analyses').length;
    server.push(channels.ai, 'ai.completed', {
      analysis: summary(99, { trigger: 'on_demand', reason: 'setup_review' }),
    });
    await waitFor(() => expect(flight()).toBeNull());
    expect(await screen.findByText('Your analysis is ready')).toBeTruthy();
    await waitFor(() => expect(find('GET', '/api/v1/ai/analyses').length).toBeGreaterThan(lists));
  });

  it('says why a request was refused', async () => {
    api({
      post: problem(429, 'At most 10 AI analyses an hour.', { code: 'RATE_LIMITED' }),
      provider: null,
    });
    const { session, user } = await signedIn('admin');
    renderApp('/ai', session, user);
    const form = await screen.findByRole('form', { name: 'Request an analysis' });
    await waitFor(() =>
      expect(within(form).getByLabelText<HTMLSelectElement>('Instrument').value).toBe(BTC_BINANCE.id),
    );
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Ask Grok' }));
    expect(await within(form).findByText('At most 10 AI analyses an hour.')).toBeTruthy();
    expect(screen.getByText('No report from the jobs service yet.')).toBeTruthy();
  });

  it('holds requests without a key, and while switched off', async () => {
    api({
      provider: {
        ...PROVIDER,
        status: 'down',
        detail: 'no Grok API key is configured',
        keyConfigured: false,
        model: null,
      } as never,
    });
    const { session, user } = await signedIn('analyst');
    renderApp('/ai', session, user);
    const form = await screen.findByRole('form', { name: 'Request an analysis' });
    expect(await within(form).findByText('No Grok API key is configured.')).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    api({ usage: usage('ok', false) });
    const second = await signedIn('analyst');
    renderApp('/ai', second.session, second.user);
    expect(await screen.findByText('AI analyses are switched off', { selector: 'p' })).toBeTruthy();
  });
});
