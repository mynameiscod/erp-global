import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Types, type Connection, type FilterQuery } from 'mongoose';
import {
  EventTypes,
  type CountryDto,
  type SignupInput,
  type TenantSettingsInput,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, paginate, UpstreamError } from '@erp/service-kit';
import { requireTenantId, runAsTenant } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { DbProvisioner } from './db-provisioner';
import { tenantModel, toTenantDto, type Tenant, type TenantPlacement } from './tenant.model';

/** Slugs that would clash with platform routes, subdomains or the platform tenant. */
const RESERVED_SLUGS = new Set([
  'platform',
  'admin',
  'api',
  'www',
  'app',
  'apps',
  'auth',
  'login',
  'signup',
  'static',
  'assets',
  'mail',
  'support',
  'help',
  'status',
  'docs',
  'internal',
  'system',
  'root',
  'test',
  'demo',
]);

const SYSTEM_ACTOR = { type: 'system' as const, id: 'tenant-service' };

@Injectable()
export class TenantsService {
  constructor(
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
    private readonly log: PinoLogger,
    private readonly provisioner: DbProvisioner,
  ) {}

  private get Tenants() {
    return tenantModel(this.conn);
  }

  async isSlugAvailable(slug: string): Promise<boolean> {
    if (RESERVED_SLUGS.has(slug)) return false;
    return !(await this.Tenants.exists({ slug }));
  }

  /**
   * Self-service sign-up. Creates the tenant, then asks org, identity and
   * access services to set up the root org unit, the admin user and the
   * default roles. If any step fails, the completed steps are undone and the
   * tenant is marked failed, which frees the slug.
   */
  async signup(input: SignupInput, placement: TenantPlacement = 'shared') {
    if (RESERVED_SLUGS.has(input.slug))
      throw AppError.conflict('This company URL is not available');
    const country = await this.clients.reference
      .get<CountryDto>(`/api/v1/reference/countries/${input.countryCode}`)
      .catch((e: unknown) => {
        if (e instanceof UpstreamError && e.status === 404)
          throw AppError.badRequest('Unknown country');
        throw e;
      });

    const tenantId = new Types.ObjectId();
    const id = String(tenantId);
    await runAsTenant(id, SYSTEM_ACTOR, () =>
      this.conn.transaction(async (session) => {
        await this.Tenants.create(
          [
            {
              _id: tenantId,
              slug: input.slug,
              requestedSlug: input.slug,
              name: input.companyName,
              countryCode: country.code,
              industryCode: input.industryCode,
              defaultLanguage: input.defaultLanguage,
              timezone: input.timezone,
              currency: country.currencies[0] ?? 'USD',
              locale: country.defaultLocale,
              status: 'provisioning',
              placement,
              settings: { requireMfa: false },
              provisioning: { completed: [] },
            },
          ],
          { session },
        ).catch((e: { code?: number }) => {
          if (e.code === 11000) throw AppError.conflict('This company URL is already taken');
          throw e;
        });
        await this.outbox.record(
          EventTypes.TenantCreated,
          {
            tenantId: id,
            slug: input.slug,
            name: input.companyName,
            countryCode: country.code,
            industryCode: input.industryCode,
            placement,
          },
          { session, tenantId: id },
        );
      }),
    );

    return runAsTenant(id, SYSTEM_ACTOR, () => this.provision(id, input));
  }

  private async provision(id: string, input: SignupInput) {
    const completed: string[] = [];
    const mark = (step: string) => {
      completed.push(step);
      return this.Tenants.updateOne({ _id: id }, { $addToSet: { 'provisioning.completed': step } });
    };
    try {
      const tenant = await this.Tenants.findById(id, { placement: 1 }).lean();
      if (tenant?.placement === 'dedicated') await this.provisioner.grantDedicated(id);

      const org = await this.clients.org.post<{ rootUnitId: string; rootPath: string }>(
        '/internal/org/bootstrap',
        {
          name: input.companyName,
        },
      );
      await mark('org');

      const admin = await this.clients.identity.post<{ userId: string }>(
        '/internal/users/bootstrap-admin',
        {
          name: input.admin.name,
          email: input.admin.email,
          password: input.admin.password,
          language: input.defaultLanguage,
          timezone: input.timezone,
        },
      );
      await mark('identity');

      await this.clients.access.post('/internal/access/bootstrap', {
        adminUserId: admin.userId,
        rootOrgUnitId: org.rootUnitId,
        rootPath: org.rootPath,
      });
      await mark('access');

      await this.conn.transaction(async (session) => {
        await this.Tenants.updateOne(
          { _id: id },
          { $set: { status: 'active', rootOrgUnitId: org.rootUnitId, adminUserId: admin.userId } },
          { session },
        );
        await this.outbox.record(
          EventTypes.TenantActivated,
          { tenantId: id, rootOrgUnitId: org.rootUnitId, adminUserId: admin.userId },
          { session },
        );
      });
      return { tenantId: id, slug: input.slug, status: 'active' as const };
    } catch (err) {
      this.log.error({ err, tenantId: id, completed }, 'sign-up failed; compensating');
      await this.compensate(id, completed);
      await this.conn.transaction(async (session) => {
        await this.Tenants.updateOne(
          { _id: id },
          {
            $set: { status: 'failed', 'provisioning.error': (err as Error).message },
            $unset: { slug: '' },
          },
          { session },
        );
        await this.outbox.record(
          EventTypes.TenantSignupFailed,
          { tenantId: id, completed },
          { session },
        );
      });
      if (err instanceof AppError || (err instanceof UpstreamError && err.status < 500)) throw err;
      throw new AppError(502, 'SIGNUP_FAILED', 'Sign-up could not be completed. Please try again.');
    }
  }

