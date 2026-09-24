import { z } from 'zod';
import { FIELD_TYPES } from './types';

/** Input schemas for the config studio API. Cross-item checks live in `validateTenantConfig`. */

export const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const keySchema = z
  .string()
  .regex(KEY_RE, 'Use 2-40 characters: a-z, 0-9 and _, starting with a letter');
const langTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

export const localizedTextSchema = z
  .record(langTag, z.string().trim().max(200))
  .refine(
    (t) => Object.values(t).some((v) => v.length > 0),
    'Enter the text in at least one language',
  )
  .refine((t) => Object.keys(t).length <= 30, 'Too many languages');

const optionalLocalized = localizedTextSchema.optional();

export const fieldDefSchema = z
  .object({
    key: keySchema,
    type: z.enum(FIELD_TYPES),
    label: localizedTextSchema,
    help: optionalLocalized,
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    searchable: z.boolean().optional(),
    archived: z.boolean().optional(),
    locked: z.boolean().optional(),
    default: z.unknown().optional(),
    minLength: z.number().int().min(0).max(10000).optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    pattern: z.string().max(200).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    scale: z.number().int().min(0).max(6).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    picklist: keySchema.optional(),
    target: keySchema.optional(),
    formula: z.string().max(2000).optional(),
    resultType: z.enum(['number', 'text', 'boolean', 'date']).optional(),
    numbering: keySchema.optional(),
    accept: z.array(z.string().max(100)).max(30).optional(),
    maxSizeMb: z.number().min(0.1).max(100).optional(),
  })
  .strict();

export const entityPatchSchema = z
  .object({
    key: keySchema,
    kind: z.enum(['custom', 'system']).optional(),
    label: optionalLocalized,
    pluralLabel: optionalLocalized,
    icon: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    titleField: keySchema.optional(),
    orgScoped: z.boolean().optional(),
    archived: z.boolean().optional(),
    fields: z.array(fieldDefSchema).max(300),
  })
  .strict();

export const picklistSchema = z
  .object({
    key: keySchema,
    label: localizedTextSchema,
    options: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(60),
            label: localizedTextSchema,
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
            active: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export const formLayoutSchema = z
  .object({
    entity: keySchema,
    sections: z
      .array(
        z
          .object({
            key: keySchema,
            label: localizedTextSchema,
            columns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
            fields: z.array(keySchema).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const listViewSchema = z
  .object({
    entity: keySchema,
    columns: z.array(z.string().max(40)).min(1).max(50),
    sort: z.object({ field: z.string().max(40), dir: z.enum(['asc', 'desc']) }).optional(),
    pageSize: z.number().int().min(10).max(200).optional(),
  })
  .strict();

export const numberingSchema = z
  .object({
    key: keySchema,
    label: localizedTextSchema,
    pattern: z.string().min(1).max(60),
    reset: z.enum(['never', 'yearly', 'monthly']),
    scope: z.enum(['company', 'org_unit']),
  })
  .strict();

export const settingsSchema = z
  .object({
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    defaultLanguage: langTag.optional(),
  })
  .strict();

export const configLayerSchema = z.object({
  entities: z.array(entityPatchSchema).max(200),
  picklists: z.array(picklistSchema).max(500),
  forms: z.array(formLayoutSchema).max(200),
  listViews: z.array(listViewSchema).max(200),
  numbering: z.array(numberingSchema).max(200),
  settings: settingsSchema.optional(),
});
