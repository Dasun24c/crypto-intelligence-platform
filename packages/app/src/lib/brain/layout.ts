import { type Region, REGIONS } from './state.js';

/**
 * Where the brain's nodes, connections and particle paths are (ADR 024). A seeded generator places
 * them once, so the layout is the same on every load; it never drives a state or a rate.
 */

/** mulberry32: a small seeded generator (the same seed gives the same sequence). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LAYOUT_SEED = 20261116;
export const NODE_COUNT = 1_600;
export const MAX_PARTICLES = 20_000;
/** Each node links to its nearest neighbours closer than this. */
const LINK_RADIUS = 0.32;
const LINKS_PER_NODE = 2;

/** Two hemispheres: ellipsoids side by side (x left–right, y up, z back–front). */
const HEMISPHERES = [
  { cx: -0.52, rx: 0.78, ry: 0.72, rz: 1.08 },
  { cx: 0.52, rx: 0.78, ry: 0.72, rz: 1.08 },
] as const;

/** The region of a point: ingestion at the back, AI at the front, alerts low in the middle, analysis above. */
export function regionAt(y: number, z: number): Region {
  if (z < -0.38) return 'ingestion';
  if (z > 0.42) return 'ai';
  return y < -0.22 ? 'alerts' : 'analysis';
}

export interface BrainLayout {
  /** xyz per node. */
  positions: Float32Array;
  /** Region index (into REGIONS) per node. */
  regions: Uint8Array;
  /** Each node's place in the firing cycle, 0–1. */
  phases: Float32Array;
  /** Node indices by region. */
  byRegion: Record<Region, number[]>;
  /** Pairs of node indices. */
  links: Uint32Array;
  /** Per particle: start (ingestion), bend (analysis), end (AI or alerts), xyz each. */
  particleA: Float32Array;
  particleB: Float32Array;
  particleC: Float32Array;
  /** Per particle: its place along the path, 0–1, and its relative speed, 0.6–1.4. */
  particleOffset: Float32Array;
  particleRate: Float32Array;
  /** Each region's centre. */
  centres: Record<Region, [number, number, number]>;
}

export function buildLayout(seed = LAYOUT_SEED, nodes = NODE_COUNT, particles = MAX_PARTICLES): BrainLayout {
  const rand = seeded(seed);
  const positions = new Float32Array(nodes * 3);
  const regionIdx = new Uint8Array(nodes);
  const phases = new Float32Array(nodes);
  const byRegion: Record<Region, number[]> = { ingestion: [], analysis: [], ai: [], alerts: [] };
  for (let i = 0; i < nodes; i++) {
    const h = HEMISPHERES[i % 2]!;
    // A point in the unit ball, pushed towards the surface (a cortex-like shell).
    let x = 0;
    let y = 0;
    let z = 0;
    let d = 2;
    while (d > 1 || d < 1e-6) {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = rand() * 2 - 1;
      d = x * x + y * y + z * z;
    }
    const len = Math.sqrt(d);
    const shell = Math.pow(len, 0.35) / len;
    const px = h.cx + x * shell * h.rx;
    const py = y * shell * h.ry;
    const pz = z * shell * h.rz;
    positions.set([px, py, pz], i * 3);
    const region = regionAt(py, pz);
    regionIdx[i] = REGIONS.indexOf(region);
    byRegion[region].push(i);
    phases[i] = rand();
  }

  const links: number[] = [];
  for (let i = 0; i < nodes; i++) {
    const near: { j: number; d: number }[] = [];
    for (let j = i + 1; j < nodes; j++) {
      const dx = positions[i * 3]! - positions[j * 3]!;
      const dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!;
      const dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < LINK_RADIUS * LINK_RADIUS) near.push({ j, d: dist });
    }
    near.sort((a, b) => a.d - b.d);
    for (const { j } of near.slice(0, LINKS_PER_NODE)) links.push(i, j);
  }

  const centres = {} as Record<Region, [number, number, number]>;
  for (const r of REGIONS) {
    const ids = byRegion[r];
    const c: [number, number, number] = [0, 0, 0];
    for (const i of ids) for (let k = 0; k < 3; k++) c[k]! += positions[i * 3 + k]! / Math.max(1, ids.length);
    centres[r] = c;
  }

  const particleA = new Float32Array(particles * 3);
  const particleB = new Float32Array(particles * 3);
  const particleC = new Float32Array(particles * 3);
  const particleOffset = new Float32Array(particles);
  const particleRate = new Float32Array(particles);
  const pick = (ids: number[]) => ids[Math.floor(rand() * ids.length)] ?? 0;
  for (let p = 0; p < particles; p++) {
    const a = pick(byRegion.ingestion);
    const b = pick(byRegion.analysis);
    // Most of what is analysed goes on to the AI region; some becomes alerts.
    const c = rand() < 0.7 ? pick(byRegion.ai) : pick(byRegion.alerts);
    for (let k = 0; k < 3; k++) {
      particleA[p * 3 + k] = positions[a * 3 + k]!;
      particleB[p * 3 + k] = positions[b * 3 + k]!;
      particleC[p * 3 + k] = positions[c * 3 + k]!;
    }
    particleOffset[p] = rand();
    particleRate[p] = 0.6 + rand() * 0.8;
  }

  return {
    positions,
    regions: regionIdx,
    phases,
    byRegion,
    links: Uint32Array.from(links),
    particleA,
    particleB,
    particleC,
    particleOffset,
    particleRate,
    centres,
  };
}
