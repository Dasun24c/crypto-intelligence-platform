/**
 * Writes the synthetic golden fixtures to packages/smc-engine/fixtures/<concept>/<id>.json in the
 * rulebook §12 format. Run with `pnpm --filter @cip/smc-engine fixtures`. Recorded fixtures (from
 * the labelling page) live in the same folders and are never touched.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { checklistCases } from './cases-checklist.ts';
import { goldCases } from './cases-gold.ts';
import { levelCases } from './cases-levels.ts';
import { patternCases } from './cases-patterns.ts';
import { rangeCases } from './cases-ranges.ts';
import { setupCases } from './cases-setups.ts';
import { structureCases } from './cases-structure.ts';
import { sweepCases } from './cases-sweeps.ts';
import { zoneCases } from './cases-zones.ts';
import { type Case, type Exp, fmt, TF_MS, type Tf } from './lib.ts';

export const SOURCE = 'synthetic: packages/smc-engine/scripts/fixtures';
const OUT = new URL('../../fixtures/', import.meta.url);

const cases: Case[] = [
  ...structureCases,
  ...rangeCases,
  ...levelCases,
  ...sweepCases,
  ...goldCases,
  ...zoneCases,
  ...patternCases,
  ...setupCases,
  ...checklistCases,
];

function toJson(c: Case): unknown {
  const series = [
    { ...c.main, start: c.start },
    ...(c.more ?? []).map((s) => ({ ...s, start: s.start ?? c.start })),
  ];
  const startOf = (tf: Tf) => {
    const s = series.find((x) => x.tf === tf);
    if (!s) throw new Error(`${c.id}: no ${tf} series`);
    return s.start;
  };
  const candles: Record<string, unknown[]> = {};
  for (const s of series) {
    const rows: unknown[] = [];
    s.bars.forEach((b, i) => {
      if (!b) return;
      const x = s.extras?.[i];
      const row: unknown[] = [
        s.start + i * TF_MS[s.tf],
        fmt(b[0]),
        fmt(b[1]),
        fmt(b[2]),
        fmt(b[3]),
        String(x?.volume ?? 10),
      ];
      const extra: Record<string, unknown> = {};
      if (x?.profile !== undefined) extra.profile = x.profile;
      if (x?.partial) extra.quality = 'partial';
      if (Object.keys(extra).length) row.push(extra);
      rows.push(row);
    });
    candles[s.tf] = rows;
  }
  const close = (tf: Tf, i: number) => new Date(startOf(tf) + (i + 1) * TF_MS[tf]).toISOString();
  const exp = (e: Exp, defaultTf: boolean) => {
    const tf = e.tf ?? (defaultTf ? c.main.tf : undefined);
    const ref = e.tf ?? c.main.tf;
    return {
      type: e.type,
      ...(tf ? { tf } : {}),
      ...(e.at !== undefined ? { at: close(ref, e.at) } : {}),
      ...(e.after !== undefined ? { after: close(ref, e.after) } : {}),
      ...(e.before !== undefined ? { before: close(ref, e.before) } : {}),
      ...(e.key !== undefined ? { key: e.key } : {}),
      ...(e.data !== undefined ? { data: e.data } : {}),
    };
  };
  return {
    id: c.id,
    concept: c.concept,
    class: c.class,
    description: c.description,
    profile: c.profile ?? 'crypto-majors',
    ...(c.params ? { params: c.params } : {}),
    tick: '0.01',
    source: SOURCE,
    candles,
    context: {
      closures: (c.closures ?? []).map((x) => ({
        from: new Date(x.from).toISOString(),
        to: new Date(x.to).toISOString(),
        reason: x.reason,
      })),
      economicEvents:
        c.economicEvents === null
          ? null
          : (c.economicEvents ?? []).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    },
    expected: c.expected.map((e) => exp(e, true)),
    notExpected: (c.notExpected ?? []).map((e) => exp(e, false)),
    ...(c.exhaustive ? { exhaustive: c.exhaustive } : {}),
    labelledBy: 'synthetic: worked out by hand from the rulebook (Claude); bearish twins by exact mirroring',
    reviewedBy: null,
  };
}

/** JSON with two-space indentation, but every array of plain values (a candle, a profile) on one line. */
function pretty(value: unknown): string {
  const plain = String.raw`(?:-?[\d.e+-]+|"[^"\\]*"|null|true|false)`;
  const flatArray = new RegExp(String.raw`\[\s*(${plain}(?:,\s*${plain})*)\s*\]`, 'g');
  return JSON.stringify(value, null, 2).replace(
    flatArray,
    (_, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`,
  );
}

function removeOldSynthetic(dir: URL): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) removeOldSynthetic(path);
    else if (
      entry.name.endsWith('.json') &&
      (JSON.parse(readFileSync(path, 'utf8')) as { source?: string }).source === SOURCE
    )
      unlinkSync(path);
  }
}

const ids = new Set<string>();
for (const c of cases) {
  for (const s of [c.main, ...(c.more ?? [])])
    s.bars.forEach((v, i) => {
      if (v && !(v[2] <= Math.min(v[0], v[3]) && v[1] >= Math.max(v[0], v[3]) && v[2] <= v[1]))
        throw new Error(`${c.id}: ${s.tf} candle ${i} [${v.join(', ')}] is inconsistent`);
    });
  if (ids.has(c.id)) throw new Error(`duplicate fixture id ${c.id}`);
  ids.add(c.id);
}
removeOldSynthetic(OUT);
for (const c of cases) {
  const dir = new URL(`${c.concept}/`, OUT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${c.id}.json`, dir), pretty(toJson(c)) + '\n');
}
console.log(`wrote ${cases.length} fixtures`);
