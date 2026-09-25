import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Types, type Connection, type Model } from 'mongoose';
import {
  EventTypes,
  NotifyTypes,
  PLATFORM_PERMISSION_KEYS,
  PLATFORM_TENANT_ID,
  type EmailRequestedPayload,
  type InviteUserInput,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, paginate, validateCustomFields } from '@erp/service-kit';
import { requireContext, runAsTenant } from '@erp/tenancy';
import { AuthService, INVITE_TTL_MS } from './auth.service';
import { CLIENTS, IDENTITY_ENV, type Clients, type IdentityEnv } from './config';
import { hashPassword } from './crypto';
import {
  LinkedAccountModel,
  OtpChallengeModel,
  SsoStateModel,
  toUserDto,
  type User,
} from './models';
import { TENANT_DATABASES } from '@erp/service-kit';
import type { TenantDatabases } from '@erp/tenancy';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class UsersService {
  constructor(
    private readonly auth: AuthService,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
    private readonly log: PinoLogger,
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
  ) {}

  private async load(id: string): Promise<User> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('User');
    const user = await (await this.auth.users()).findById(id).lean();
    if (!user) throw AppError.notFound('User');
    return user;
  }

  // ---- self ----

  async me() {
    const ctx = requireContext();
    const user = await this.load(ctx.actor!.id);
    return {
      ...toUserDto(user),
      tenantId: ctx.tenantId,
      acl: ctx.acl ?? [],
      platformPermissions: ctx.plat ?? [],
    };
  }

  async updateMe(patch: { name?: string; language?: string; timezone?: string }) {
    const ctx = requireContext();
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length)
      await (await this.auth.users()).updateOne({ _id: ctx.actor!.id }, { $set: set });
    return this.me();
  }

  // ---- admin ----

  async list(query: { q?: string; status?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.q) {
      const re = { $regex: escapeRegex(query.q), $options: 'i' };
      filter.$or = [{ name: re }, { email: re }];
    }
    return paginate(
      await this.auth.users(),
      filter,
      { page: query.page, pageSize: query.pageSize, sort: { name: 1 } },
      toUserDto,
    );
  }

  async get(id: string) {
    return toUserDto(await this.load(id));
  }

  async invite(input: InviteUserInput) {
    const ctx = requireContext();
    const Users = await this.auth.users();
    const tenant = await this.auth.tenantById(ctx.tenantId!);
    const existing = await Users.findOne({ email: input.email }).lean();
    if (existing && existing.status !== 'invited')
      throw AppError.conflict('A user with this email already exists');
    const custom = await validateCustomFields(
      this.clients.config,
      'user',
      input.custom,
      existing?.custom,
    );

    const user =
      existing ??
      (
        await Users.create({
          email: input.email,
          name: input.name,
          status: 'invited',
          language: input.language ?? tenant.defaultLanguage,
          custom,
        })
      ).toObject();
    await this.sendInvite(user, tenant.name ?? '');
    return toUserDto(user);
  }

  /** Admin edit: name, language, time zone and custom fields. */
  async update(
    id: string,
    input: {
      name?: string;
      language?: string;
      timezone?: string;
      custom?: Record<string, unknown>;
      managerId?: string | null;
    },
  ) {
    const user = await this.load(id);
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'language', 'timezone'] as const)
      if (input[k] !== undefined) set[k] = input[k];
    if (input.managerId !== undefined) {
      if (input.managerId) await this.assertManager(id, input.managerId);
      set.managerId = input.managerId ?? undefined;
    }
    if (input.custom !== undefined) {
      set.custom = await validateCustomFields(
        this.clients.config,
        'user',
        input.custom,
        user.custom ?? {},
      );
    }
    const before = user as unknown as Record<string, unknown>;
    const changes = Object.fromEntries(
      Object.entries(set)
        .filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v))
        .map(([k, v]) => [k, { from: before[k] ?? null, to: v }]),
    );
    if (!Object.keys(changes).length) return toUserDto(user);
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne({ _id: user._id }, { $set: set }, { session });
      await this.outbox.record(EventTypes.UserUpdated, { userId: id, changes }, { session });
    });
    return this.get(id);
  }

  async resendInvite(id: string) {
    const user = await this.load(id);
    if (user.status !== 'invited')
      throw AppError.conflict('This user has already accepted the invite');
    const tenant = await this.auth.tenantById(requireContext().tenantId!);
    await this.sendInvite(user, tenant.name ?? '');
    return toUserDto(user);
  }

  private async sendInvite(user: User, companyName: string) {
    const ctx = requireContext();
    const token = await this.auth.createOneTimeToken(String(user._id), 'invite', INVITE_TTL_MS);
    const inviter =
      ctx.actor?.type === 'user' ? await this.load(ctx.actor.id).catch(() => undefined) : undefined;
    await this.conn.transaction(async (session) => {
      await this.outbox.record(
        EventTypes.UserInvited,
        { userId: String(user._id), email: user.email, name: user.name },
        { session },
      );
      await this.outbox.record<EmailRequestedPayload>(
        NotifyTypes.EmailRequested,
        {
          to: user.email,
          template: 'user.invite',
          locale: user.language,
          vars: {
            name: user.name,
            company: companyName,
            inviter: inviter?.name ?? '',
            link: `${this.env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}`,
          },
        },
        { session },
      );
    });
  }

  async inviteDetails(token: string) {
    return this.auth.withOneTimeToken(token, 'invite', async (userId) => {
      const user = await this.load(userId);
      const tenant = await this.auth.tenantById(requireContext().tenantId!);
      return { email: user.email, name: user.name, company: tenant.name ?? '' };
    });
  }

  async acceptInvite(token: string, password: string) {
    await this.auth.withOneTimeToken(token, 'invite', async (userId, tokenId) => {
      const [Users, Tokens] = await Promise.all([this.auth.users(), this.auth.tokens()]);
      const passwordHash = await hashPassword(password);
      await this.conn.transaction(async (session) => {
        const res = await Users.updateOne(
          { _id: userId, status: 'invited' },
          { $set: { passwordHash, status: 'active', passwordChangedAt: new Date() } },
          { session },
        );
        if (res.modifiedCount !== 1)
          throw new AppError(400, 'INVALID_TOKEN', 'This invite has already been used');
        await Tokens.updateOne({ _id: tokenId }, { $set: { usedAt: new Date() } }, { session });
        await this.outbox.record(EventTypes.UserActivated, { userId }, { session });
      });
    });
    return { ok: true };
  }

  async setStatus(id: string, status: 'deactivated' | 'active') {
    const ctx = requireContext();
    if (id === ctx.actor?.id) throw AppError.badRequest('You cannot change your own status');
    const user = await this.load(id);
    if (status === 'active' && user.status !== 'deactivated') return toUserDto(user);
    if (status === 'deactivated' && user.status === 'deactivated') return toUserDto(user);
    const next = status === 'active' ? (user.passwordHash ? 'active' : 'invited') : 'deactivated';
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne({ _id: user._id }, { $set: { status: next } }, { session });
      await this.outbox.record(
        status === 'active' ? EventTypes.UserReactivated : EventTypes.UserDeactivated,
        { userId: id, email: user.email },
        { session },
      );
    });
    if (status === 'deactivated') await this.auth.revokeUserSessions(id, 'deactivated');
    return this.get(id);
  }

  // ---- internal ----

  async bootstrapAdmin(input: {
    name: string;
    email: string;
    password: string;
    language: string;
    timezone: string;
  }) {
    const Users = await this.auth.users();
    const existing = await Users.findOne({ email: input.email }).lean();
    if (existing) return { userId: String(existing._id) };
    const passwordHash = await hashPassword(input.password);
    const id = new Types.ObjectId();
    await this.conn.transaction(async (session) => {
      await Users.create(
        [
          {
            _id: id,
            email: input.email,
            name: input.name,
            passwordHash,
            status: 'active',
            language: input.language,
            timezone: input.timezone,
            passwordChangedAt: new Date(),
          },
        ],
        { session },
      );
      await this.outbox.record(
        EventTypes.UserCreated,
        { userId: String(id), email: input.email, name: input.name, role: 'tenant_admin' },
        { session },
      );
    });
    return { userId: String(id) };
  }

  async deleteTenantData() {
    const models = await Promise.all([
      this.auth.users(),
      this.auth.sessions(),
      this.auth.tokens(),
      this.dbs.model(OtpChallengeModel),
      this.dbs.model(LinkedAccountModel),
      this.dbs.model(SsoStateModel),
    ]);
    const results = await Promise.all(
      models.map((m) => (m as unknown as Model<unknown>).deleteMany({})),
    );
    return { deleted: results.reduce((n, r) => n + r.deletedCount, 0) };
  }

  async internalGet(id: string) {
    const u = await this.load(id);
    return this.internalDto(u);
  }

  private internalDto(u: User) {
    return {
      id: String(u._id),
      email: u.email,
      name: u.name,
      status: u.status,
      language: u.language,
      timezone: u.timezone,
      phone: u.phone ?? null,
      managerId: u.managerId ?? null,
    };
  }

  /** Several users at once, for notifications and approver lists. Unknown ids are skipped. */
  async internalBatch(ids: string[]) {
    const valid = ids.filter((i) => Types.ObjectId.isValid(i)).slice(0, 500);
    const users = await (await this.auth.users()).find({ _id: { $in: valid } }).lean();
    return users.map((u) => this.internalDto(u));
  }

  /** Users whose approvals `userId` may act on right now (one hop, never a chain). */
  async internalDelegators(userId: string) {
    const now = new Date();
    const users = await (
      await this.auth.users()
    )
      .find({
        'delegation.toUserId': userId,
        'delegation.from': { $lte: now },
        'delegation.until': { $gt: now },
        status: 'active',
      })
      .select({ _id: 1 })
      .lean();
    return users.map((u) => String(u._id));
  }

  /** Who may act for `userId` right now, if anyone. */
  async internalDelegate(userId: string) {
    const u = await this.load(userId);
    const d = u.delegation;
    const now = new Date();
    return {
      toUserId: d && d.from <= now && d.until > now ? d.toUserId : null,
    };
  }

  // ---- manager and delegation ----

  /** The manager must be an active user of the company, and not create a loop. */
  private async assertManager(userId: string, managerId: string) {
    if (managerId === userId) throw AppError.badRequest('A user cannot report to themselves');
    const Users = await this.auth.users();
    let current: string | undefined = managerId;
    for (let i = 0; i < 50 && current; i++) {
      const m: User | null = await Users.findById(current).lean();
      if (!m) throw AppError.badRequest('Manager not found');
      if (i === 0 && m.status === 'deactivated')
        throw AppError.badRequest('This manager is deactivated');
      if (m.managerId === userId) throw AppError.badRequest('This would make a reporting loop');
      current = m.managerId;
    }
  }

  async myDelegation() {
    const user = await this.load(requireContext().actor!.id);
    const d = user.delegation;
    if (!d) return null;
    const to = await (await this.auth.users()).findById(d.toUserId).lean();
    return {
      toUserId: d.toUserId,
      toName: to?.name ?? null,
      from: d.from,
      until: d.until,
      note: d.note ?? null,
      active: d.from <= new Date() && d.until > new Date(),
    };
  }

  async setDelegation(input: { toUserId: string; from: string; until: string; note?: string }) {
    const userId = requireContext().actor!.id;
    if (input.toUserId === userId) throw AppError.badRequest('Choose someone else');
    const to = await this.load(input.toUserId).catch(() => null);
    if (!to || to.status !== 'active') throw AppError.badRequest('Choose an active user');
    const delegation = {
      toUserId: input.toUserId,
      from: new Date(input.from),
      until: new Date(input.until),
      note: input.note,
    };
    if (delegation.until <= new Date()) throw AppError.badRequest('The end date has passed');
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne({ _id: userId }, { $set: { delegation } }, { session });
      await this.outbox.record(
        EventTypes.DelegationSet,
        { userId, toUserId: input.toUserId, from: input.from, until: input.until },
        { session },
      );
    });
    return this.myDelegation();
  }

  async clearDelegation() {
    const userId = requireContext().actor!.id;
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      const res = await Users.updateOne(
        { _id: userId, delegation: { $exists: true } },
        { $unset: { delegation: '' } },
        { session },
      );
      if (res.modifiedCount) {
        await this.outbox.record(EventTypes.DelegationCleared, { userId }, { session });
      }
    });
    return null;
  }

  /** Creates the first Super Admin from environment settings, once. */
  async seedPlatformAdmin(): Promise<void> {
    const {
      PLATFORM_ADMIN_EMAIL: email,
      PLATFORM_ADMIN_PASSWORD: password,
      PLATFORM_ADMIN_NAME: name,
    } = this.env;
    if (!email || !password) return;
    await runAsTenant(PLATFORM_TENANT_ID, { type: 'system', id: 'identity-service' }, async () => {
      const Users = await this.auth.users();
      if (await Users.exists({})) return;
      const passwordHash = await hashPassword(password);
      const id = new Types.ObjectId();
      await this.conn.transaction(async (session) => {
        await Users.create(
          [
            {
              _id: id,
              email: email.toLowerCase(),
              name,
              passwordHash,
              status: 'active',
              platformPermissions: PLATFORM_PERMISSION_KEYS,
              passwordChangedAt: new Date(),
            },
          ],
          { session },
        );
        await this.outbox.record(
          EventTypes.UserCreated,
          { userId: String(id), email, name, role: 'platform_admin' },
          { session },
        );
      });
      this.log.info({ email }, 'platform admin created');
    });
  }
}
