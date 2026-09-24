import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { Types, type Connection } from 'mongoose';
import { signAccessToken } from '@erp/auth';
import {
  EventTypes,
  NotifyTypes,
  PLATFORM_TENANT_ID,
  type AclEntry,
  type EmailRequestedPayload,
  type LoginInput,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, TENANT_DATABASES, UpstreamError } from '@erp/service-kit';
import { requireContext, runAsTenant, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, IDENTITY_ENV, type Clients, type IdentityEnv } from './config';
import {
  composeToken,
  decrypt,
  encrypt,
  hashPassword,
  randomToken,
  safeEqual,
  sha256,
  splitToken,
  verifyPassword,
} from './crypto';
import {
  OneTimeTokenModel,
  SessionModel,
  toUserDto,
  UserModel,
  type OneTimePurpose,
  type User,
} from './models';

authenticator.options = { window: 1 };

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MFA_LOGIN_TTL_MS = 5 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** Two tabs refreshing at once is normal; reusing an old token later is treated as theft. */
const REFRESH_REUSE_GRACE_MS = 30_000;

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface TenantInfo {
  id: string;
  name?: string;
  status: string;
  requireMfa: boolean;
  defaultLanguage: string;
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ReturnType<typeof toUserDto> & { tenantId: string };
  mfaSetupRequired: boolean;
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
const invalidSession = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again.');

@Injectable()
export class AuthService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
  ) {}

  users() {
    return this.dbs.model(UserModel);
  }
  sessions() {
    return this.dbs.model(SessionModel);
  }
  tokens() {
    return this.dbs.model(OneTimeTokenModel);
  }

  // ---- tenants ----

  async tenantBySlug(slug: string): Promise<TenantInfo | undefined> {
    if (slug === PLATFORM_TENANT_ID) {
      return {
        id: PLATFORM_TENANT_ID,
        name: 'Platform',
        status: 'active',
        requireMfa: false,
        defaultLanguage: 'en',
      };
    }
    try {
      return await this.clients.tenant.get<TenantInfo>(
        `/internal/tenants/by-slug/${encodeURIComponent(slug)}`,
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return undefined;
      throw e;
    }
  }

  async tenantById(id: string): Promise<TenantInfo> {
    if (id === PLATFORM_TENANT_ID) {
      return { id, name: 'Platform', status: 'active', requireMfa: false, defaultLanguage: 'en' };
    }
    return this.clients.tenant.get<TenantInfo>(`/internal/tenants/${id}`, { tenantId: id });
  }

  private assertTenantUsable(t: TenantInfo): void {
    if (t.status === 'suspended') {
      throw new AppError(
        403,
        'TENANT_SUSPENDED',
        'This company account is suspended. Contact support.',
      );
    }
    if (t.status !== 'active') throw invalidCredentials();
  }

  // ---- login ----

  async login(
    input: LoginInput,
    meta: ClientMeta,
  ): Promise<SessionResult | { mfaRequired: true; mfaToken: string }> {
    const tenant = await this.tenantBySlug(input.tenantSlug);
    if (!tenant) {
      await verifyPassword(undefined, input.password);
      throw invalidCredentials();
    }
    this.assertTenantUsable(tenant);

    return runAsTenant(tenant.id, { type: 'system', id: 'identity-service' }, async () => {
      const Users = await this.users();
      const user = await Users.findOne({ email: input.email }).lean();
      const ok = await verifyPassword(user?.passwordHash, input.password);
      const ctx = requireContext();

      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new AppError(
          429,
          'ACCOUNT_LOCKED',
          `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`,
        );
      }
      if (!user || !ok || user.status !== 'active') {
        if (user) ctx.actor = { type: 'user', id: String(user._id) };
        await this.recordFailedLogin(
          user,
          input.email,
          !user ? 'unknown_user' : !ok ? 'bad_password' : `status_${user.status}`,
        );
        throw invalidCredentials();
      }
      ctx.actor = { type: 'user', id: String(user._id) };

      if (user.mfa?.enabled) {
        const mfaToken = await this.createOneTimeToken(
          String(user._id),
          'mfa_login',
          MFA_LOGIN_TTL_MS,
        );
        return { mfaRequired: true as const, mfaToken };
      }
      return this.completeLogin(user, tenant, meta, 'password');
    });
  }

  async loginWithMfa(mfaToken: string, code: string, meta: ClientMeta): Promise<SessionResult> {
    const parts = splitToken(mfaToken);
    if (!parts) throw invalidSession();
    const tenant = await this.tenantById(parts.tenantId).catch(() => undefined);
    if (!tenant) throw invalidSession();
    this.assertTenantUsable(tenant);

    return runAsTenant(parts.tenantId, { type: 'system', id: 'identity-service' }, async () => {
      const Tokens = await this.tokens();
      const ott = await Tokens.findOneAndUpdate(
        {
          tokenHash: sha256(parts.secret),
          purpose: 'mfa_login',
          usedAt: null,
          expiresAt: { $gt: new Date() },
          attempts: { $lt: 5 },
        },
        { $inc: { attempts: 1 } },
        { new: true },
      ).lean();
      if (!ott) throw invalidSession();
      const user = await (await this.users()).findById(ott.userId).lean();
      if (!user || user.status !== 'active' || !user.mfa?.secretEnc) throw invalidSession();
      requireContext().actor = { type: 'user', id: String(user._id) };

      if (!authenticator.check(code, decrypt(user.mfa.secretEnc, this.env.DATA_ENC_KEY))) {
        await this.recordFailedLogin(user, user.email, 'bad_mfa_code');
        throw new AppError(401, 'INVALID_MFA_CODE', 'The code is not correct');
      }
      await Tokens.updateOne({ _id: ott._id }, { $set: { usedAt: new Date() } });
      return this.completeLogin(user, tenant, meta, 'password+totp');
    });
  }

  private async recordFailedLogin(user: User | null, email: string, reason: string): Promise<void> {
    const Users = await this.users();
    await this.conn.transaction(async (session) => {
      if (user) {
        const failed = (user.failedLogins ?? 0) + 1;
        const set: Record<string, unknown> = { failedLogins: failed };
        if (failed >= MAX_FAILED_LOGINS)
          set.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        await Users.updateOne({ _id: user._id }, { $set: set }, { session });
      }
      await this.outbox.record(
        EventTypes.LoginFailed,
        { email, reason, userId: user ? String(user._id) : null },
        { session },
      );
    });
  }

  private async completeLogin(
    user: User,
    tenant: TenantInfo,
    meta: ClientMeta,
    method: string,
  ): Promise<SessionResult> {
    const result = await this.issueSession(user, tenant, meta);
    const Users = await this.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne(
        { _id: user._id },
        { $set: { failedLogins: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: '' } },
        { session },
      );
      await this.outbox.record(
        EventTypes.LoginSucceeded,
        { userId: String(user._id), method, ip: meta.ip ?? null },
        { session },
      );
    });
    return result;
  }

  // ---- sessions ----

  private async issueSession(
    user: User,
    tenant: TenantInfo,
    meta: ClientMeta,
  ): Promise<SessionResult> {
    const Sessions = await this.sessions();
    const sid = new Types.ObjectId();
    const secret = randomToken();
    await Sessions.create({
      _id: sid,
      userId: String(user._id),
      tokenHash: sha256(secret),
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
      expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });
    return {
      accessToken: await this.accessToken(user, tenant.id, String(sid)),
      refreshToken: composeToken(tenant.id, `${String(sid)}.${secret}`),
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      user: { ...toUserDto(user), tenantId: tenant.id },
      mfaSetupRequired: tenant.requireMfa && !user.mfa?.enabled,
    };
  }

  private async accessToken(user: User, tenantId: string, sid: string): Promise<string> {
    const platform = tenantId === PLATFORM_TENANT_ID;
    const acl = platform
      ? []
      : await this.clients.access.get<AclEntry[]>(
          `/internal/access/users/${String(user._id)}/acl`,
          { tenantId },
        );
    return signAccessToken(
      {
        sub: String(user._id),
        tid: tenantId,
        sid,
        acl,
        ...(platform && { plat: user.platformPermissions }),
      },
      this.env.JWT_PRIVATE_KEY,
      this.env.ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  async refresh(refreshToken: string | undefined, meta: ClientMeta): Promise<SessionResult> {
    const parts = refreshToken ? splitToken(refreshToken) : undefined;
    const [sid, secret] = parts?.secret.split('.') ?? [];
    if (!parts || !sid || !secret || !Types.ObjectId.isValid(sid)) throw invalidSession();

    return runAsTenant(parts.tenantId, { type: 'system', id: 'identity-service' }, async () => {
      const Sessions = await this.sessions();
      const s = await Sessions.findById(sid).lean();
      if (!s || s.revokedAt || s.expiresAt < new Date()) throw invalidSession();
      const hash = sha256(secret);
      if (!safeEqual(hash, s.tokenHash)) {
        const recent =
          s.previousHashes.at(-1) === hash &&
          Date.now() - s.lastUsedAt.getTime() < REFRESH_REUSE_GRACE_MS;
        if (s.previousHashes.includes(hash) && !recent) {
          await Sessions.updateOne(
            { _id: s._id },
            { $set: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' } },
          );
        }
        throw invalidSession();
      }

      const tenant = await this.tenantById(parts.tenantId);
      this.assertTenantUsable(tenant);
      const user = await (await this.users()).findById(s.userId).lean();
      if (!user || user.status !== 'active') throw invalidSession();
      requireContext().actor = { type: 'user', id: s.userId };

      const next = randomToken();
      const rotated = await Sessions.updateOne(
        { _id: s._id, tokenHash: hash, revokedAt: null },
        {
          $set: { tokenHash: sha256(next), lastUsedAt: new Date(), ip: meta.ip },
          $push: { previousHashes: { $each: [hash], $slice: -10 } },
        },
      );
      if (rotated.modifiedCount !== 1) throw invalidSession();
      return {
        accessToken: await this.accessToken(user, tenant.id, sid),
        refreshToken: composeToken(tenant.id, `${sid}.${next}`),
        expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
        user: { ...toUserDto(user), tenantId: tenant.id },
        mfaSetupRequired: tenant.requireMfa && !user.mfa?.enabled,
      };
    });
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const parts = refreshToken ? splitToken(refreshToken) : undefined;
    const [sid] = parts?.secret.split('.') ?? [];
    if (!parts || !sid || !Types.ObjectId.isValid(sid)) return;
    await runAsTenant(parts.tenantId, { type: 'system', id: 'identity-service' }, async () => {
      await (
        await this.sessions()
      ).updateOne(
        { _id: sid, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
      );
    });
  }

  async revokeUserSessions(userId: string, reason: string, exceptSid?: string): Promise<void> {
    const filter: Record<string, unknown> = { userId, revokedAt: null };
    if (exceptSid) filter._id = { $ne: exceptSid };
    await (
      await this.sessions()
    ).updateMany(filter, { $set: { revokedAt: new Date(), revokedReason: reason } });
  }

  // ---- one-time tokens ----

  async createOneTimeToken(
    userId: string,
    purpose: OneTimePurpose,
    ttlMs: number,
  ): Promise<string> {
    const Tokens = await this.tokens();
    await Tokens.updateMany({ userId, purpose, usedAt: null }, { $set: { usedAt: new Date() } });
    const secret = randomToken();
    await Tokens.create({
      userId,
      purpose,
      tokenHash: sha256(secret),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return composeToken(requireContext().tenantId!, secret);
  }

  /** Looks up a token in its tenant and runs `fn` there. Throws if invalid, used or expired. */
  async withOneTimeToken<T>(
    token: string,
    purpose: OneTimePurpose,
    fn: (userId: string, tokenId: Types.ObjectId) => Promise<T>,
  ): Promise<T> {
    const parts = splitToken(token);
    const invalid = () => new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    if (!parts) throw invalid();
    return runAsTenant(parts.tenantId, { type: 'system', id: 'identity-service' }, async () => {
      const ott = await (
        await this.tokens()
      )
        .findOne({
          tokenHash: sha256(parts.secret),
          purpose,
          usedAt: null,
          expiresAt: { $gt: new Date() },
        })
        .lean();
      if (!ott) throw invalid();
      requireContext().actor = { type: 'user', id: ott.userId };
      return fn(ott.userId, ott._id);
    });
  }

  // ---- password flows ----

  async forgotPassword(tenantSlug: string, email: string): Promise<void> {
    const tenant = await this.tenantBySlug(tenantSlug);
    if (!tenant || tenant.status !== 'active') return;
    await runAsTenant(tenant.id, { type: 'system', id: 'identity-service' }, async () => {
      const user = await (await this.users()).findOne({ email, status: 'active' }).lean();
      if (!user) return;
      requireContext().actor = { type: 'user', id: String(user._id) };
      const token = await this.createOneTimeToken(String(user._id), 'reset', RESET_TTL_MS);
      await this.conn.transaction(async (session) => {
        await this.outbox.record(
          EventTypes.PasswordResetRequested,
          { userId: String(user._id) },
          { session },
        );
        await this.outbox.record<EmailRequestedPayload>(
          NotifyTypes.EmailRequested,
          {
            to: user.email,
            template: 'password.reset',
            locale: user.language,
            vars: {
              name: user.name,
              link: `${this.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
            },
          },
          { session },
        );
      });
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await this.withOneTimeToken(token, 'reset', async (userId, tokenId) => {
      const [Users, Tokens] = await Promise.all([this.users(), this.tokens()]);
      const passwordHash = await hashPassword(password);
      await this.conn.transaction(async (session) => {
        await Users.updateOne(
          { _id: userId },
          {
            $set: { passwordHash, passwordChangedAt: new Date(), failedLogins: 0 },
            $unset: { lockedUntil: '' },
          },
          { session },
        );
        await Tokens.updateOne({ _id: tokenId }, { $set: { usedAt: new Date() } }, { session });
        await this.outbox.record(EventTypes.PasswordChanged, { userId, via: 'reset' }, { session });
      });
      await this.revokeUserSessions(userId, 'password_reset');
    });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const ctx = requireContext();
    const Users = await this.users();
    const user = await Users.findById(ctx.actor!.id).lean();
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.conn.transaction(async (session) => {
      await Users.updateOne(
        { _id: user._id },
        { $set: { passwordHash, passwordChangedAt: new Date() } },
        { session },
      );
      await this.outbox.record(
        EventTypes.PasswordChanged,
        { userId: String(user._id), via: 'self' },
        { session },
      );
    });
    await this.revokeUserSessions(String(user._id), 'password_changed', ctx.sessionId);
  }

  // ---- MFA ----

  async mfaSetup() {
    const ctx = requireContext();
    const Users = await this.users();
    const user = await Users.findById(ctx.actor!.id).lean();
    if (!user) throw AppError.notFound('User');
    if (user.mfa?.enabled) throw AppError.conflict('Two-factor authentication is already on');
    const secret = authenticator.generateSecret();
    await Users.updateOne(
      { _id: user._id },
      { $set: { 'mfa.pendingSecretEnc': encrypt(secret, this.env.DATA_ENC_KEY) } },
    );
    const tenant = await this.tenantById(ctx.tenantId!).catch(() => undefined);
    const otpauthUrl = authenticator.keyuri(
      user.email,
      `global-erp${tenant?.name ? ` (${tenant.name})` : ''}`,
      secret,
    );
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  async mfaEnable(code: string) {
    const ctx = requireContext();
    const Users = await this.users();
    const user = await Users.findById(ctx.actor!.id).lean();
    if (!user?.mfa?.pendingSecretEnc) throw AppError.badRequest('Start two-factor setup first');
    if (!authenticator.check(code, decrypt(user.mfa.pendingSecretEnc, this.env.DATA_ENC_KEY))) {
      throw new AppError(400, 'INVALID_MFA_CODE', 'The code is not correct');
    }
    await this.conn.transaction(async (session) => {
      await Users.updateOne(
        { _id: user._id },
        {
          $set: { 'mfa.enabled': true, 'mfa.secretEnc': user.mfa.pendingSecretEnc },
          $unset: { 'mfa.pendingSecretEnc': '' },
        },
        { session },
      );
      await this.outbox.record(
        EventTypes.MfaEnabled,
        { userId: String(user._id), method: 'totp' },
        { session },
      );
    });
    return { mfaEnabled: true };
  }

  async mfaDisable(code: string) {
    const ctx = requireContext();
    const tenant = await this.tenantById(ctx.tenantId!);
    if (tenant.requireMfa)
      throw AppError.forbidden('Your company requires two-factor authentication');
    const Users = await this.users();
    const user = await Users.findById(ctx.actor!.id).lean();
    if (!user?.mfa?.enabled || !user.mfa.secretEnc)
      throw AppError.badRequest('Two-factor authentication is not on');
    if (!authenticator.check(code, decrypt(user.mfa.secretEnc, this.env.DATA_ENC_KEY))) {
      throw new AppError(400, 'INVALID_MFA_CODE', 'The code is not correct');
    }
    await this.conn.transaction(async (session) => {
      await Users.updateOne(
        { _id: user._id },
        { $set: { 'mfa.enabled': false }, $unset: { 'mfa.secretEnc': '' } },
        { session },
      );
      await this.outbox.record(EventTypes.MfaDisabled, { userId: String(user._id) }, { session });
    });
    return { mfaEnabled: false };
  }
}
