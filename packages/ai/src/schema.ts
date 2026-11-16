import { z } from 'zod';
import { AiResponseSchema } from '@cip/contracts';

/** The name Grok's structured output gives the answer's schema. */
export const RESPONSE_SCHEMA_NAME = 'cip_ai_analysis';

/** The answer's JSON Schema, from the zod contract (ADR 011): what Grok's structured output follows. */
export function responseJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AiResponseSchema, { unrepresentable: 'throw' }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

/** Grok's guaranteed subset (feasibility §5.1, xAI's structured-outputs guide). */
const LIMITS = { maxLength: 2048, maxItems: 256, properties: 64 };
const FORBIDDEN = ['not', 'if', 'then', 'else', 'maxContains', 'minContains', 'patternProperties'];
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

/**
 * Where a JSON Schema leaves Grok's guaranteed subset: forbidden keywords, strings that may exceed
 * 2,048 characters, arrays that may exceed 256 items, objects with more than 64 properties, empty
 * enums, and `items` given as an array. An empty list: it stays inside.
 */
export function outsideGrokSubset(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const k of FORBIDDEN) if (k in s) out.push(`${path}: "${k}" is best-effort only`);
  if (s['allOf'] && (s['allOf'] as unknown[]).length > 1) out.push(`${path}: allOf with several subschemas`);
  const type = s['type'];
  if (typeof type === 'string' && !TYPES.has(type)) out.push(`${path}: type "${type}"`);
  if (type === 'string' && s['enum'] === undefined && s['const'] === undefined) {
    const max = s['maxLength'];
    if (typeof max !== 'number') out.push(`${path}: a string without maxLength`);
    else if (max > LIMITS.maxLength) out.push(`${path}: maxLength ${max} > ${LIMITS.maxLength}`);
  }
  if (type === 'array') {
    const max = s['maxItems'];
    if (typeof max !== 'number') out.push(`${path}: an array without maxItems`);
    else if (max > LIMITS.maxItems) out.push(`${path}: maxItems ${max} > ${LIMITS.maxItems}`);
    if (Array.isArray(s['items'])) out.push(`${path}: items as an array`);
  }
  if (Array.isArray(s['enum']) && s['enum'].length === 0) out.push(`${path}: an empty enum`);
  if (Array.isArray(s['anyOf']) && s['anyOf'].length === 0) out.push(`${path}: an empty anyOf`);
  const props = s['properties'];
  if (props && typeof props === 'object') {
    const keys = Object.keys(props);
    if (keys.length > LIMITS.properties)
      out.push(`${path}: ${keys.length} properties > ${LIMITS.properties}`);
    const required = new Set((s['required'] as string[] | undefined) ?? []);
    for (const k of keys) {
      if (!required.has(k)) out.push(`${path}.${k}: not required`);
      out.push(...outsideGrokSubset((props as Record<string, unknown>)[k], `${path}.${k}`));
    }
    if (s['additionalProperties'] !== false) out.push(`${path}: additionalProperties is not false`);
  }
  if (s['items'] && !Array.isArray(s['items'])) out.push(...outsideGrokSubset(s['items'], `${path}[]`));
  for (const k of ['anyOf', 'oneOf'] as const)
    if (Array.isArray(s[k]))
      (s[k] as unknown[]).forEach((x, i) => out.push(...outsideGrokSubset(x, `${path}.${k}[${i}]`)));
  return out;
}
