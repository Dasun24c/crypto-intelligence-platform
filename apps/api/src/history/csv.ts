/**
 * CSV for the exports (RFC 4180: comma-separated, CRLF line ends, a header row). Numbers are
 * written as numbers; text that a spreadsheet would read as a formula (starting with =, +, -, @,
 * a tab or a carriage return) is prefixed with an apostrophe, so opening an export never runs one.
 */
export type CsvValue = string | number | boolean | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/** A whole file: the header, then one line per row. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return csvLine(header) + rows.map(csvLine).join('');
}

/** Epoch milliseconds as ISO 8601 UTC, or empty. */
export const isoOrNull = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();
