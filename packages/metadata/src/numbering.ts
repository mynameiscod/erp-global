import { fiscalYearLabel, fiscalYearOf } from './fiscal';
import type { NumberingSeries } from './types';

/**
 * Number patterns, e.g. `ADM/{FY}/{BRANCH}/{SEQ:5}` gives `ADM/2026-27/HYD/00042`.
 *
 *   {FY}      fiscal year, `2026-27` (or `2026` when the year starts in January)
 *   {YYYY}    calendar year      {YY}  two-digit year
 *   {MM}      month, 01-12       {DD}  day
 *   {BRANCH}  org unit code (or short id)
 *   {SEQ:n}   the running number, zero-padded to n digits (1-12)
 */
const TOKEN_RE = /\{([A-Z]+)(?::(\d{1,2}))?\}/g;
const ALLOWED_TOKENS = new Set(['FY', 'YYYY', 'YY', 'MM', 'DD', 'BRANCH', 'SEQ']);
const LITERAL_RE = /^[A-Za-z0-9/\-_.# ]*$/;

export function validateNumberingPattern(pattern: string): string[] {
  const errors: string[] = [];
  if (!pattern || pattern.length > 60) errors.push('Pattern must be 1-60 characters');
  let seq = 0;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    if (!ALLOWED_TOKENS.has(m[1])) errors.push(`Unknown token {${m[1]}}`);
    if (m[1] === 'SEQ') {
      seq++;
      const width = m[2] ? Number(m[2]) : 1;
      if (width < 1 || width > 12) errors.push('{SEQ:n} width must be 1-12');
    } else if (m[2]) errors.push(`{${m[1]}} does not take a width`);
  }
  if (seq !== 1) errors.push('Pattern must contain {SEQ} exactly once, e.g. {SEQ:5}');
  if (!LITERAL_RE.test(pattern.replace(TOKEN_RE, ''))) {
    errors.push('Only letters, digits, spaces and / - _ . # are allowed outside tokens');
  }
  return errors;
}

/** Which counter a number comes from: counters restart when the period changes. */
export function numberingPeriod(
  series: Pick<NumberingSeries, 'reset'>,
  date: Date,
  fyStartMonth: number,
): string {
  switch (series.reset) {
    case 'never':
      return 'all';
    case 'yearly':
      return `FY${fiscalYearOf(date, fyStartMonth)}`;
    case 'monthly':
      return date.toISOString().slice(0, 7);
  }
}

export interface RenderInput {
  date: Date;
  fyStartMonth: number;
  seq: number;
  branchCode?: string;
}

export function renderNumber(pattern: string, input: RenderInput): string {
  const d = input.date;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return pattern.replace(TOKEN_RE, (_m, token: string, width?: string) => {
    switch (token) {
      case 'FY':
        return fiscalYearLabel(d, input.fyStartMonth);
      case 'YYYY':
        return String(d.getUTCFullYear());
      case 'YY':
        return pad(d.getUTCFullYear() % 100);
      case 'MM':
        return pad(d.getUTCMonth() + 1);
      case 'DD':
        return pad(d.getUTCDate());
      case 'BRANCH':
        return input.branchCode ?? '';
      case 'SEQ':
        return String(input.seq).padStart(width ? Number(width) : 1, '0');
      default:
        return '';
    }
  });
}
