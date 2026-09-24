import { z } from 'zod';
import { INDUSTRY_CODES } from './reference';
import { PERMISSIONS } from './permissions';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(EMAIL_RE, 'Invalid email');

/** At least 10 characters, with a letter and a digit. */
export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a digit');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, '3-40 chars: a-z, 0-9 and hyphens');

export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code');
export const languageSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47 language tag');
export const timezoneSchema = z.string().min(1).max(64);
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

const permissionKeySchema = z.enum(PERMISSIONS.map((p) => p.key) as [string, ...string[]]);

// ---- tenant ----
export const signupSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  slug: slugSchema,
  countryCode: countryCodeSchema,
  industryCode: z.enum(INDUSTRY_CODES),
  defaultLanguage: languageSchema,
  timezone: timezoneSchema,
  admin: z.object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    password: passwordSchema,
  }),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const tenantSettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    defaultLanguage: languageSchema,
    timezone: timezoneSchema,
    requireMfa: z.boolean(),
  })
  .partial();
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

export const tenantStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export const platformCreateTenantSchema = signupSchema.extend({
  placement: z.enum(['shared', 'dedicated']),
});
export type PlatformCreateTenantInput = z.infer<typeof platformCreateTenantSchema>;

// ---- identity ----
export const loginSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(1).max(40),
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaLoginSchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
});
export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const inviteUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  language: languageSchema.optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});

export const passwordResetRequestSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(1).max(40),
  email: emailSchema,
});
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    language: languageSchema,
    timezone: timezoneSchema,
  })
  .partial();

// ---- org ----
export const createOrgUnitSchema = z.object({
  parentId: objectIdSchema,
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).optional(),
  /** Label chosen by the client, e.g. Company, Region, Branch, Campus, Department. */
  type: z.string().trim().min(1).max(40),
});
export type CreateOrgUnitInput = z.infer<typeof createOrgUnitSchema>;

export const updateOrgUnitSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(40),
    type: z.string().trim().min(1).max(40),
  })
  .partial();

export const moveOrgUnitSchema = z.object({ newParentId: objectIdSchema });

// ---- access ----
export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(permissionKeySchema).max(500),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export const updateRoleSchema = createRoleSchema.partial();

export const createAssignmentSchema = z.object({
  userId: objectIdSchema,
  roleId: objectIdSchema,
  orgUnitId: objectIdSchema,
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

// ---- common ----
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
