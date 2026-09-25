import { Inject, Injectable } from '@nestjs/common';
import { createHash, createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { PinoLogger } from 'nestjs-pino';
import { Types, type Connection } from 'mongoose';
import { EventTypes } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, TENANT_DATABASES } from '@erp/service-kit';
import { requireContext, runAsTenant, type TenantDatabases } from '@erp/tenancy';
import {
  AuthService,
  policyOf,
  type ClientMeta,
  type MfaChallengeResult,
  type SessionResult,
  type TenantInfo,
} from './auth.service';
import { CLIENTS, IDENTITY_ENV, type Clients, type IdentityEnv } from './config';
import { composeToken, randomToken, sha256, splitToken } from './crypto';
import {
  LinkedAccountModel,
  SsoStateModel,
  type LinkedAccount,
  type SsoProvider,
  type User,
} from './models';

export const SSO_PROVIDERS: readonly SsoProvider[] = ['google', 'microsoft'];
const STATE_TTL_MS = 10 * 60_000;
/** Microsoft's tenant id for personal accounts (outlook.com, hotmail.com, live.com). */
export const MS_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** A refusal shown to the user on the /sso/complete page, by code. */
export class SsoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type SsoOutcome =
  | { kind: 'session'; session: SessionResult }
  | { kind: 'mfa'; mfa: MfaChallengeResult }
  | { kind: 'linked'; provider: SsoProvider };

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Claims extends JwtPayload {
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
  tid?: string;
  xms_edov?: boolean;
  preferred_username?: string;
}

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;
const base64url = (b: Buffer) => b.toString('base64url');

/**
 * Google and Microsoft sign-in with OpenID Connect: Authorization Code + PKCE, with state
 * and nonce, and the ID token verified against the provider's published keys.
 */
@Injectable()
export class SsoService {
  private readonly discoveries = new Map<SsoProvider, { doc: Discovery; at: number }>();
  private readonly jwks = new Map<string, { keys: Map<string, KeyObject>; at: number }>();

  constructor(
    private readonly auth: AuthService,
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
    private readonly log: PinoLogger,
  ) {}

  linked() {
    return this.dbs.model(LinkedAccountModel);
  }
  states() {
    return this.dbs.model(SsoStateModel);
  }

  private settings(provider: SsoProvider) {
    const e = this.env;
    const s =
      provider === 'google'
        ? { id: e.GOOGLE_CLIENT_ID, secret: e.GOOGLE_CLIENT_SECRET, issuer: e.GOOGLE_ISSUER }
        : {
            id: e.MICROSOFT_CLIENT_ID,
            secret: e.MICROSOFT_CLIENT_SECRET,
            issuer: e.MICROSOFT_ISSUER,
          };
    if (!s.id || !s.secret) throw new SsoError('not_configured');
    return { clientId: s.id, clientSecret: s.secret, issuer: s.issuer.replace(/\/$/, '') };
  }

  callbackUrl(provider: SsoProvider): string {
    const base = (this.env.SSO_CALLBACK_BASE_URL ?? this.env.APP_URL).replace(/\/$/, '');
    return `${base}/api/v1/identity/sso/${provider}/callback`;
  }

