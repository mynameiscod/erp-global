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

/** Offset of `timeZone` from UTC at `date`, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time in `timeZone`. */
function zonedInstant(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // A second pass settles times near a daylight-saving change.
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/**
 * The next run strictly after `after` for a schedule: every day at `HH:MM` local time,
 * every hour on the hour, or every 15 minutes.
 */
export function nextRun(
  after: Date,
  every: 'day' | 'hour' | '15min',
  at: string | undefined,
  timeZone: string,
): Date {
  const tz = validZone(timeZone);
  if (every === '15min') {
    const step = 15 * 60_000;
    return new Date(Math.floor(after.getTime() / step) * step + step);
  }
  if (every === 'hour') {
    const step = 60 * 60_000;
    // Whole hours are the same in every zone with whole-hour offsets; use local time for the rest.
    const p = parts(after, tz);
    const next = zonedInstant(p.y, p.m, p.d, p.h, 0, tz).getTime() + step;
    return new Date(next <= after.getTime() ? next + step : next);
  }
  const [hh, mm] = (at ?? '09:00').split(':').map(Number);
  const p = parts(after, tz);
  let candidate = zonedInstant(p.y, p.m, p.d, hh, mm, tz);
  if (candidate.getTime() <= after.getTime()) {
    const tomorrow = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    candidate = zonedInstant(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hh,
      mm,
      tz,
    );
  }
  return candidate;
}

function validZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}
