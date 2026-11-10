import { describe, expect, it } from 'vitest';
import { formatAge, formatInstant } from './format.js';

describe('format', () => {
  it('shows data age in the largest sensible unit', () => {
    expect(formatAge(4_200)).toBe('4 s');
    expect(formatAge(185_000)).toBe('3 min');
    expect(formatAge(2 * 3_600_000)).toBe('2 h');
    expect(formatAge(72 * 3_600_000)).toBe('3 d');
    expect(formatAge(-5)).toBe('0 s');
  });

  it('formats instants in the requested time zone with its name', () => {
    const t = Date.UTC(2026, 10, 10, 12, 30, 0);
    expect(formatInstant(t, 'UTC')).toContain('12:30:00');
    expect(formatInstant(t, 'UTC')).toContain('UTC');
    expect(formatInstant(t, 'Asia/Colombo')).toContain('18:00:00');
  });
});
