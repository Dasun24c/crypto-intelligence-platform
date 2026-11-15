// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatBps,
  formatCompactUsd,
  formatDecimal,
  formatPct,
  formatUsd,
  roundDecimal,
  spreadBps,
  stepDecimals,
} from './decimal.js';

describe('decimal display', () => {
  it('groups thousands and keeps every significant digit, without a float', () => {
    expect(formatDecimal('74012.35')).toBe('74,012.35');
    expect(formatDecimal('1234567890123.123456789')).toBe('1,234,567,890,123.123456789');
    // 0.1 + 0.2 style float noise never appears: the digits are the venue's.
    expect(formatDecimal('0.30000000000000004')).toBe('0.30000000000000004');
    expect(formatDecimal('100')).toBe('100');
    expect(formatDecimal('-1234.5')).toBe('-1,234.5');
    expect(formatDecimal('-0.000')).toBe('0');
    expect(formatDecimal('007.10')).toBe('7.1');
  });

  it('pads or trims trailing zeros to the tick precision, never dropping a significant digit', () => {
    expect(formatDecimal('74012.3', 2)).toBe('74,012.30');
    expect(formatDecimal('74012.30000000', 2)).toBe('74,012.30');
    expect(formatDecimal('74012.355', 2)).toBe('74,012.355');
    expect(formatDecimal('74012', 2)).toBe('74,012.00');
    expect(stepDecimals('0.01')).toBe(2);
    expect(stepDecimals('0.01000000')).toBe(2);
    expect(stepDecimals('0.00001')).toBe(5);
    expect(stepDecimals('1')).toBe(0);
  });

  it('leaves anything that is not a decimal string unchanged', () => {
    expect(formatDecimal('n/a')).toBe('n/a');
    expect(formatDecimal('1e-7')).toBe('1e-7');
    expect(roundDecimal('abc', 2)).toBe('abc');
  });

  it('rounds derived values half away from zero, on the digits', () => {
    expect(roundDecimal('185030.875', 2)).toBe('185030.88');
    expect(roundDecimal('0.005', 2)).toBe('0.01');
    expect(roundDecimal('9.999', 2)).toBe('10.00');
    expect(roundDecimal('-1.005', 2)).toBe('-1.01');
    expect(roundDecimal('-0.001', 2)).toBe('0.00');
    expect(roundDecimal('2.5', 0)).toBe('3');
    expect(roundDecimal('1.2', 4)).toBe('1.2');
  });

  it('formats USD amounts, ratios and changes', () => {
    expect(formatUsd('185030.875')).toBe('$185,030.88');
    expect(formatUsd('150000', 0)).toBe('$150,000');
    expect(formatUsd('-12.5')).toBe('-$12.50');
    expect(formatCompactUsd(1_234_567)).toBe('$1.23M');
    expect(formatCompactUsd(null)).toBe('—');
    expect(formatBps(2.3456, true)).toBe('+2.35 bps');
    expect(formatBps(-0.5, true)).toBe('-0.50 bps');
    expect(formatBps(1.2)).toBe('1.20 bps');
    expect(formatBps(null)).toBe('—');
    expect(formatPct(1.234)).toBe('+1.23%');
    expect(formatPct(-0.4)).toBe('-0.40%');
    expect(formatPct(0)).toBe('0.00%');
  });

  it('computes the bid-ask spread in bps of the mid', () => {
    expect(spreadBps('99.99', '100.01')).toBeCloseTo(2, 6);
    expect(spreadBps('0', '100')).toBeNull();
    expect(spreadBps('', '100')).toBeNull();
  });
});
