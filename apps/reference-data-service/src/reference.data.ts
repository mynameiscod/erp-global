import { countries as countryList } from 'countries-list';
import type { CountryDto, CurrencyDto } from '@erp/contracts';

// The package ships CommonJS at runtime but declares its types as ESM only.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ct: typeof import('countries-and-timezones', {
  with: { 'resolution-mode': 'import' },
}) = require('countries-and-timezones');

/**
 * Country basics for every ISO country, built from open data plus the ICU
 * data bundled with Node (names, currency symbols, decimals). Country Packs
 * add tax, payroll and compliance on top of this later.
 */

const CONTINENTS: Record<string, string> = {
  AF: 'Africa',
  AN: 'Antarctica',
  AS: 'Asia',
  EU: 'Europe',
  NA: 'North America',
  OC: 'Oceania',
  SA: 'South America',
};

interface BaseCountry {
  code: string;
  native: string;
  continent: string;
  callingCodes: string[];
  currencies: string[];
  languages: string[];
  timezones: string[];
}

function buildBase(): BaseCountry[] {
  return Object.entries(countryList).map(([code, c]) => {
    const languages = [...c.languages];
    return {
      code,
      native: c.native,
      continent: CONTINENTS[c.continent] ?? c.continent,
      callingCodes: c.phone.map((p) => `+${p}`),
      currencies: [...c.currency],
      languages,
      timezones: ct.getCountry(code)?.timezones ?? [],
    };
  });
}

const BASE = buildBase();
const BY_CODE = new Map(BASE.map((c) => [c.code, c]));

function displayNames(lang: string, type: 'region' | 'currency' | 'language'): Intl.DisplayNames {
  try {
    return new Intl.DisplayNames([lang, 'en'], { type });
  } catch {
    return new Intl.DisplayNames(['en'], { type });
  }
}

/** Business locale: English variant where English is official, otherwise the first language. */
function defaultLocale(c: BaseCountry): string {
  const lang = c.languages.includes('en') ? 'en' : (c.languages[0] ?? 'en');
  return `${lang}-${c.code}`;
}

function toDto(c: BaseCountry, names: Intl.DisplayNames): CountryDto {
  return {
    code: c.code,
    name: names.of(c.code) ?? c.code,
    nativeName: c.native,
    continent: c.continent,
    callingCodes: c.callingCodes,
    currencies: c.currencies,
    languages: c.languages,
    timezones: c.timezones,
    defaultLocale: defaultLocale(c),
    packLevel: 'basic',
  };
}

export function listCountries(lang = 'en'): CountryDto[] {
  const names = displayNames(lang, 'region');
  const collator = new Intl.Collator(lang);
  return BASE.map((c) => toDto(c, names)).sort((a, b) => collator.compare(a.name, b.name));
}

export function getCountry(code: string, lang = 'en'): CountryDto | undefined {
  const c = BY_CODE.get(code.toUpperCase());
  return c && toDto(c, displayNames(lang, 'region'));
}

export function listCurrencies(lang = 'en'): CurrencyDto[] {
  const names = displayNames(lang, 'currency');
  const codes = [...new Set(BASE.flatMap((c) => c.currencies))].sort();
  const result: CurrencyDto[] = [];
  for (const code of codes) {
    try {
      const fmt = new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
      });
      result.push({
        code,
        name: names.of(code) ?? code,
        symbol: fmt.formatToParts(0).find((p) => p.type === 'currency')?.value ?? code,
        decimals: fmt.resolvedOptions().maximumFractionDigits ?? 2,
      });
    } catch {
      // Not a currency ICU knows (e.g. withdrawn codes); skip it.
    }
  }
  return result;
}

export function listLanguages(lang = 'en'): { code: string; name: string; nativeName: string }[] {
  const names = displayNames(lang, 'language');
  const codes = [...new Set(BASE.flatMap((c) => c.languages))].sort();
  return codes.map((code) => ({
    code,
    name: names.of(code) ?? code,
    nativeName: displayNames(code, 'language').of(code) ?? code,
  }));
}

export function listTimezones(): { id: string; utcOffset: string; countries: string[] }[] {
  return Object.values(ct.getAllTimezones())
    .filter((tz) => !tz.aliasOf)
    .map((tz) => ({ id: tz.name, utcOffset: tz.utcOffsetStr, countries: tz.countries }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
