import { fiscalYearLabel } from './fiscal';
import type { WorkCalendar } from './identifiers';
import type { DateBucket, RelativeDate } from './reports';

/**
 * Relative periods ("this month", "last fiscal year") as date ranges, in the
 * company's time zone. Ranges are [from, to): `to` is the day after the last day.
 */

export interface DateRange {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, exclusive. */
  to: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Today's date in a time zone, as a UTC midnight. */
export function todayIn(timezone: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${parts}T00:00:00Z`);
}

/** First day of the fiscal quarter or year containing `d`. */
function fiscalStart(d: Date, fyStartMonth: number, months: 3 | 12): Date {
  const m0 = fyStartMonth - 1;
  const monthsIntoFy = (d.getUTCMonth() - m0 + 12) % 12;
  const back = monthsIntoFy % months;
  return utc(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
}

export function resolveRelative(
  period: RelativeDate,
  opts: { timezone: string; fyStartMonth: number; n?: number; now?: Date },
): DateRange {
  const today = todayIn(opts.timezone, opts.now);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const n = Math.max(1, opts.n ?? 7);
  // Weeks start on Monday.
  const weekStart = addDays(today, -((today.getUTCDay() + 6) % 7));
  const range = (from: Date, to: Date): DateRange => ({ from: iso(from), to: iso(to) });
  switch (period) {
    case 'today':
      return range(today, addDays(today, 1));
    case 'yesterday':
      return range(addDays(today, -1), today);
    case 'this_week':
      return range(weekStart, addDays(weekStart, 7));
    case 'last_week':
      return range(addDays(weekStart, -7), weekStart);
    case 'this_month':
      return range(utc(y, m, 1), utc(y, m + 1, 1));
    case 'last_month':
      return range(utc(y, m - 1, 1), utc(y, m, 1));
    case 'this_quarter': {
      const s = fiscalStart(today, opts.fyStartMonth, 3);
      return range(s, utc(s.getUTCFullYear(), s.getUTCMonth() + 3, 1));
    }
    case 'last_quarter': {
      const s = fiscalStart(today, opts.fyStartMonth, 3);
      return range(utc(s.getUTCFullYear(), s.getUTCMonth() - 3, 1), s);
    }
    case 'this_fiscal_year': {
      const s = fiscalStart(today, opts.fyStartMonth, 12);
      return range(s, utc(s.getUTCFullYear() + 1, s.getUTCMonth(), 1));
    }
    case 'last_fiscal_year': {
      const s = fiscalStart(today, opts.fyStartMonth, 12);
      return range(utc(s.getUTCFullYear() - 1, s.getUTCMonth(), 1), s);
    }
    case 'last_n_days':
      return range(addDays(today, -(n - 1)), addDays(today, 1));
    case 'next_n_days':
      return range(today, addDays(today, n));
  }
}

/** The range of the same length just before `r`, for "compared with the previous period". */
export function previousRange(r: DateRange): DateRange {
  const from = new Date(`${r.from}T00:00:00Z`);
  const to = new Date(`${r.to}T00:00:00Z`);
  // Whole months keep month lengths right (e.g. this month vs last month).
  const monthAligned =
    from.getUTCDate() === 1 &&
    to.getUTCDate() === 1 &&
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() >= 1;
  if (monthAligned) {
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    return { from: iso(utc(from.getUTCFullYear(), from.getUTCMonth() - months, 1)), to: r.from };
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return { from: iso(addDays(from, -days)), to: r.from };
}

/**
 * The group key of a date for a bucket, e.g. `2026-09` for a month, `2026-27 Q2` for a
 * fiscal quarter. Must match the keys records-service computes in the database.
 */
export function bucketKey(date: string, bucket: DateBucket, fyStartMonth: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  switch (bucket) {
    case 'day':
      return iso(d);
    case 'week': {
      // ISO week: the Thursday of the week decides the year.
      const thursday = addDays(d, 3 - ((d.getUTCDay() + 6) % 7));
      const wy = thursday.getUTCFullYear();
      const week =
        Math.floor((thursday.getTime() - utc(wy, 0, 1).getTime()) / (7 * 86_400_000)) + 1;
      return `${wy}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarter': {
      const q = Math.floor(((m - fyStartMonth + 12) % 12) / 3) + 1;
      return `${fiscalYearLabel(d, fyStartMonth)} Q${q}`;
    }
    case 'year':
      return String(y);
    case 'fiscal_year':
      return fiscalYearLabel(d, fyStartMonth);
  }
}

