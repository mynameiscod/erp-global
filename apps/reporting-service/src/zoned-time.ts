import type { Frequency } from './models';

/** Wall-clock parts of `date` in `timeZone`. */
function parts(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time in `timeZone`. */
function zonedInstant(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // A second pass settles times near a daylight-saving change.
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

function validZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * The next run strictly after `after`: every day, every week on `weekday` (1 = Monday) or
 * every month on `monthDay` (1–28), at `HH:MM` local time.
 */
export function nextScheduleRun(
  after: Date,
  s: { frequency: Frequency; at: string; weekday?: number; monthDay?: number },
  timeZone: string,
): Date {
  const tz = validZone(timeZone);
  const [hh, mm] = s.at.split(':').map(Number);
  const p = parts(after, tz);
  // Walk forward day by day (at most two months) to the first matching day after `after`.
  for (let i = 0; i < 62; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    const matches =
      s.frequency === 'daily' ||
      (s.frequency === 'weekly' && weekday === (s.weekday ?? 1)) ||
      (s.frequency === 'monthly' && day.getUTCDate() === (s.monthDay ?? 1));
    if (!matches) continue;
    const at = zonedInstant(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hh,
      mm,
      tz,
    );
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error('No next run found');
}
