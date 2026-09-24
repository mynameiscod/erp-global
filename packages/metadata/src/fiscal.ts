/**
 * First month of the usual financial year per country. Companies can change
 * theirs; countries not listed default to January. Country Packs refine this.
 */
export const FISCAL_YEAR_START: Record<string, number> = {
  IN: 4, // India: April–March
  JP: 4,
  NZ: 4, // New Zealand: April–March
  GB: 4, // UK: April (tax year starts 6 April)
  HK: 4,
  AU: 7, // Australia: July–June
  PK: 7,
  BD: 7,
  EG: 7,
  KE: 7,
  NP: 7,
  US: 1,
  AE: 1,
  SA: 1,
  SG: 1,
};

export function fiscalYearStartFor(countryCode: string | undefined): number {
  return (countryCode && FISCAL_YEAR_START[countryCode.toUpperCase()]) || 1;
}

/** The fiscal year a date falls in, as the calendar year it starts in. */
export function fiscalYearOf(date: Date, startMonth: number): number {
  const m = date.getUTCMonth() + 1;
  const y = date.getUTCFullYear();
  return m >= startMonth ? y : y - 1;
}

/** Label for a fiscal year: `2026-27` when it spans two calendar years, `2026` otherwise. */
export function fiscalYearLabel(date: Date, startMonth: number): string {
  const start = fiscalYearOf(date, startMonth);
  return startMonth === 1
    ? String(start)
    : `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
