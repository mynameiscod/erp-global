import { z } from 'zod';
import { keySchema, localizedTextSchema } from './schema-base';
import type { LocalizedText } from './types';

/**
 * Identifier types (tax numbers, registration numbers, postal codes) come from Country
 * Packs as data: a pattern and, optionally, a named check-digit algorithm. Text fields
 * point at one with `identifier`.
 */

/** Check-digit algorithms. They are generic; which identifiers use them is pack data. */
export const CHECKSUMS = ['luhn', 'luhn_mod36', 'verhoeff', 'mod11'] as const;
export type Checksum = (typeof CHECKSUMS)[number];

export interface IdentifierType {
  key: string;
  label: LocalizedText;
  /** Regular expression the whole value must match (after upper-casing, if set). */
  pattern: string;
  checksum?: Checksum;
  uppercase?: boolean;
  example?: string;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Luhn over base 36: every second value doubled, digits of the product summed in base 36. */
function luhnMod36(value: string): boolean {
  const body = value.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const code = ALNUM.indexOf(body[i]);
    if (code < 0) return false;
    const product = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return ALNUM[check] === value[value.length - 1];
}

function luhn(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let d = Number(value[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeff(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  let c = 0;
  const digits = value.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
  return c === 0;
}

/** Weighted mod 11 (weights 2, 3, 4… from the right, check digit 10 written as X). */
function mod11(value: string): boolean {
  const body = value.slice(0, -1);
  if (!/^\d+$/.test(body)) return false;
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i + 2);
  const check = (11 - (sum % 11)) % 11;
  const last = value[value.length - 1].toUpperCase();
  return check === 10 ? last === 'X' : last === String(check);
}

const ALGORITHMS: Record<Checksum, (v: string) => boolean> = {
  luhn,
  luhn_mod36: luhnMod36,
  verhoeff,
  mod11,
};

/** The value to store (trimmed, upper-cased if the type says so), or an error message. */
export function checkIdentifier(
  t: IdentifierType,
  raw: string,
): { value: string } | { error: string } {
  const value = t.uppercase ? raw.trim().toUpperCase() : raw.trim();
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${t.pattern})$`);
  } catch {
    return { value };
  }
  const name = t.label.en ?? Object.values(t.label)[0] ?? t.key;
  if (!re.test(value))
    return { error: `Not a valid ${name}${t.example ? `, e.g. ${t.example}` : ''}` };
  if (t.checksum && !ALGORITHMS[t.checksum](value))
    return { error: `${name} check digit does not match` };
  return { value };
}

export const identifierTypeSchema = z
  .object({
    key: keySchema,
    label: localizedTextSchema,
    pattern: z.string().min(1).max(200),
    checksum: z.enum(CHECKSUMS).optional(),
    uppercase: z.boolean().optional(),
    example: z.string().max(60).optional(),
  })
  .strict();

// ---- working calendar ----

/** Working days and holidays, for timers that count working hours only. */
export interface WorkCalendar {
  /** Days off each week: 0 = Sunday … 6 = Saturday. */
  weekend?: number[];
  /** Working hours, e.g. 09:00–18:00. */
  hours?: { start: string; end: string };
  holidays?: { date: string; label: LocalizedText }[];
  /** Approval reminders and escalations count working hours only. */
  workingHoursOnly?: boolean;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const workCalendarSchema = z
  .object({
    weekend: z.array(z.number().int().min(0).max(6)).max(6).optional(),
    hours: z.object({ start: hhmm, end: hhmm }).strict().optional(),
    holidays: z
      .array(z.object({ date: z.string().date(), label: localizedTextSchema }).strict())
      .max(400)
      .optional(),
    workingHoursOnly: z.boolean().optional(),
  })
  .strict();

/** Later layers override the week and hours; holidays add up (one per date). */
export function mergeCalendars(list: (WorkCalendar | undefined)[]): WorkCalendar | undefined {
  const present = list.filter((c): c is WorkCalendar => !!c);
  if (!present.length) return undefined;
  const holidays = new Map<string, { date: string; label: LocalizedText }>();
  let out: WorkCalendar = {};
  for (const c of present) {
    for (const h of c.holidays ?? []) holidays.set(h.date, h);
    out = { ...out, ...c };
  }
  return { ...out, holidays: [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