/** The date range a bucket key covers, for drill-down. */
export function bucketRange(key: string, bucket: DateBucket, fyStartMonth: number): DateRange {
  const fyYear = (label: string) => Number(label.slice(0, 4));
  switch (bucket) {
    case 'day': {
      const d = new Date(`${key}T00:00:00Z`);
      return { from: key, to: iso(addDays(d, 1)) };
    }
    case 'week': {
      const [wy, w] = key.split('-W').map(Number);
      // Monday of ISO week 1 is the Monday on or before 4 January.
      const jan4 = utc(wy, 0, 4);
      const week1 = addDays(jan4, -((jan4.getUTCDay() + 6) % 7));
      const from = addDays(week1, (w - 1) * 7);
      return { from: iso(from), to: iso(addDays(from, 7)) };
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return { from: iso(utc(y, m - 1, 1)), to: iso(utc(y, m, 1)) };
    }
    case 'quarter': {
      const [label, q] = key.split(' Q');
      const start = utc(fyYear(label), fyStartMonth - 1 + (Number(q) - 1) * 3, 1);
      return {
        from: iso(start),
        to: iso(utc(start.getUTCFullYear(), start.getUTCMonth() + 3, 1)),
      };
    }
    case 'year':
      return { from: `${key}-01-01`, to: `${Number(key) + 1}-01-01` };
    case 'fiscal_year': {
      const start = utc(fyYear(key), fyStartMonth - 1, 1);
      return { from: iso(start), to: iso(utc(start.getUTCFullYear() + 1, fyStartMonth - 1, 1)) };
    }
  }
}

/** Minutes a time zone is ahead of UTC at `at`. */
function zoneOffsetMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The moment a calendar day (`YYYY-MM-DD`) starts in a time zone. */
export function zonedDayStart(date: string, timezone: string): Date {
  const guess = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  let at = new Date(guess.getTime() - zoneOffsetMinutes(guess, timezone) * 60_000);
  // Around a daylight-saving change the offset at the result can differ; correct once.
  const second = zoneOffsetMinutes(at, timezone);
  at = new Date(guess.getTime() - second * 60_000);
  return at;
}

/**
 * `hours` of working time after `start`: only on working days, within working hours,
 * skipping holidays, in the company's time zone.
 */
export function addWorkingTime(
  start: Date,
  hours: number,
  cal: WorkCalendar,
  timezone: string,
): Date {
  const [sh, sm] = (cal.hours?.start ?? '09:00').split(':').map(Number);
  const [eh, em] = (cal.hours?.end ?? '18:00').split(':').map(Number);
  const weekend = new Set(cal.weekend ?? [0]);
  const holidays = new Set((cal.holidays ?? []).map((h) => h.date));
  let remaining = hours * 3_600_000;
  let day = todayIn(timezone, start);
  for (let i = 0; i < 800 && remaining > 0; i++) {
    const date = iso(day);
    if (!weekend.has(day.getUTCDay()) && !holidays.has(date)) {
      const dayStart = zonedDayStart(date, timezone).getTime();
      const open = dayStart + (sh * 60 + sm) * 60_000;
      const close = dayStart + (eh * 60 + em) * 60_000;
      const from = Math.max(open, start.getTime());
      if (from < close) {
        if (close - from >= remaining) return new Date(from + remaining);
        remaining -= close - from;
      }
    }
    day = addDays(day, 1);
  }
  return new Date(start.getTime() + hours * 3_600_000);
}
