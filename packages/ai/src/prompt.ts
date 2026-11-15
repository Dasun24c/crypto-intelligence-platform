import type { AiContext, AiReason, AiTrigger, AiValidationIssue } from '@cip/contracts';

/** Stored with every analysis: change it whenever the prompt's wording or rules change. */
export const PROMPT_VERSION = 'ai-1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The rules the model is given; the validator checks the same ones (ADR 011). */
export function systemPrompt(): string {
  return [
    'You are the market-analysis assistant of a platform that monitors crypto markets and PAXG, a gold-backed token.',
    "You explain what the platform's own analysis found for one instrument, using only the context you are given.",
    '',
    'Rules:',
    '1. Use only the context. Every observation, every risk, the invalidation and the competing scenario cite, in "refs", the ids of the context items they rely on; each supporting indicator names one indicator id in "ref".',
    '2. Never invent a price, level, zone or number. When you mention a number, copy it exactly from the context: prices as given, percentages as given. Do not round prices.',
    '3. Say what would invalidate your observation ("invalidation") and name the competing scenario ("competingScenario"), for example that a sweep may be a genuine breakout.',
    '4. These are observations, not predictions and not advice. No certainty or guarantee language (never "guaranteed", "will definitely", "risk-free", "can\'t lose"), and no instructions to trade (never "buy now", "you should sell", "enter long", "go short").',
    '5. Call the instrument by the name in the context. PAXG is a token: never write "XAUUSD" or "XAU/USD". When the context\'s gold market is closed, say so in an observation or a risk that cites "gold".',
    '6. When the context has data-quality items, say in "dataQualityNotes" what they limit.',
    '7. Answer with JSON that matches the schema, and nothing else.',
  ].join('\n');
}

/** Why the analysis runs, in fixed words: no free text reaches the model (ADR 011). */
export function triggerText(trigger: AiTrigger, reason: AiReason | null, setupRef: string | null): string {
  if (trigger === 'event')
    return 'Significant events just happened on this instrument (see the setups and the recent events). Explain what they show.';
  if (trigger === 'digest') return 'This is the scheduled 4-hourly review of this instrument.';
  if (reason === 'setup_review' && setupRef)
    return `A user asked for a review of the setup "${setupRef}" in the context.`;
  if (reason === 'refresh') return 'A user asked to refresh the analysis of this instrument now.';
  return "A user asked for a summary of this instrument's market now.";
}

export function messages(ctx: AiContext, why: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `Why now: ${why}\n\nContext (JSON):\n${JSON.stringify(ctx)}` },
  ];
}

/** The repair attempt: the first answer, and what the checks found in it. */
export function repairMessages(
  first: ChatMessage[],
  answer: string,
  errors: readonly AiValidationIssue[],
): ChatMessage[] {
  const found = errors
    .slice(0, 20)
    .map((e) => `- [${e.rule}] ${e.path || 'answer'}: ${e.message}`)
    .join('\n');
  return [
    ...first,
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content: `Your answer failed the platform's checks:\n${found}\n\nAnswer again: fix every problem, keep to the rules, and return the same JSON format.`,
    },
  ];
}
