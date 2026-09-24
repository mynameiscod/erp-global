/**
 * Locale-aware formatting. Everything goes through Intl so each company sees
 * its own conventions (e.g. en-IN groups 12,34,567.00; ar-AE uses Arabic digits).
 */

export function formatDateTime(
  value: string | Date | null | undefined,
  locale: string,
  timeZone?: string,
): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

export function formatDate(value: string | Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(new Date(value));
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatCurrency(value: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}
