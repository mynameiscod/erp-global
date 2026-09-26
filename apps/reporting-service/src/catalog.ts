import { Inject, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { hasPermission, recordPermission, type AclEntry } from '@erp/contracts';
import {
  checkPersonalReport,
  pickText,
  reportSchema,
  type ReportDef,
  type ReportResult,
  type ReportRunParams,
} from '@erp/metadata';
import {
  AppError,
  TENANT_DATABASES,
  UpstreamError,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { PersonalReportModel, type PersonalReport } from './models';

/** Who a report runs for: a signed-in user, or a scheduled recipient. */
export interface Viewer {
  userId: string;
  acl: AclEntry[];
  lang: string;
  /** Ids of the roles the viewer holds anywhere. */
  roleIds: string[];
}

export type ReportKind = 'company' | 'mine' | 'shared';

export interface ReportEntry {
  ref: string;
  kind: ReportKind;
  label: string;
  entity: string;
  def: ReportDef;
  ownerId?: string;
  sharedRoleIds?: string[];
}

const MY_RE = /^my:([a-f0-9]{24})$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Company reports from the configuration, personal reports from this service. */
@Injectable()
export class ReportCatalog {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  /** The signed-in user, with the roles they hold. */
  async viewer(): Promise<Viewer> {
    const ctx = requireContext();
    if (ctx.actor?.type !== 'user') throw AppError.forbidden();
    return {
      userId: ctx.actor.id,
      acl: ctx.acl ?? [],
      lang: ctx.lang ?? 'en',
      roleIds: await this.roleIdsOf(ctx.actor.id),
    };
  }

  async roleIdsOf(userId: string): Promise<string[]> {
    const roles = await this.clients.access.get<{ roleId: string }[]>(
      `/internal/access/users/${userId}/roles`,
    );
    return [...new Set(roles.map((r) => r.roleId))];
  }

  config(): Promise<EffectiveConfigResponse> {
    return this.clients.config.effective();
  }

  private async personal() {
    return this.dbs.model(PersonalReportModel);
  }

  /** Can this viewer see a report at all (before their record access narrows the data)? */
  canSee(v: Viewer, e: ReportEntry): boolean {
    const claims = { acl: v.acl };
    if (!hasPermission(claims, recordPermission(e.entity, 'read'))) return false;
    if (e.kind === 'company') {
      const roles = e.def.roleIds ?? [];
      return (
        !roles.length ||
        roles.some((r) => v.roleIds.includes(r)) ||
        hasPermission(claims, 'config.manage')
      );
    }
    return e.ownerId === v.userId || (e.sharedRoleIds ?? []).some((r) => v.roleIds.includes(r));
  }

  private personalEntry(p: PersonalReport, v: Viewer): ReportEntry {
    return {
      ref: `my:${String(p._id)}`,
      kind: p.ownerId === v.userId ? 'mine' : 'shared',
      label: pickText(p.def.label, v.lang),
      entity: p.def.entity,
      def: p.def,
      ownerId: p.ownerId,
      sharedRoleIds: p.sharedRoleIds,
    };
  }

  async list(v: Viewer): Promise<ReportEntry[]> {
    const cfg = await this.config();
    const company: ReportEntry[] = cfg.reports.map((r) => ({
      ref: r.key,
      kind: 'company',
      label: pickText(r.label, v.lang),
      entity: r.entity,
      def: r,
    }));
    const P = await this.personal();
    const personal = await P.find({
      $or: [{ ownerId: v.userId }, { sharedRoleIds: { $in: v.roleIds } }],
    })
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean<PersonalReport[]>();
    return [...company, ...personal.map((p) => this.personalEntry(p, v))].filter((e) =>
      this.canSee(v, e),
    );
  }

  /** A report by reference (`key` or `my:<id>`) that the viewer may see. */
  async get(v: Viewer, ref: string): Promise<ReportEntry> {
    let entry: ReportEntry | undefined;
    const my = MY_RE.exec(ref);
    if (my) {
      const p = await (await this.personal()).findById(my[1]).lean<PersonalReport>();
      if (p) entry = this.personalEntry(p, v);
    } else if (KEY_RE.test(ref)) {
      const r = (await this.config()).reports.find((x) => x.key === ref);
      if (r)
        entry = {
          ref,
          kind: 'company',
          label: pickText(r.label, v.lang),
          entity: r.entity,
          def: r,
        };
    }
    if (!entry || !this.canSee(v, entry)) throw AppError.notFound('Report');
    return entry;
  }

  /** Runs a definition with the viewer's access (records-service applies it to every query). */
  async run(
    v: Viewer,
    def: ReportDef,
    params: ReportRunParams,
    purpose: 'view' | 'export' = 'view',
  ): Promise<ReportResult> {
    try {
      return await this.clients.records.post<ReportResult>(
        '/internal/outputs/reports/run',
        { report: def, params, acl: v.acl, lang: v.lang, purpose },
        { timeoutMs: purpose === 'export' ? 90_000 : 30_000 },
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status < 500 && e.body) {
        throw new AppError(e.status, e.body.error.code, e.body.error.message, e.body.error.details);
      }
      throw e;
    }
  }

  // ---- personal reports ----

  /** Checks a definition someone built: its shape, and that it fits the configuration. */
  async checkDefinition(v: Viewer, body: unknown): Promise<ReportDef> {
    const parsed = reportSchema.safeParse({ key: 'personal', ...(body as object) });
    if (!parsed.success) {
      throw AppError.badRequest(
        'Please correct the report',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const def = { ...(parsed.data as ReportDef), key: 'personal', roleIds: undefined };
    const cfg = await this.config();
    const issues = checkPersonalReport(def, cfg.entities);
    if (issues.length) throw AppError.badRequest('Please correct the report', issues);
    if (!hasPermission({ acl: v.acl }, recordPermission(def.entity, 'read')))
      throw AppError.forbidden('You cannot see these records');
    return def;
  }

  async create(v: Viewer, body: unknown) {
    const def = await this.checkDefinition(v, body);
    const P = await this.personal();
    const [doc] = await P.create([{ ownerId: v.userId, def, sharedRoleIds: [] }]);
    return this.personalEntry(doc.toObject() as PersonalReport, v);
  }

  private async own(v: Viewer, id: string) {
    const P = await this.personal();
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Report');
    const doc = await P.findById(id).lean<PersonalReport>();
    if (!doc || doc.ownerId !== v.userId) throw AppError.notFound('Report');
    return { P, doc };
  }

  async update(v: Viewer, id: string, body: unknown) {
    const { P } = await this.own(v, id);
    const def = await this.checkDefinition(v, body);
    await P.updateOne({ _id: id }, { $set: { def } });
    return this.get(v, `my:${id}`);
  }

  async remove(v: Viewer, id: string) {
    const { P } = await this.own(v, id);
    await P.deleteOne({ _id: id });
    return { deleted: true };
  }

  async share(v: Viewer, id: string, roleIds: string[]) {
    if (!hasPermission({ acl: v.acl }, 'reports.share'))
      throw AppError.forbidden('Missing permission: reports.share');
    const { P } = await this.own(v, id);
    await P.updateOne({ _id: id }, { $set: { sharedRoleIds: [...new Set(roleIds)] } });
    return this.get(v, `my:${id}`);
  }
}
