import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type AiSettings, DEFAULT_AI_SETTINGS } from '@cip/contracts';
import { dec } from '@cip/domain';
import { admit, budgetPeriods, budgetStatus, costUsd, TYPICAL_INPUT_TOKENS, worstCaseUsd } from './budget.js';

const S = DEFAULT_AI_SETTINGS;
const price = S.prices['grok-4.3']!;

describe('cost (feasibility §5.2)', () => {
  it('bills uncached and cached input, and output with reasoning, per 1M tokens', () => {
    // 6,000 input (3,000 cached), 800 output, 1,200 reasoning on grok-4.3.
    const cost = costUsd(
      { inputTokens: 6_000, cachedInputTokens: 3_000, outputTokens: 800, reasoningTokens: 1_200 },
      price,
    );
    expect(cost.toString()).toBe('0.00935'); // 3000×1.25 + 3000×0.2 + 2000×2.5, over 1M
    // More cached than input reported: never a negative uncached part.
    expect(
      costUsd(
        { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0, reasoningTokens: 0 },
        price,
      ).toString(),
    ).toBe('0.00002');
  });

  it("reserves a call's worst case: its input, the answer's limit and the reasoning allowance", () => {
    // 8,000 × 1.25 + (2,000 + 4,000) × 2.5, over 1M.
    expect(worstCaseUsd(8_000, S, 'grok-4.3').toString()).toBe('0.025');
    expect(worstCaseUsd(8_000, S, 'unknown-model').toString()).toBe('0.025');
  });
});

describe('the caps (NFR-08, criterion 9.3)', () => {
  const settings: AiSettings = { ...S, dailyCapUsd: 0.1, monthlyCapUsd: 1 };
  const wc = worstCaseUsd(8_000, settings, settings.model);

  it('admits a call only when its worst case fits both caps; at 80 % only scores of 100 or more', () => {
    expect(admit({ spend: { day: '0', month: '0' }, worstCase: wc, score: 30, settings })).toBeNull();
    expect(
      admit({ spend: { day: '0.075', month: '0.075' }, worstCase: wc, score: 100, settings }),
    ).toBeNull();
    expect(admit({ spend: { day: '0.0751', month: '0.0751' }, worstCase: wc, score: 100, settings })).toBe(
      'daily_cap',
    );
    expect(admit({ spend: { day: '0', month: '0.98' }, worstCase: wc, score: 100, settings })).toBe(
      'monthly_cap',
    );
    expect(
      admit({ spend: { day: '0.08', month: '0.08' }, worstCase: dec('0.01'), score: 30, settings }),
    ).toBe('throttled');
    expect(
      admit({ spend: { day: '0.08', month: '0.08' }, worstCase: dec('0.01'), score: 100, settings }),
    ).toBeNull();
    expect(
      admit({
        spend: { day: '0', month: '0' },
        worstCase: wc,
        score: 100,
        settings: { ...settings, enabled: false },
      }),
    ).toBe('disabled');
  });

  it('never spends past a cap, and stops exactly when the next call no longer fits (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ input: fc.integer({ min: 500, max: 8_000 }), out: fc.integer({ min: 0, max: 6_000 }) }),
          {
            minLength: 1,
            maxLength: 200,
          },
        ),
        (calls) => {
          let spent = dec(0);
          let stopped = false;
          for (const c of calls) {
            const bound = worstCaseUsd(c.input, settings, settings.model);
            const refusal = admit({
              spend: { day: spent, month: spent },
              worstCase: bound,
              score: 100,
              settings,
            });
            if (refusal) {
              // It stops only when this call's worst case does not fit.
              expect(spent.plus(bound).gt(settings.dailyCapUsd)).toBe(true);
              stopped = true;
              continue;
            }
            // A real call costs at most its worst case.
            const cost = costUsd(
              {
                inputTokens: c.input,
                cachedInputTokens: 0,
                outputTokens: Math.min(c.out, 2_000),
                reasoningTokens: Math.max(0, c.out - 2_000),
              },
              price,
            );
            expect(cost.lte(bound)).toBe(true);
            spent = spent.plus(cost);
            expect(spent.lte(settings.dailyCapUsd)).toBe(true);
          }
          return stopped || spent.lte(settings.dailyCapUsd);
        },
      ),
    );
  });

  it('reports the state: ok, throttled at 80 %, exhausted when a typical call no longer fits', () => {
    expect(budgetStatus({ day: '0', month: '0' }, S)).toEqual({
      state: 'ok',
      daily: { spentUsd: '0', capUsd: '5', usedPct: 0 },
      monthly: { spentUsd: '0', capUsd: '100', usedPct: 0 },
      enabled: true,
    });
    expect(budgetStatus({ day: '4', month: '4' }, S).state).toBe('throttled');
    expect(budgetStatus({ day: '1', month: '81' }, S).state).toBe('throttled');
    const typical = worstCaseUsd(TYPICAL_INPUT_TOKENS, S, S.model);
    expect(budgetStatus({ day: dec(5).minus(typical).plus('0.000001'), month: '10' }, S).state).toBe(
      'exhausted',
    );
    expect(budgetStatus({ day: '0', month: '0' }, { ...S, dailyCapUsd: 0 }).daily.usedPct).toBe(100);
  });

  it('counts the spend per UTC day and month, so calls resume when the day turns', () => {
    expect(budgetPeriods(Date.UTC(2026, 10, 16, 23, 59))).toEqual({
      dayStart: Date.UTC(2026, 10, 16),
      dayEnd: Date.UTC(2026, 10, 17),
      monthStart: Date.UTC(2026, 10, 1),
      monthEnd: Date.UTC(2026, 11, 1),
    });
    expect(budgetPeriods(Date.UTC(2026, 10, 17, 0, 0)).dayStart).toBe(Date.UTC(2026, 10, 17));
    // December rolls over into the next year.
    expect(budgetPeriods(Date.UTC(2026, 11, 31, 23, 0))).toMatchObject({
      dayEnd: Date.UTC(2027, 0, 1),
      monthEnd: Date.UTC(2027, 0, 1),
    });
  });
});
