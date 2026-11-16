import { describe, expect, it } from 'vitest';
import { AiResponseSchema } from '@cip/contracts';
import { canonicalContext, contextHash, estimateTokens, shortId, trimContext } from './context.js';
import { messages, PROMPT_VERSION, repairMessages, systemPrompt, triggerText } from './prompt.js';
import { outsideGrokSubset, responseJsonSchema } from './schema.js';
import { btcContext } from './test/fixtures.js';

describe('the context (architecture §8)', () => {
  it('keeps the same hash without times, and through moves smaller than the precision read', () => {
    const a = btcContext();
    const b = btcContext({ asOf: a.asOf + 60_000 });
    b.recentEvents = b.recentEvents.map((e) => ({ ...e, at: e.at + 1 }));
    b.market = { ...b.market, last: '65433.90', volume24hUsd: 1_801_000_000 };
    expect(contextHash(b)).toBe(contextHash(a));
    // A real change: another hash.
    expect(contextHash(btcContext({ market: { ...a.market, last: '65512.00' } }))).not.toBe(contextHash(a));
    expect(contextHash({ ...a, setups: [] })).not.toBe(contextHash(a));
    expect(canonicalContext(a)).not.toContain('asOf');
  });

  it('fits a large context to the token budget, dropping the lowest-priority items first', () => {
    const c = btcContext();
    c.recentEvents = Array.from({ length: 200 }, (_, i) => ({
      id: `evt:${i}`,
      at: c.asOf - i * 60_000,
      type: 'sweep',
      summary: 'A sweep of an equal-highs level on 15m, reclaimed within two candles',
    }));
    const { context, dropped } = trimContext(c, 2_000);
    expect(dropped).toBeGreaterThan(0);
    expect(estimateTokens(JSON.stringify(context))).toBeLessThanOrEqual(2_000);
    // The newest events stay; the setups, structure and market always do.
    expect(context.recentEvents.every((e, i, all) => i === 0 || e.at <= all[i - 1]!.at)).toBe(true);
    expect(context.recentEvents[0]?.id).toBe('evt:0');
    expect(context.setups).toEqual(c.setups);
    expect(context.structure).toEqual(c.structure);
    // A tiny budget empties every list it may, and nothing more.
    const bare = trimContext(btcContext(), 10).context;
    expect([bare.recentEvents, bare.levels, bare.zones, bare.calendar, bare.indicators]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(bare.setups).toHaveLength(1);
    expect(trimContext(btcContext()).dropped).toBe(0);
  });

  it('makes short ids from the end of the UUID, longer only when one is taken', () => {
    const taken = new Set<string>();
    // Time-ordered UUIDs made in the same minute share their start, not their (random) end.
    const a = shortId('lvl', '019a6f00-1c2d-7000-8000-00003f2a9c1e', taken);
    const b = shortId('lvl', '019a6f00-1c2e-7000-8000-00013f2a9c1e', taken);
    const c = shortId('lvl', '019a6f00-1c2f-7000-8000-00013f2a9c1e', taken);
    expect(a).toBe('lvl:3f2a9c1e');
    expect(b).toBe('lvl:00013f2a9c1e');
    expect(c).toBe('lvl:800000013f2a9c1e');
    expect(taken.size).toBe(3);
  });
});

describe('the answer schema (ADR 011)', () => {
  it("stays inside Grok's guaranteed subset", () => {
    const schema = responseJsonSchema();
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(outsideGrokSubset(schema)).toEqual([]);
  });

  it('finds what leaves the subset', () => {
    expect(
      outsideGrokSubset({
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string', maxLength: 5_000 },
          c: { type: 'array', items: { type: 'number' } },
          d: { type: 'array', maxItems: 300, items: [{ type: 'string' }] },
          e: { not: { type: 'string' } },
          f: { anyOf: [] },
          g: { type: 'date' },
          h: { enum: [] },
          i: { allOf: [{}, {}] },
          j: { oneOf: [{ type: 'string' }] },
        },
        required: ['a'],
      }),
    ).toEqual(
      expect.arrayContaining([
        '$.a: a string without maxLength',
        '$.b: maxLength 5000 > 2048',
        '$.c: an array without maxItems',
        '$.d: maxItems 300 > 256',
        '$.d: items as an array',
        '$.e: "not" is best-effort only',
        '$.f: an empty anyOf',
        '$.g: type "date"',
        '$.h: an empty enum',
        '$.i: allOf with several subschemas',
        '$.j.oneOf[0]: a string without maxLength',
        '$.b: not required',
        '$: additionalProperties is not false',
      ]),
    );
    const wide = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'boolean' }])),
    };
    expect(outsideGrokSubset(wide)).toContain('$: 65 properties > 64');
    expect(outsideGrokSubset(null)).toEqual([]);
  });

  it('is the same schema the validator parses with', () => {
    const schema = responseJsonSchema() as { required: string[] };
    expect(schema.required.sort()).toEqual(Object.keys(AiResponseSchema.shape).sort());
  });
});

describe('the prompt (ADR 011: no free text reaches the model)', () => {
  it('states the rules, and says why in fixed words', () => {
    const system = systemPrompt();
    for (const rule of ['Never invent', 'XAUUSD', 'refs', 'no instructions to trade', 'not advice'])
      expect(system).toContain(rule);
    expect(triggerText('event', null, null)).toMatch(/Significant events/);
    expect(triggerText('digest', null, null)).toMatch(/4-hourly/);
    expect(triggerText('on_demand', 'market_summary', null)).toMatch(/summary/);
    expect(triggerText('on_demand', 'refresh', null)).toMatch(/refresh/);
    expect(triggerText('on_demand', 'setup_review', 'setup:5e6f7a8b')).toContain('"setup:5e6f7a8b"');
    expect(triggerText('on_demand', 'setup_review', null)).toMatch(/summary/);
    const m = messages(btcContext(), 'why');
    expect(m.map((x) => x.role)).toEqual(['system', 'user']);
    expect(m[1]!.content).toContain('"contextVersion":"1"');
    expect(PROMPT_VERSION).toBe('ai-1');
  });

  it('sends the first answer and its errors back for the one repair attempt', () => {
    const first = messages(btcContext(), 'why');
    const repair = repairMessages(first, '{"stance":"bullish"}', [
      { rule: 'V2', path: 'observations.0.refs.0', message: 'cites "x", which is not in the context' },
      { rule: 'V1', path: '', message: 'the answer is not JSON' },
    ]);
    expect(repair.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(repair[3]!.content).toContain('- [V2] observations.0.refs.0: cites "x"');
    expect(repair[3]!.content).toContain('- [V1] answer: the answer is not JSON');
  });
});