  /** Undo completed steps in reverse order. Each undo endpoint is idempotent. */
  private async compensate(id: string, completed: string[]): Promise<void> {
    const undo: Record<string, () => Promise<unknown>> = {
      access: () => this.clients.access.delete('/internal/access/bootstrap'),
      identity: () => this.clients.identity.delete('/internal/users/tenant-data'),
      org: () => this.clients.org.delete('/internal/org/bootstrap'),
    };
    for (const step of [...completed].reverse()) {
      try {
        await undo[step]();
      } catch (err) {
        this.log.error(
          { err, tenantId: id, step },
          'compensation step failed; needs manual cleanup',
        );
      }
    }
  }

  // ---- current tenant (tenant users) ----

  async current() {
    const t = await this.Tenants.findById(requireTenantId()).lean();
    if (!t) throw AppError.notFound('Tenant');
    return toTenantDto(t);
  }

  async updateSettings(input: TenantSettingsInput) {
    const id = requireTenantId();
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.defaultLanguage !== undefined) set.defaultLanguage = input.defaultLanguage;
    if (input.timezone !== undefined) set.timezone = input.timezone;
    if (input.requireMfa !== undefined) set['settings.requireMfa'] = input.requireMfa;
    if (!Object.keys(set).length) return this.current();

    await this.conn.transaction(async (session) => {
      const before = await this.Tenants.findOneAndUpdate(
        { _id: id, status: 'active' },
        { $set: set },
        { session },
      ).lean();
      if (!before) throw AppError.notFound('Tenant');
      await this.outbox.record(
        EventTypes.TenantSettingsUpdated,
        {
          changes: Object.fromEntries(
            Object.entries(input).map(([k, v]) => [
              k,
              {
                from:
                  k === 'requireMfa'
                    ? before.settings.requireMfa
                    : (before as unknown as Record<string, unknown>)[k],
                to: v,
              },
            ]),
          ),
        },
        { session },
      );
    });
    return this.current();
  }

  // ---- platform (Super Admin) ----

  async list(query: { q?: string; status?: string; page: number; pageSize: number }) {
    const filter: FilterQuery<Tenant> = {};
    if (query.status) filter.status = query.status;
    if (query.q) filter.$text = { $search: query.q };
    return paginate(
      this.Tenants,
      filter,
      { page: query.page, pageSize: query.pageSize, sort: { createdAt: -1 } },
      toTenantDto,
    );
  }

  async get(id: string) {
    const t = Types.ObjectId.isValid(id) ? await this.Tenants.findById(id).lean() : null;
    if (!t) throw AppError.notFound('Tenant');
    return toTenantDto(t);
  }

  async setStatus(id: string, status: 'active' | 'suspended') {
    const current = await this.get(id);
    if (current.status === status) return current;
    if (!['active', 'suspended'].includes(current.status)) {
      throw AppError.conflict(`A ${current.status} tenant cannot be changed to ${status}`);
    }
    await this.conn.transaction(async (session) => {
      await this.Tenants.updateOne({ _id: id }, { $set: { status } }, { session });
      await this.outbox.record(
        EventTypes.TenantStatusChanged,
        { from: current.status, to: status },
        { session, tenantId: id },
      );
    });
    return this.get(id);
  }

  // ---- internal ----

  async bySlug(slug: string) {
    const t = await this.Tenants.findOne({ slug }).lean();
    if (!t) throw AppError.notFound('Tenant');
    return {
      id: String(t._id),
      slug: t.slug,
      name: t.name,
      status: t.status,
      defaultLanguage: t.defaultLanguage,
      requireMfa: t.settings.requireMfa,
    };
  }

  async publicLookup(slug: string) {
    const t = await this.Tenants.findOne({ slug, status: { $in: ['active', 'suspended'] } }).lean();
    if (!t) throw AppError.notFound('Company');
    return { slug: t.slug, name: t.name, defaultLanguage: t.defaultLanguage, status: t.status };
  }

  async internalGet(id: string) {
    const t = Types.ObjectId.isValid(id) ? await this.Tenants.findById(id).lean() : null;
    if (!t) throw AppError.notFound('Tenant');
    return {
      id: String(t._id),
      slug: t.slug,
      name: t.name,
      status: t.status,
      requireMfa: t.settings.requireMfa,
      defaultLanguage: t.defaultLanguage,
    };
  }
}
