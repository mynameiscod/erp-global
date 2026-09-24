import { describe, expect, it } from 'vitest';
import ar from '../i18n/locales/ar.json';
import en from '../i18n/locales/en.json';
import hi from '../i18n/locales/hi.json';
import { formatCurrency, formatNumber } from './format';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('translations', () => {
  it.each([
    ['hi', hi],
    ['ar', ar],
  ])('%s has exactly the English keys', (_lang, dict) => {
    expect(keys(dict).sort()).toEqual(keys(en).sort());
  });

  it('keeps interpolation placeholders', () => {
    const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();
    const flat = (d: object) =>
      Object.fromEntries(
        keys(d).map((k) => [
          k,
          k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], d),
        ]),
      );
    const e = flat(en);
    for (const dict of [hi, ar]) {
      const f = flat(dict);
      for (const k of Object.keys(e))
        expect([k, placeholders(String(f[k]))]).toEqual([k, placeholders(String(e[k]))]);
    }
  });
});

describe('regional formats', () => {
  it('uses Indian digit grouping for en-IN', () => {
    expect(formatNumber(1234567, 'en-IN')).toBe('12,34,567');
    expect(formatCurrency(1234567.5, 'INR', 'en-IN')).toBe('₹12,34,567.50');
  });

  it('uses three decimals for Kuwaiti dinar', () => {
    expect(formatCurrency(1.5, 'KWD', 'en')).toMatch(/1\.500/);
  });
});
