import { type AlertMatch, AlertEvaluator, decide, type EvaluableRule, MemoryCooldown } from './evaluate.js';
import { type AlertSource, SOURCE_OF } from './sources.js';

export interface DryRunResult {
  /** Source events of the rule's kind that were evaluated. */
  evaluated: number;
  /** Matches dropped by the rule's cooldown. */
  suppressed: number;
  wouldHaveFired: AlertMatch[];
}

/**
 * What a rule would have fired over stored history (`POST /alerts/rules/{id}/test`, criterion 8.6):
 * the live evaluator and the live decision, with the cooldown kept in memory and measured in source
 * time. Sources are taken in time order.
 */
export async function dryRun(rule: EvaluableRule, sources: readonly AlertSource[]): Promise<DryRunResult> {
  const evaluator = new AlertEvaluator();
  const gate = new MemoryCooldown();
  const kind = SOURCE_OF[rule.condition.kind];
  const result: DryRunResult = { evaluated: 0, suppressed: 0, wouldHaveFired: [] };
  for (const source of [...sources].sort((a, b) => a.at - b.at)) {
    if (source.kind === kind) result.evaluated++;
    for (const { match } of evaluator.evaluate([rule], source)) {
      const decision = await decide(rule, match, evaluator.memory, gate);
      if (decision === 'fire') result.wouldHaveFired.push(match);
      else if (decision === 'cooldown') result.suppressed++;
    }
  }
  return result;
}