  private async discovery(provider: SsoProvider): Promise<Discovery> {
    const cached = this.discoveries.get(provider);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
    const { issuer } = this.settings(provider);
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OIDC discovery for ${provider} failed: ${res.status}`);
    const doc = (await res.json()) as Discovery;
    this.discoveries.set(provider, { doc, at: Date.now() });
    return doc;
  }

  /** Signing keys by key id, refetched when an unknown key id appears (key rotation). */
  private async signingKey(jwksUri: string, kid: string | undefined): Promise<KeyObject> {
    const cached = this.jwks.get(jwksUri);
    const fresh = cached && Date.now() - cached.at < 600_000;
    let key = kid ? cached?.keys.get(kid) : undefined;
    if (!key && !(fresh && Date.now() - cached.at < 60_000)) {
      const res = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const { keys } = (await res.json()) as {
        keys: (JsonWebKey & { kid?: string; use?: string })[];
      };
      const map = new Map<string, KeyObject>();
      for (const k of keys) {
        if (k.kty !== 'RSA' || (k.use && k.use !== 'sig') || !k.kid) continue;
        map.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
      }
      this.jwks.set(jwksUri, { keys: map, at: Date.now() });
      key = kid ? map.get(kid) : undefined;
    }
    if (!key) throw new SsoError('invalid_token');
    return key;
  }

  // ---- start ----

  /** Builds the provider's sign-in URL for a company (or for linking an account). */
  async start(provider: SsoProvider, tenantSlug: string): Promise<string> {
    const tenant = await this.auth.tenantBySlug(tenantSlug);
    if (!tenant || tenant.status !== 'active') throw new SsoError('unknown_company');
    if (!policyOf(tenant).methods[provider]) throw new SsoError('method_disabled');
    return runAsTenant(tenant.id, { type: 'system', id: 'identity-service' }, () =>
      this.authorizeUrl(provider, tenant.id),
    );
  }

  /** For the account page: the signed-in user links a Google/Microsoft account. */
  async startLink(provider: SsoProvider): Promise<{ url: string }> {
    const ctx = requireContext();
    const tenant = await this.auth.tenantById(ctx.tenantId!);
    if (!policyOf(tenant).methods[provider]) {
      throw new AppError(
        403,
        'METHOD_DISABLED',
        'Your company does not allow this way of signing in',
      );
    }
    try {
      return { url: await this.authorizeUrl(provider, tenant.id, ctx.actor!.id) };
    } catch (e) {
      if (e instanceof SsoError && e.code === 'not_configured') {
        throw new AppError(
          503,
          'SSO_NOT_CONFIGURED',
          `${provider} sign-in is not set up on this server`,
        );
      }
      throw e;
    }
  }

  private async authorizeUrl(provider: SsoProvider, tenantId: string, linkUserId?: string) {
    const { clientId } = this.settings(provider);
    const disco = await this.discovery(provider);
    const secret = randomToken();
    const codeVerifier = randomToken(48);
    const nonce = randomToken(16);
    await (
      await this.states()
    ).create({
      provider,
      stateHash: sha256(secret),
      codeVerifier,
      nonce,
      linkUserId,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const url = new URL(disco.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.callbackUrl(provider),
      scope: 'openid email profile',
      state: composeToken(tenantId, secret),
      nonce,
      code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  // ---- callback ----

  async callback(
    provider: SsoProvider,
    query: { code?: string; state?: string; error?: string },
    meta: ClientMeta,
  ): Promise<SsoOutcome> {
    const parts = query.state ? splitToken(query.state) : undefined;
    if (!parts) throw new SsoError('invalid_state');
    const tenant = await this.auth.tenantById(parts.tenantId).catch(() => undefined);
    if (!tenant || tenant.status !== 'active') throw new SsoError('unknown_company');

    return runAsTenant(parts.tenantId, { type: 'system', id: 'identity-service' }, async () => {
      const state = await (
        await this.states()
      )
        .findOneAndUpdate(
          {
            stateHash: sha256(parts.secret),
            provider,
            usedAt: null,
            expiresAt: { $gt: new Date() },
          },
          { $set: { usedAt: new Date() } },
          { new: true },
        )
        .lean();
      if (!state) throw new SsoError('invalid_state');
      if (query.error || !query.code) throw new SsoError('cancelled');

      const claims = await this.exchange(provider, query.code, state.codeVerifier, state.nonce);
      const identity = this.identityOf(provider, claims);
      const policy = policyOf(tenant);
      if (!state.linkUserId && !policy.methods[provider]) {
        return this.refuse(provider, 'method_disabled', identity.email);
      }
      if (identity.personalMicrosoft && !policy.allowPersonalMicrosoft) {
        return this.refuse(provider, 'personal_account_not_allowed', identity.email);
      }
      if (policy.ssoDomains.length && !this.domainAllowed(identity.email, policy.ssoDomains)) {
        return this.refuse(provider, 'domain_not_allowed', identity.email);
      }

      if (state.linkUserId) return this.link(provider, identity, state.linkUserId);

      const user = await this.match(provider, identity, tenant);
      requireContext().actor = { type: 'user', id: String(user._id) };
      await (
        await this.linked()
      ).updateOne(
        { provider, subject: identity.subject },
        { $set: { lastUsedAt: new Date(), email: identity.email } },
      );
      if (user.mfa?.enabled) return { kind: 'mfa', mfa: await this.auth.startMfa(user) };
      return {
        kind: 'session',
        session: await this.auth.completeLogin(user, tenant, meta, `sso:${provider}`),
      };
    });
  }

  private async exchange(provider: SsoProvider, code: string, codeVerifier: string, nonce: string) {
    const { clientId, clientSecret } = this.settings(provider);
    const disco = await this.discovery(provider);
    const res = await fetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(provider),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) {
      this.log.warn(
        { provider, status: res.status, error: body.error },
        'sso code exchange failed',
      );
      throw new SsoError('provider_error');
    }

    const header = jwt.decode(body.id_token, { complete: true })?.header;
    const key = await this.signingKey(disco.jwks_uri, header?.kid);
    let claims: Claims;
    try {
      claims = jwt.verify(body.id_token, key, {
        algorithms: ['RS256'],
        audience: clientId,
        clockTolerance: 60,
      }) as Claims;
    } catch {
      throw new SsoError('invalid_token');
    }
    // Microsoft's multi-tenant issuer is a template: https://login.microsoftonline.com/{tenantid}/v2.0
    const expected = disco.issuer.replace('{tenantid}', claims.tid ?? '');
    const iss = claims.iss ?? '';
    if (iss !== expected && `https://${iss}` !== expected) throw new SsoError('invalid_token');
    if (!claims.sub || claims.nonce !== nonce) throw new SsoError('invalid_token');
    return claims;
  }

