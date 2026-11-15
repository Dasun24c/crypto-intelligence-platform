/**
 * Chart colours, read from the design system's tokens (packages/ui theme.css) so charts follow the
 * theme; the fallbacks are the same values, for environments without the stylesheet (tests).
 */
export interface ChartColors {
  bg: string;
  surface: string;
  border: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  bull: string;
  bear: string;
  ok: string;
  warn: string;
  crit: string;
  info: string;
}

const FALLBACK: ChartColors = {
  bg: '#0b0e14',
  surface: '#11151d',
  border: '#262d3b',
  fg: '#e6e9ef',
  muted: '#9aa4b5',
  subtle: '#6b7486',
  accent: '#7aa2ff',
  bull: '#4ea1ff',
  bear: '#ff9246',
  ok: '#3fb68b',
  warn: '#e3b341',
  crit: '#f0616d',
  info: '#7aa2ff',
};

const TOKENS: Record<keyof ChartColors, string> = {
  bg: '--color-bg',
  surface: '--color-surface',
  border: '--color-border',
  fg: '--color-fg',
  muted: '--color-fg-muted',
  subtle: '--color-fg-subtle',
  accent: '--color-accent',
  bull: '--color-bull',
  bear: '--color-bear',
  ok: '--color-ok',
  warn: '--color-warn',
  crit: '--color-crit',
  info: '--color-info',
};

export function chartColors(): ChartColors {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const out = { ...FALLBACK };
  for (const key of Object.keys(TOKENS) as (keyof ChartColors)[]) {
    const value = style.getPropertyValue(TOKENS[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}

/** `#rrggbb` at an opacity, for fills. */
export function alpha(hex: string, opacity: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16));
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export const CHART_FONT = '11px "Inter Variable", Inter, system-ui, sans-serif';
