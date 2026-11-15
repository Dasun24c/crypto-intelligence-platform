import { type AiContext, type AiResponse, AiResponseSchema, type AiValidationIssue } from '@cip/contracts';
import { contextNumbers, statedNumbers, ungrounded } from './numbers.js';
import { policyBreaks, XAU } from './policy.js';

/** The outcome of checking one answer: the answer when V1 passed, the errors (V1–V5) and warnings (V6). */
export interface Checked {
  response: AiResponse | null;
  errors: AiValidationIssue[];
  warnings: AiValidationIssue[];
}

/** Every id the context offers the model to cite. */
export function contextIds(ctx: AiContext): Set<string> {
  const ids = new Set<string>([ctx.instrument.id, ctx.market.id]);
  if (ctx.goldMarket) ids.add(ctx.goldMarket.id);
  for (const list of [
    ctx.indicators,
    ctx.structure,
    ctx.levels,
    ctx.zones,
    ctx.setups,
    ctx.recentEvents,
    ctx.calendar,
    ctx.dataQuality,
  ])
    for (const item of list) ids.add(item.id);
  return ids;
}

/** Every text in the answer, with where it is. */
export function texts(r: AiResponse): { path: string; text: string }[] {
  return [
    { path: 'headline', text: r.headline },
    { path: 'summary', text: r.summary },
    ...r.observations.map((o, i) => ({ path: `observations.${i}.text`, text: o.text })),
    ...r.supportingIndicators.map((s, i) => ({ path: `supportingIndicators.${i}.reading`, text: s.reading })),
    ...r.risks.map((x, i) => ({ path: `risks.${i}.text`, text: x.text })),
    { path: 'invalidation.text', text: r.invalidation.text },
    { path: 'competingScenario.text', text: r.competingScenario.text },
    ...r.dataQualityNotes.map((n, i) => ({ path: `dataQualityNotes.${i}`, text: n })),
  ];
}

/** Every cited id, with where it is cited. */
export function refs(r: AiResponse): { path: string; ref: string }[] {
  const cited = (path: string, list: readonly string[]) =>
    list.map((ref, j) => ({ path: `${path}.refs.${j}`, ref }));
  return [
    ...r.observations.flatMap((o, i) => cited(`observations.${i}`, o.refs)),
    ...r.supportingIndicators.map((s, i) => ({ path: `supportingIndicators.${i}.ref`, ref: s.ref })),
    ...r.risks.flatMap((x, i) => cited(`risks.${i}`, x.refs)),
    ...cited('invalidation', r.invalidation.refs),
    ...cited('competingScenario', r.competingScenario.refs),
  ];
}

/**
 * Checks a model's answer against the context it was given (ADR 011), in order: V1 the schema; V2
 * every cited id exists; V3 every number is grounded; V4 the policy; V5 the gold rules. V6 (the
 * stance against every confirmed setup) is a warning only. The answer is accepted when there are no
 * errors.
 */
export function validateResponse(ctx: AiContext, answer: unknown): Checked {
  const errors: AiValidationIssue[] = [];
  const warnings: AiValidationIssue[] = [];
  let parsed: unknown = answer;
  if (typeof answer === 'string') {
    try {
      parsed = JSON.parse(answer);
    } catch {
      return {
        response: null,
        errors: [{ rule: 'V1', path: '', message: 'the answer is not JSON' }],
        warnings,
      };
    }
  }
  const schema = AiResponseSchema.safeParse(parsed);
  if (!schema.success) {
    for (const issue of schema.error.issues.slice(0, 20))
      errors.push({ rule: 'V1', path: issue.path.join('.'), message: issue.message });
    return { response: null, errors, warnings };
  }
  const r = schema.data;

  // V2: citations.
  const ids = contextIds(ctx);
  for (const { path, ref } of refs(r))
    if (!ids.has(ref))
      errors.push({ rule: 'V2', path, message: `cites "${ref}", which is not in the context` });

  // V3: numbers.
  const grounded = contextNumbers(ctx);
  for (const { path, text } of texts(r))
    for (const n of statedNumbers(text)) {
      const why = ungrounded(n, grounded);
      if (why) errors.push({ rule: 'V3', path, message: why });
    }

  // V4: policy.
  for (const { path, text } of texts(r))
    for (const phrase of policyBreaks(text))
      errors.push({
        rule: 'V4',
        path,
        message: `"${phrase}" is not allowed: no certainty, and no instructions to trade`,
      });

  // V5: gold.
  for (const { path, text } of texts(r))
    if (XAU.test(text)) errors.push({ rule: 'V5', path, message: 'PAXG is never called XAUUSD' });
  if (ctx.goldMarket?.status === 'closed') {
    const cites = [...r.observations, ...r.risks].some((x) => x.refs.includes(ctx.goldMarket!.id));
    if (!cites)
      errors.push({
        rule: 'V5',
        path: 'observations',
        message: 'the gold market is closed: an observation or a risk must say so, citing "gold"',
      });
  }

  // V6 (warning): the stance against every confirmed setup's direction.
  const confirmed = ctx.setups.filter((s) => s.state === 'confirmed' || s.state === 'entry_active');
  if (r.stance !== 'neutral' && confirmed.length > 0 && confirmed.every((s) => s.direction !== r.stance))
    warnings.push({
      rule: 'V6',
      path: 'stance',
      message: `the stance is ${r.stance}, against every confirmed setup's direction`,
    });

  return { response: r, errors, warnings };
}
