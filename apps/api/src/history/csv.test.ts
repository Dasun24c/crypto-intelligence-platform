import { describe, expect, it } from 'vitest';
import { csvField, csvLine, isoOrNull, toCsv } from './csv.js';

describe('CSV exports', () => {
  it('writes numbers and booleans plainly, and nothing for missing values', () => {
    expect([1.5, 0, -2, Number.NaN, true, false, null, undefined].map(csvField)).toEqual([
      '1.5',
      '0',
      '-2',
      '',
      'yes',
      'no',
      '',
      '',
    ]);
  });

  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('plain')).toBe('plain');
  });

  it('never lets a spreadsheet read text as a formula', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])
      expect(csvField(s).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('ends every line with CRLF, header first', () => {
    expect(csvLine(['a', 1, null])).toBe('a,1,\r\n');
    expect(
      toCsv(
        ['x', 'y'],
        [
          [1, 'b'],
          [2, 'c,d'],
        ],
      ),
    ).toBe('x,y\r\n1,b\r\n2,"c,d"\r\n');
    expect(toCsv(['only'], [])).toBe('only\r\n');
  });

  it('writes instants as ISO 8601 UTC', () => {
    expect(isoOrNull(Date.UTC(2026, 10, 22, 9, 30))).toBe('2026-11-22T09:30:00.000Z');
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
  });
});
