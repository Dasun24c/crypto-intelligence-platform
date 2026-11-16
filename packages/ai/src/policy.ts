/**
 * Rule V4 (ADR 011): no guarantee or certainty language, and no instructions to buy or sell. AI
 * output is educational analysis, never a prediction to rely on (REQUIREMENTS §4, risk R12).
 */
export const CERTAINTY: readonly RegExp[] = [
  /\bguarantee(?:d|s)?\b/i,
  /\bwill\s+(?:definitely|certainly|surely|undoubtedly|absolutely)\b/i,
  /\b(?:definitely|certainly|surely)\s+will\b/i,
  /\b(?:is|are)\s+(?:certain|sure|bound)\s+to\b/i,
  /\bbound\s+to\s+(?:rise|fall|rally|drop|go|break|reach|hit)\b/i,
  /\brisk[\s-]?free\b/i,
  /\bno\s+risk\b/i,
  /\bcan(?:'|’)?t\s+lose\b|\bcannot\s+lose\b|\bcan\s+not\s+lose\b/i,
  /\b(?:sure|safe)\s+(?:thing|bet|win)\b/i,
  /\bwithout\s+(?:a|any)\s+doubt\b|\bno\s+doubt\b/i,
  /\b100\s?%\s+(?:sure|certain|chance|guaranteed|probability)\b/i,
  /\bnothing\s+can\s+stop\b/i,
];

export const INSTRUCTIONS: readonly RegExp[] = [
  /\b(?:buy|sell|short)\s+(?:it\s+)?now\b/i,
  /\byou\s+(?:should|must|need\s+to|ought\s+to)\s+(?:buy|sell|short|enter|exit|go\s+(?:long|short)|take\s+profits?|close|add|hold)\b/i,
  /\b(?:i|we)\s+(?:recommend|advise|suggest)\s+(?:buying|selling|shorting|entering|going\s+(?:long|short)|that\s+you)\b/i,
  /\benter\s+(?:a\s+|the\s+)?(?:long|short)\b/i,
  /\bgo\s+(?:long|short)\b/i,
  /\bopen\s+(?:a\s+)?(?:long|short)(?:\s+position)?\b/i,
  /\btake\s+(?:a\s+)?(?:long|short)\s+position\b/i,
  /\bplace\s+(?:a\s+|an\s+)?(?:buy|sell|limit|market|stop)\s+order\b/i,
  /\b(?:load|stock)\s+up\b/i,
  /\ball[\s-]in\b/i,
  /\b(?:strong\s+)?(?:buy|sell)\s+signal\b/i,
];

/** The phrases a text breaks the policy with. */
export function policyBreaks(text: string): string[] {
  const out: string[] = [];
  for (const re of [...CERTAINTY, ...INSTRUCTIONS]) {
    const m = re.exec(text);
    if (m) out.push(m[0]);
  }
  return out;
}

/** Rule V5 (GLD-05): PAXG is never presented as spot gold's ticker. */
export const XAU = /\bXAU\s?[/-]?\s?USD\b|\bXAUUSD\b/i;
