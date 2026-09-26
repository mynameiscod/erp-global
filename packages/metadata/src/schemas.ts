import { z } from 'zod';
import { dashboardSchema } from './dashboards';
import { printTemplateSchema } from './print';
import { reportSchema } from './reports';
import {
  condition,
  keySchema,
  langTag,
  localizedTextSchema,
  longLocalized,
  objectId,
  optionalLocalized,
} from './schema-base';
import { FIELD_TYPES, TABLE_MAX_ROWS } from './types';

/** Input schemas for the config studio API. Cross-item checks live in `validateTenantConfig`. */

const fieldBaseSchema = z
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
    maxRows: z.number().int().min(1).max(TABLE_MAX_ROWS).optional(),
  })
  .strict();

/** A field, or a table field whose columns are fields themselves (one level deep). */
export const fieldDefSchema = fieldBaseSchema.extend({
  columns: z.array(fieldBaseSchema).min(1).max(30).optional(),
});

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

// ---- Step 4: workflows, rules, automations, message templates ----

const hours = z
  .number()
  .min(0.25)
  .max(24 * 60)
  .optional();

export const approverSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), roleId: objectId }).strict(),
  z.object({ type: z.literal('manager') }).strict(),
  z.object({ type: z.literal('unit_head') }).strict(),
  z.object({ type: z.literal('users'), userIds: z.array(objectId).min(1).max(50) }).strict(),
  z.object({ type: z.literal('field'), field: keySchema }).strict(),
]);

export const workflowSchema = z
  .object({
    entity: keySchema,
    initialState: keySchema,
    active: z.boolean().optional(),
    states: z
      .array(
        z
          .object({
            key: keySchema,
            label: localizedTextSchema,
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
            locked: z.boolean().optional(),
            editableFields: z.array(keySchema).max(300).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(30),
    actions: z
      .array(
        z
          .object({
            key: keySchema,
            label: localizedTextSchema,
            from: z.array(keySchema).min(1).max(30),
            to: keySchema,
            roleIds: z.array(objectId).max(50).optional(),
            requesterOnly: z.boolean().optional(),
            condition,
            commentRequired: z.boolean().optional(),
            approval: z
              .object({
                approvedState: keySchema,
                rejectedState: keySchema,
                levels: z
                  .array(
                    z
                      .object({
                        key: keySchema,
                        label: localizedTextSchema,
                        condition,
                        approvers: z.array(approverSchema).min(1).max(20),
                        mode: z.enum(['all', 'any']),
                        remindAfterHours: hours,
                        escalateAfterHours: hours,
                        escalateTo: z.array(approverSchema).max(20).optional(),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(10),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const ruleSchema = z
  .object({
    key: keySchema,
    entity: keySchema,
    label: optionalLocalized,
    on: z.enum(['create', 'update', 'save']),
    condition,
    effect: z.enum(['block', 'set', 'require', 'hide', 'readonly']),
    field: keySchema.optional(),
    value: z.string().trim().max(2000).optional(),
    message: optionalLocalized,
    active: z.boolean().optional(),
  })
  .strict();

const assignmentsSchema = z
  .array(z.object({ field: keySchema, value: z.string().trim().min(1).max(2000) }).strict())
  .max(100);

const recipientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('creator') }).strict(),
  z.object({ type: z.literal('manager') }).strict(),
  z.object({ type: z.literal('field'), field: keySchema }).strict(),
  z.object({ type: z.literal('role'), roleId: objectId }).strict(),
  z.object({ type: z.literal('users'), userIds: z.array(objectId).min(1).max(50) }).strict(),
]);

export const automationSchema = z
  .object({
    key: keySchema,
    entity: keySchema,
    label: localizedTextSchema,
    active: z.boolean().optional(),
    condition,
    trigger: z.discriminatedUnion('type', [
      z.object({ type: z.literal('created') }).strict(),
      z.object({ type: z.literal('updated') }).strict(),
      z.object({ type: z.literal('deleted') }).strict(),
      z.object({ type: z.literal('field_changed'), field: keySchema }).strict(),
      z.object({ type: z.literal('status_changed'), to: keySchema.optional() }).strict(),
      z
        .object({
          type: z.literal('schedule'),
          every: z.enum(['day', 'hour', '15min']),
          at: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
            .optional(),
        })
        .strict(),
    ]),
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              type: z.literal('notify'),
              template: z.string().regex(/^[a-z][a-z0-9_.]{1,59}$/),
              recipients: z.array(recipientSchema).min(1).max(20),
              channels: z.array(z.enum(['inapp', 'email', 'whatsapp', 'push'])).min(1),
            })
            .strict(),
          z.object({ type: z.literal('update'), set: assignmentsSchema.min(1) }).strict(),
          z
            .object({
              type: z.literal('create'),
              entity: keySchema,
              orgUnit: z.enum(['same', 'none']).optional(),
              set: assignmentsSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal('webhook'),
              url: z
                .string()
                .url()
                .max(500)
                .refine(
                  // http:// only for a receiver on this machine (development and tests);
                  // at run time private addresses are refused unless explicitly allowed.
                  (u) =>
                    u.startsWith('https://') ||
                    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u),
                  'Webhooks must use https://',
                ),
            })
            .strict(),
          z.object({ type: z.literal('workflow_action'), action: keySchema }).strict(),
        ]),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const messageTemplateSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_.]{1,59}$/, 'Use a-z, 0-9, _ and .'),
    label: localizedTextSchema,
    title: localizedTextSchema,
    body: longLocalized,
    whatsapp: z
      .object({
        template: z.string().regex(/^[a-z0-9_]{1,512}$/),
        params: z.array(z.string().max(100)).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export const configLayerSchema = z.object({
  entities: z.array(entityPatchSchema).max(200),
  picklists: z.array(picklistSchema).max(500),
  forms: z.array(formLayoutSchema).max(200),
  listViews: z.array(listViewSchema).max(200),
  numbering: z.array(numberingSchema).max(200),
  workflows: z.array(workflowSchema).max(200).default([]),
  rules: z.array(ruleSchema).max(1000).default([]),
  automations: z.array(automationSchema).max(500).default([]),
  templates: z.array(messageTemplateSchema).max(500).default([]),
  printTemplates: z.array(printTemplateSchema).max(200).default([]),
  reports: z.array(reportSchema).max(500).default([]),
  dashboards: z.array(dashboardSchema).max(100).default([]),
  settings: settingsSchema.optional(),
});
