/**
 * Formatting for documents and exports: numbers, money and dates follow the
 * company's locale (12,34,567.00 in India), amounts in words follow the
 * currency's number system (lakh/crore or million/billion).
 */

const numberFormats = new Map<string, Intl.NumberFormat>();

function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = numberFormats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat('en', opts);
    }
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(value: unknown, locale: string, scale?: number): string {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '';
  const opts: Intl.NumberFormatOptions =
    scale === undefined
      ? { maximumFractionDigits: 6 }
      : { minimumFractionDigits: scale, maximumFractionDigits: scale };
  return nf(locale, opts).format(n);
}

export function formatCurrency(
  value: unknown,
  currency: string,
  locale: string,
  scale = 2,
): string {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '';
  try {
    return nf(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(n);
  } catch {
    return `${currency} ${formatNumber(n, locale, scale)}`;
  }
}

/** A `YYYY-MM-DD` date, e.g. 25 Sept 2026 (en-IN). */
export function formatDate(value: unknown, locale: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '';
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  } catch {
    return value.slice(0, 10);
  }
}

/** A moment in time, shown in the company's time zone. */
export function formatDateTime(value: unknown, locale: string, timezone: string): string {
  const d = typeof value === 'string' || value instanceof Date ? new Date(value) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

// ---- amounts in words ----

interface CurrencyWords {
  major: string;
  minor: string;
  /** "Rupees Five Hundred" rather than "Five Hundred Dollars". */
  majorFirst?: boolean;
  system?: 'indian' | 'international';
  /** Minor units per major unit: 100 for most, 1000 for dinars. */
  minorUnits?: number;
}

/** Names used in words. Currencies not listed use their code and "cents". */
export const CURRENCY_WORDS: Record<string, CurrencyWords> = {
  INR: { major: 'Rupees', minor: 'Paise', majorFirst: true, system: 'indian' },
  PKR: { major: 'Rupees', minor: 'Paisa', majorFirst: true, system: 'indian' },
  NPR: { major: 'Rupees', minor: 'Paisa', majorFirst: true, system: 'indian' },
  LKR: { major: 'Rupees', minor: 'Cents', majorFirst: true, system: 'indian' },
  BDT: { major: 'Taka', minor: 'Poisha', majorFirst: true, system: 'indian' },
  USD: { major: 'Dollars', minor: 'Cents' },
  CAD: { major: 'Canadian Dollars', minor: 'Cents' },
  AUD: { major: 'Australian Dollars', minor: 'Cents' },
  NZD: { major: 'New Zealand Dollars', minor: 'Cents' },
  SGD: { major: 'Singapore Dollars', minor: 'Cents' },
  EUR: { major: 'Euros', minor: 'Cents' },
  GBP: { major: 'Pounds', minor: 'Pence' },
  AED: { major: 'Dirhams', minor: 'Fils' },
  SAR: { major: 'Riyals', minor: 'Halalas' },
  QAR: { major: 'Riyals', minor: 'Dirhams' },
  OMR: { major: 'Rials', minor: 'Baisa', minorUnits: 1000 },
  KWD: { major: 'Dinars', minor: 'Fils', minorUnits: 1000 },
  BHD: { major: 'Dinars', minor: 'Fils', minorUnits: 1000 },
  MYR: { major: 'Ringgit', minor: 'Sen' },
  ZAR: { major: 'Rand', minor: 'Cents' },
  KES: { major: 'Shillings', minor: 'Cents' },
  NGN: { major: 'Naira', minor: 'Kobo' },
  JPY: { major: 'Yen', minor: '', minorUnits: 1 },
  CNY: { major: 'Yuan', minor: 'Fen' },
};

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? below100(rest) : ''].filter(Boolean).join(' ');
}

const SCALES: Record<'indian' | 'international', [number, string][]> = {
  indian: [
    [1e7, 'Crore'],
    [1e5, 'Lakh'],
    [1e3, 'Thousand'],
  ],
  international: [
    [1e12, 'Trillion'],
    [1e9, 'Billion'],
    [1e6, 'Million'],
    [1e3, 'Thousand'],
  ],
};

