import { Schema, type Types } from 'mongoose';
import type { PermissionKey } from '@erp/contracts';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export type UserStatus = 'invited' | 'active' | 'deactivated';
export type MfaMethod = 'totp' | 'whatsapp' | 'email';

export interface User {
  _id: Types.ObjectId;
  tenantId: string;
  email: string;
  name: string;
  passwordHash?: string;
  status: UserStatus;
  language: string;
  timezone: string;
  /** Verified mobile number in E.164 (+919876543210). Only set once verified. */
  phone?: string;
  mfa: {
    enabled: boolean;
    /** Missing on users from before Step 3, which means an authenticator app. */
    method?: MfaMethod;
    secretEnc?: string;
    pendingSecretEnc?: string;
  };
  /** Only for users of the platform tenant (Super Admins). */
  platformPermissions: PermissionKey[];
  /** Values of custom fields added in the config studio. */
  custom: Record<string, unknown>;
  failedLogins: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<User>(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    passwordHash: String,
    status: { type: String, enum: ['invited', 'active', 'deactivated'], required: true },
    language: { type: String, default: 'en' },
    timezone: { type: String, default: 'UTC' },
    phone: String,
    mfa: {
      enabled: { type: Boolean, default: false },
      method: { type: String, enum: ['totp', 'whatsapp', 'email'] },
      secretEnc: String,
      pendingSecretEnc: String,
    },
    platformPermissions: { type: [String], default: [] },
    custom: { type: Schema.Types.Mixed, default: {} },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { collection: 'users', timestamps: true, versionKey: false, minimize: false },
);
userSchema.plugin(tenantPlugin);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index(
  { tenantId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);

export const UserModel: ModelDef<User> = { name: 'User', schema: userSchema };

export function toUserDto(u: User) {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    status: u.status,
    language: u.language,
    timezone: u.timezone,
    mfaEnabled: u.mfa?.enabled ?? false,
    mfaMethod: u.mfa?.enabled ? (u.mfa.method ?? 'totp') : null,
    phone: u.phone ?? null,
    hasPassword: !!u.passwordHash,
    custom: u.custom ?? {},
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
  };
}

/** A login session. The refresh token rotates on every use; reuse of an old one revokes the session. */
export interface Session {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  tokenHash: string;
  previousHashes: string[];
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
  lastUsedAt: Date;
  createdAt: Date;
}

const sessionSchema = new Schema<Session>(
  {
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    previousHashes: { type: [String], default: [] },
    userAgent: String,
    ip: String,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'sessions', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
sessionSchema.plugin(tenantPlugin);
sessionSchema.index({ tenantId: 1, userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel: ModelDef<Session> = { name: 'Session', schema: sessionSchema };

export type OneTimePurpose = 'invite' | 'reset' | 'mfa_login';

/** Invite, password-reset and MFA-login tokens. Only a hash is stored. */
export interface OneTimeToken {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  purpose: OneTimePurpose;
  tokenHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt?: Date;
}

const ottSchema = new Schema<OneTimeToken>(
  {
    userId: { type: String, required: true },
    purpose: { type: String, enum: ['invite', 'reset', 'mfa_login'], required: true },
    tokenHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { collection: 'one_time_tokens', versionKey: false },
);
ottSchema.plugin(tenantPlugin);
ottSchema.index({ tenantId: 1, tokenHash: 1 }, { unique: true });
ottSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OneTimeTokenModel: ModelDef<OneTimeToken> = {
  name: 'OneTimeToken',
  schema: ottSchema,
};

export type OtpPurpose = 'login' | 'mfa' | 'mfa_manage' | 'phone_verify';

/**
 * A one-time code sent on WhatsApp or by email. Only an HMAC of the code is stored.
 * `rateKey` groups requests for rate limits (a phone number or a user).
 */
export interface OtpChallenge {
  _id: Types.ObjectId;
  tenantId: string;
  purpose: OtpPurpose;
  /** Missing for the decoy challenge of an unknown number, which can never succeed. */
  userId?: string;
  channel: 'whatsapp' | 'email';
  /** Phone number or email the code went to. */
  target: string;
  rateKey: string;
  /** Looks the challenge up from a public endpoint (`otpToken`). */
  tokenHash?: string;
  /** For `mfa_manage`: the 2FA method being turned on. */
  method?: MfaMethod;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

const otpSchema = new Schema<OtpChallenge>(
  {
    purpose: {
      type: String,
      enum: ['login', 'mfa', 'mfa_manage', 'phone_verify'],
      required: true,
    },
    userId: String,
    channel: { type: String, enum: ['whatsapp', 'email'], required: true },
    target: { type: String, required: true },
    rateKey: { type: String, required: true },
    tokenHash: String,
    method: { type: String, enum: ['totp', 'whatsapp', 'email'] },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  {
    collection: 'otp_challenges',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);
otpSchema.plugin(tenantPlugin);
otpSchema.index({ tenantId: 1, rateKey: 1, createdAt: -1 });
otpSchema.index({ tenantId: 1, userId: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ tenantId: 1, tokenHash: 1 }, { sparse: true });
// Kept for an hour after creation so the hourly rate limit can count them.
otpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

export const OtpChallengeModel: ModelDef<OtpChallenge> = {
  name: 'OtpChallenge',
  schema: otpSchema,
};

export type SsoProvider = 'google' | 'microsoft';

/** A Google or Microsoft account linked to a user of one company. */
export interface LinkedAccount {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  provider: SsoProvider;
  /** The provider's stable subject id for this person. */
  subject: string;
  email?: string;
  lastUsedAt?: Date;
  createdAt: Date;
}

const linkedSchema = new Schema<LinkedAccount>(
  {
    userId: { type: String, required: true },
    provider: { type: String, enum: ['google', 'microsoft'], required: true },
    subject: { type: String, required: true },
    email: String,
    lastUsedAt: Date,
  },
  {
    collection: 'linked_accounts',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);
linkedSchema.plugin(tenantPlugin);
linkedSchema.index({ tenantId: 1, provider: 1, subject: 1 }, { unique: true });
linkedSchema.index({ tenantId: 1, userId: 1 });

export const LinkedAccountModel: ModelDef<LinkedAccount> = {
  name: 'LinkedAccount',
  schema: linkedSchema,
};

/** Browser round trip to Google/Microsoft: PKCE verifier, nonce and what to do on return. */
export interface SsoState {
  _id: Types.ObjectId;
  tenantId: string;
  provider: SsoProvider;
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  /** Set when a signed-in user links an account from the account page. */
  linkUserId?: string;
  expiresAt: Date;
  usedAt?: Date;
}

const ssoStateSchema = new Schema<SsoState>(
  {
    provider: { type: String, enum: ['google', 'microsoft'], required: true },
    stateHash: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    nonce: { type: String, required: true },
    linkUserId: String,
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { collection: 'sso_states', versionKey: false },
);
ssoStateSchema.plugin(tenantPlugin);
ssoStateSchema.index({ tenantId: 1, stateHash: 1 }, { unique: true });
ssoStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SsoStateModel: ModelDef<SsoState> = { name: 'SsoState', schema: ssoStateSchema };