  /**
   * Which email the provider vouches for. Google says so with `email_verified`. Microsoft
   * only guarantees it for personal accounts, or for work accounts with `xms_edov`.
   */
  private identityOf(provider: SsoProvider, c: Claims) {
    const personalMicrosoft = provider === 'microsoft' && c.tid === MS_PERSONAL_TENANT;
    const email = c.email?.trim().toLowerCase();
    const verified =
      provider === 'google' ? c.email_verified === true : personalMicrosoft || c.xms_edov === true;
    return {
      subject: String(c.sub),
      email,
      verifiedEmail: verified ? email : undefined,
      name: c.name?.trim() || email?.split('@')[0] || 'User',
      personalMicrosoft,
    };
  }

  private domainAllowed(email: string | undefined, domains: string[]): boolean {
    const domain = email?.split('@')[1];
    return !!domain && domains.includes(domain);
  }

  private async refuse(provider: SsoProvider, reason: string, email?: string): Promise<never> {
    await this.conn.transaction(async (session) => {
      await this.outbox.record(
        EventTypes.SsoRefused,
        { provider, reason, email: email ?? null },
        { session },
      );
    });
    throw new SsoError(reason);
  }

  /**
   * 1. A linked account wins. 2. A verified email of an invited or active user gets linked.
   * 3. Domain auto-join creates the user. 4. Anyone else is refused.
   */
  private async match(
    provider: SsoProvider,
    identity: ReturnType<SsoService['identityOf']>,
    tenant: TenantInfo,
  ): Promise<User> {
    const [Users, Linked] = await Promise.all([this.auth.users(), this.linked()]);
    const link = await Linked.findOne({ provider, subject: identity.subject }).lean();
    if (link) {
      const user = await Users.findById(link.userId).lean();
      if (!user || user.status === 'deactivated') {
        return this.refuse(provider, 'account_disabled', identity.email);
      }
      if (user.status === 'active') return user;
    }

    const email = identity.verifiedEmail;
    const existing = email ? await Users.findOne({ email }).lean() : null;
    if (existing) {
      if (existing.status === 'deactivated') {
        return this.refuse(provider, 'account_disabled', email);
      }
      await this.conn.transaction(async (session) => {
        if (existing.status === 'invited') {
          await Users.updateOne(
            { _id: existing._id, status: 'invited' },
            { $set: { status: 'active' } },
            { session },
          );
          await this.outbox.record(
            EventTypes.UserActivated,
            { userId: String(existing._id), via: provider },
            { session },
          );
        }
        await this.createLink(provider, identity, String(existing._id), session);
      });
      return { ...existing, status: 'active' };
    }

    const policy = policyOf(tenant);
    const { autoJoin } = policy;
    if (
      !email ||
      !autoJoin.enabled ||
      !autoJoin.roleId ||
      !autoJoin.orgUnitId ||
      !this.domainAllowed(email, policy.ssoDomains)
    ) {
      return this.refuse(provider, email ? 'not_invited' : 'email_not_verified', identity.email);
    }

    // The role is assigned first so a new user never exists without access.
    const _id = new Types.ObjectId();
    await this.clients.access.post('/internal/access/assignments', {
      userId: String(_id),
      roleId: autoJoin.roleId,
      orgUnitId: autoJoin.orgUnitId,
    });
    try {
      await this.conn.transaction(async (session) => {
        await Users.create(
          [
            {
              _id,
              email,
              name: identity.name,
              status: 'active',
              language: tenant.defaultLanguage,
            },
          ],
          { session },
        );
        await this.createLink(provider, identity, String(_id), session);
        await this.outbox.record(
          EventTypes.UserAutoJoined,
          {
            userId: String(_id),
            email,
            provider,
            roleId: autoJoin.roleId,
            orgUnitId: autoJoin.orgUnitId,
          },
          { session },
        );
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new SsoError('try_again');
      throw e;
    }
    return (await Users.findById(_id).lean())!;
  }

  private async createLink(
    provider: SsoProvider,
    identity: ReturnType<SsoService['identityOf']>,
    userId: string,
    session: import('mongoose').ClientSession,
  ) {
    const Linked = await this.linked();
    await Linked.updateOne(
      { provider, subject: identity.subject },
      {
        $setOnInsert: { userId, createdAt: new Date() },
        $set: { email: identity.email, lastUsedAt: new Date() },
      },
      { upsert: true, session },
    );
    await this.outbox.record(
      EventTypes.SsoLinked,
      { userId, provider, email: identity.email ?? null },
      { session },
    );
  }

  private async link(
    provider: SsoProvider,
    identity: ReturnType<SsoService['identityOf']>,
    userId: string,
  ): Promise<SsoOutcome> {
    requireContext().actor = { type: 'user', id: userId };
    const user = await (await this.auth.users()).findById(userId).lean();
    if (!user || user.status !== 'active') throw new SsoError('account_disabled');
    const existing = await (
      await this.linked()
    )
      .findOne({ provider, subject: identity.subject })
      .lean();
    if (existing && existing.userId !== userId) {
      return this.refuse(provider, 'already_linked', identity.email);
    }
    if (!existing) {
      await this.conn.transaction((session) =>
        this.createLink(provider, identity, userId, session),
      );
    }
    return { kind: 'linked', provider };
  }

  // ---- account page ----

  async list() {
    const rows = await (
      await this.linked()
    )
      .find({ userId: requireContext().actor!.id })
      .sort({ createdAt: 1 })
      .lean();
    return rows.map((r: LinkedAccount) => ({
      id: String(r._id),
      provider: r.provider,
      email: r.email ?? null,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
    }));
  }

  async unlink(id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Linked account');
    const userId = requireContext().actor!.id;
    const Linked = await this.linked();
    const row = await Linked.findOne({ _id: id, userId }).lean();
    if (!row) throw AppError.notFound('Linked account');
    const user = await (await this.auth.users()).findById(userId).lean();
    const others = await Linked.countDocuments({ userId, _id: { $ne: row._id } });
    if (!user?.passwordHash && !user?.phone && others === 0) {
      throw new AppError(
        409,
        'LAST_SIGN_IN_METHOD',
        'Set a password or add a mobile number before removing your only way to sign in',
      );
    }
    await this.conn.transaction(async (session) => {
      await Linked.deleteOne({ _id: row._id }, { session });
      await this.outbox.record(
        EventTypes.SsoUnlinked,
        { userId, provider: row.provider, email: row.email ?? null },
        { session },
      );
    });
    return { ok: true };
  }
}