/** A whole number in English words, e.g. 125000 → "One Lakh Twenty Five Thousand". */
export function integerInWords(value: number, system: 'indian' | 'international'): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  // Amounts beyond the largest scale repeat it: 1,000 crore is "One Thousand Crore".
  const [top, topName] = SCALES[system][0];
  if (n >= top * 1000 && system === 'indian') {
    parts.push(`${integerInWords(Math.floor(n / top), system)} ${topName}`);
    n %= top;
  }
  for (const [size, name] of SCALES[system]) {
    if (n >= size) {
      const count = Math.floor(n / size);
      parts.push(`${system === 'indian' ? below100Or1000(count) : below1000(count)} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

function below100Or1000(n: number): string {
  return n < 100 ? below100(n) : below1000(n);
}

/**
 * An amount in words for invoices and receipts, e.g.
 * "Rupees Twelve Thousand Five Hundred and Fifty Paise Only".
 */
export function amountInWords(value: unknown, currency: string): string {
  const n = Number(
    typeof value === 'object' && value ? (value as { amount?: unknown }).amount : value,
  );
  if (!Number.isFinite(n)) return '';
  const words = CURRENCY_WORDS[currency.toUpperCase()] ?? {
    major: currency.toUpperCase(),
    minor: 'Cents',
  };
  const system = words.system ?? 'international';
  const units = words.minorUnits ?? 100;
  const totalMinor = Math.round(Math.abs(n) * units);
  const major = Math.floor(totalMinor / units);
  const minor = totalMinor % units;
  const majorText = integerInWords(major, system);
  const main = words.majorFirst ? `${words.major} ${majorText}` : `${majorText} ${words.major}`;
  const minorText =
    minor && words.minor ? ` and ${integerInWords(minor, system)} ${words.minor}` : '';
  return `${n < 0 ? 'Minus ' : ''}${main}${minorText} Only`;
}

// ---- Hindi ----

/** 0–99 in Hindi: each number has its own word. */
const HI_BELOW_100 = [
  'शून्य',
  'एक',
  'दो',
  'तीन',
  'चार',
  'पाँच',
  'छह',
  'सात',
  'आठ',
  'नौ',
  'दस',
  'ग्यारह',
  'बारह',
  'तेरह',
  'चौदह',
  'पंद्रह',
  'सोलह',
  'सत्रह',
  'अठारह',
  'उन्नीस',
  'बीस',
  'इक्कीस',
  'बाईस',
  'तेईस',
  'चौबीस',
  'पच्चीस',
  'छब्बीस',
  'सत्ताईस',
  'अट्ठाईस',
  'उनतीस',
  'तीस',
  'इकतीस',
  'बत्तीस',
  'तैंतीस',
  'चौंतीस',
  'पैंतीस',
  'छत्तीस',
  'सैंतीस',
  'अड़तीस',
  'उनतालीस',
  'चालीस',
  'इकतालीस',
  'बयालीस',
  'तैंतालीस',
  'चवालीस',
  'पैंतालीस',
  'छियालीस',
  'सैंतालीस',
  'अड़तालीस',
  'उनचास',
  'पचास',
  'इक्यावन',
  'बावन',
  'तिरपन',
  'चौवन',
  'पचपन',
  'छप्पन',
  'सत्तावन',
  'अट्ठावन',
  'उनसठ',
  'साठ',
  'इकसठ',
  'बासठ',
  'तिरसठ',
  'चौंसठ',
  'पैंसठ',
  'छियासठ',
  'सड़सठ',
  'अड़सठ',
  'उनहत्तर',
  'सत्तर',
  'इकहत्तर',
  'बहत्तर',
  'तिहत्तर',
  'चौहत्तर',
  'पचहत्तर',
  'छिहत्तर',
  'सतहत्तर',
  'अठहत्तर',
  'उन्यासी',
  'अस्सी',
  'इक्यासी',
  'बयासी',
  'तिरासी',
  'चौरासी',
  'पचासी',
  'छियासी',
  'सत्तासी',
  'अट्ठासी',
  'नवासी',
  'नब्बे',
  'इक्यानबे',
  'बानबे',
  'तिरानबे',
  'चौरानबे',
  'पचानबे',
  'छियानबे',
  'सत्तानबे',
  'अट्ठानबे',
  'निन्यानबे',
];

function hindiInteger(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return HI_BELOW_100[0];
  const parts: string[] = [];
  const scale = (size: number, name: string) => {
    if (n >= size) {
      const count = Math.floor(n / size);
      parts.push(`${count >= 100 ? hindiInteger(count) : HI_BELOW_100[count]} ${name}`);
      n %= size;
    }
  };
  scale(1e7, 'करोड़');
  scale(1e5, 'लाख');
  scale(1e3, 'हज़ार');
  scale(100, 'सौ');
  if (n) parts.push(HI_BELOW_100[n]);
  return parts.join(' ');
}

/** Currency names in Hindi for the currencies that use them. */
const HI_CURRENCY: Record<string, { major: string; minor: string }> = {
  INR: { major: 'रुपये', minor: 'पैसे' },
  NPR: { major: 'रुपये', minor: 'पैसे' },
  PKR: { major: 'रुपये', minor: 'पैसे' },
};

/** Languages amounts can be written in; others fall back to English. */
export const WORDS_LANGUAGES = ['en', 'hi'];

/**
 * An amount in words in `lang` where the language is supported (English and Hindi),
 * e.g. "रुपये बारह हज़ार पाँच सौ और पचास पैसे मात्र".
 */
export function amountInWordsIn(value: unknown, currency: string, lang: string): string {
  const base = lang.split('-')[0];
  const names = HI_CURRENCY[currency.toUpperCase()];
  if (base !== 'hi' || !names) return amountInWords(value, currency);
  const n = Number(
    typeof value === 'object' && value ? (value as { amount?: unknown }).amount : value,
  );
  if (!Number.isFinite(n)) return '';
  const totalMinor = Math.round(Math.abs(n) * 100);
  const major = Math.floor(totalMinor / 100);
  const minor = totalMinor % 100;
  const minorText = minor ? ` और ${HI_BELOW_100[minor]} ${names.minor}` : '';
  return `${n < 0 ? 'ऋण ' : ''}${names.major} ${hindiInteger(major)}${minorText} मात्र`;
}
