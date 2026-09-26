import { z } from 'zod';

/** Schema building blocks shared by every config schema. */

export const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const keySchema = z
  .string()
  .regex(KEY_RE, 'Use 2-40 characters: a-z, 0-9 and _, starting with a letter');
export const langTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

export const localizedTextSchema = z
  .record(langTag, z.string().trim().max(200))
  .refine(
    (t) => Object.values(t).some((v) => v.length > 0),
    'Enter the text in at least one language',
  )
  .refine((t) => Object.keys(t).length <= 30, 'Too many languages');

export const optionalLocalized = localizedTextSchema.optional();

/** Longer text in several languages (message bodies, print text blocks). */
export const longLocalized = z
  .record(langTag, z.string().max(4000))
  .refine(
    (t) => Object.values(t).some((v) => v.trim().length > 0),
    'Enter the text in at least one language',
  );

export const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');
export const condition = z.string().trim().max(2000).optional();
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f6feb');
export const fileId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid file');
