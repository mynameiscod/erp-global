import { Schema, type Types } from 'mongoose';
import type { PermissionKey } from '@erp/contracts';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export type UserStatus = 'invited' | 'active' | 'deactivated';

export interface User {
  _id: Types.ObjectId;
  tenantId: string;
  email: string;
  name: string;
  passwordHash?: string;
  status: UserStatus;
  language: string;
  timezone: string;
  mfa: { enabled: boolean; secretEnc?: string; pendingSecretEnc?: string };
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
    mfa: {
      enabled: { type: Boolean, default: false },
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
