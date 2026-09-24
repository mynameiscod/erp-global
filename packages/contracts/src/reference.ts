/** Industries a tenant can choose at sign-up. Industry Packs later attach config to these codes. */
export const INDUSTRIES = [
  { code: 'education', name: 'Education' },
  { code: 'retail', name: 'Retail & POS' },
  { code: 'services', name: 'Services & Agency' },
  { code: 'healthcare', name: 'Healthcare & Clinics' },
  { code: 'manufacturing', name: 'Manufacturing' },
  { code: 'distribution', name: 'Wholesale & Distribution' },
  { code: 'hospitality', name: 'Hospitality & Restaurants' },
  { code: 'construction', name: 'Construction & Real Estate' },
  { code: 'logistics', name: 'Logistics & Transport' },
  { code: 'nonprofit', name: 'Non-profit' },
  { code: 'other', name: 'Other' },
] as const;

export type IndustryCode = (typeof INDUSTRIES)[number]['code'];

export const INDUSTRY_CODES = INDUSTRIES.map((i) => i.code) as [IndustryCode, ...IndustryCode[]];

/** UI languages with translation files in Step 1. */
export const UI_LANGUAGES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
] as const;

export interface CountryDto {
  code: string;
  name: string;
  nativeName: string;
  continent: string;
  callingCodes: string[];
  currencies: string[];
  languages: string[];
  timezones: string[];
  defaultLocale: string;
  /** How much of the Country Pack exists: basic = data-driven only; full = tax/payroll pack. */
  packLevel: 'basic' | 'full';
}

export interface CurrencyDto {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}
