import { z } from 'zod';
import { INDUSTRY_CODES } from './reference';
import { isPermission } from './permissions';

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

/** A fixed permission key, or a generated record permission such as `records.student.read`. */
const permissionKeySchema = z.string().refine((v) => isPermission(v), 'Unknown permission');

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

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** How people may sign in to a company. The server enforces it; the UI only reflects it. */
export const loginPolicySchema = z.object({
  methods: z.object({
    password: z.boolean(),
    otp: z.boolean(),
    google: z.boolean(),
    microsoft: z.boolean(),
  }),
  /** Email domains allowed for Google/Microsoft sign-in, e.g. acme.in. Empty: any domain, invited users only. */
  ssoDomains: z.array(z.string().trim().toLowerCase().regex(DOMAIN_RE, 'Invalid domain')).max(20),
  /** Personal Microsoft accounts (outlook.com, hotmail.com) in addition to work accounts. */
  allowPersonalMicrosoft: z.boolean(),
  autoJoin: z.object({
    enabled: z.boolean(),
    roleId: objectIdSchema.optional(),
    orgUnitId: objectIdSchema.optional(),
  }),
});
export type LoginPolicy = z.infer<typeof loginPolicySchema>;

export const DEFAULT_LOGIN_POLICY: LoginPolicy = {
  methods: { password: true, otp: false, google: false, microsoft: false },
  ssoDomains: [],
  allowPersonalMicrosoft: true,
  autoJoin: { enabled: false },
};

export const phoneSchema = z
  .string()
  .transform((v) => v.replace(/[\s\-().]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +919876543210'));

export const otpChannelSchema = z.enum(['whatsapp', 'email']);
export type OtpChannel = z.infer<typeof otpChannelSchema>;

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

export const otpLoginRequestSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(1).max(40),
  phone: phoneSchema,
  channel: otpChannelSchema.default('whatsapp'),
});
export const otpVerifySchema = z.object({
  otpToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
});
export const mfaResendSchema = z.object({
  mfaToken: z.string().min(10),
  channel: otpChannelSchema,
});
export const phoneRequestSchema = z.object({ phone: phoneSchema });
/** 2FA by code on WhatsApp or email (the authenticator app keeps using /me/mfa/setup). */
export const mfaMethodSchema = z.object({ method: otpChannelSchema });

/** Values for fields a company added in the config studio; validated against the published config. */
export const customValuesSchema = z.record(z.string().max(40), z.unknown());

export const inviteUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  language: languageSchema.optional(),
  custom: customValuesSchema.optional(),
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
export const adminUpdateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    language: languageSchema,
    timezone: timezoneSchema,
    custom: customValuesSchema,
    /** "Reports to": the user's manager, for manager approvals. */
    managerId: objectIdSchema.nullable(),
  })
  .partial();

/** Out of office: someone else may act on my approvals between these dates. */
export const delegationSchema = z
  .object({
    toUserId: objectIdSchema,
    from: z.string().datetime({ offset: true }),
    until: z.string().datetime({ offset: true }),
    note: z.string().trim().max(200).optional(),
  })
  .refine((d) => new Date(d.until) > new Date(d.from), {
    message: 'The end must be after the start',
    path: ['until'],
  })
  .refine((d) => new Date(d.until).getTime() - new Date(d.from).getTime() <= 366 * 86_400_000, {
    message: 'At most one year',
    path: ['until'],
  });
export type DelegationInput = z.infer<typeof delegationSchema>;

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
  custom: customValuesSchema.optional(),
});
export type CreateOrgUnitInput = z.infer<typeof createOrgUnitSchema>;

export const updateOrgUnitSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(40),
    type: z.string().trim().min(1).max(40),
    custom: customValuesSchema,
    /** The unit's head, for "unit head" approvals. */
    headUserId: objectIdSchema.nullable(),
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

// ---- workflow ----
export const workflowActionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});

export const taskDecisionSchema = z.object({
  taskIds: z.array(objectIdSchema).min(1).max(100),
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(2000).optional(),
});
export type TaskDecisionInput = z.infer<typeof taskDecisionSchema>;

// ---- notifications ----
export const notificationPreferencesSchema = z.object({
  /** `kind:channel` pairs the user turned off, e.g. `approval.requested:email`. */
  disabled: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]{1,59}:(inapp|email|whatsapp|push)$/))
    .max(200),
  /** One daily email of pending approvals instead of one email per request. */
  digest: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
