import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { hasPermission } from '@erp/contracts';
import {
  dashboardSchema,
  pickText,
  previousRange,
  resolveRelative,
  type DashboardDef,
  type DashboardWidget,
  type ReportDef,
  type ReportResult,
  type ReportRunParams,
  type ResultColumn,
} from '@erp/metadata';
import { AppError, TENANT_DATABASES } from '@erp/service-kit';
import { requireTenantId, type TenantDatabases } from '@erp/tenancy';
import { ReportCatalog, type Viewer } from './catalog';
import { CLOCK, type Clock } from './clients';
import { PersonalDashboardModel, type PersonalDashboard } from './models';

const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 1_000;
const MY_RE = /^my:([a-f0-9]{24})$/;

export interface DashboardEntry {
  ref: string;
  kind: 'company' | 'mine' | 'shared';
  label: string;
  home: boolean;
  def: DashboardDef;
  ownerId?: string;
  sharedRoleIds?: string[];
  /** Changes when the dashboard changes, for the cache. */
  version: string;
}

export interface DashboardFilters {
  dateRange?: { from: string; to: string };
  orgUnitId?: string;
}

export type WidgetData =
  | { kind: 'kpi'; value: unknown; previous?: unknown; column?: ResultColumn }
  | { kind: 'report'; result: ReportResult }
  | { kind: 'error'; message: string };

const addDays = (day: string, n: number) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class DashboardsService {
  private readonly cache = new Map<string, { expires: number; value: WidgetData }>();

  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly catalog: ReportCatalog,
  ) {}

  private personal() {
    return this.dbs.model(PersonalDashboardModel);
  }

  private canSee(v: Viewer, e: DashboardEntry): boolean {
    if (e.kind === 'company') {
      return (
        this.catalog.holdsAny(v, e.def.roleIds, e.def.roleKeys) ||
        hasPermission({ acl: v.acl }, 'config.manage')
      );
    }
    return e.ownerId === v.userId || (e.sharedRoleIds ?? []).some((r) => v.roleIds.includes(r));
  }

  private personalEntry(p: PersonalDashboard, v: Viewer): DashboardEntry {
    return {
      ref: `my:${String(p._id)}`,
      kind: p.ownerId === v.userId ? 'mine' : 'shared',
      label: pickText(p.def.label, v.lang),
      home: false,
      def: p.def,
      ownerId: p.ownerId,
      sharedRoleIds: p.sharedRoleIds,
      version: new Date(p.updatedAt).toISOString(),
    };
  }

  async list(v: Viewer): Promise<DashboardEntry[]> {
    const cfg = await this.catalog.config();
    const company: DashboardEntry[] = cfg.dashboards.map((d) => ({
      ref: d.key,
      kind: 'company',
      label: pickText(d.label, v.lang),
      home: !!d.home,
      def: d,
      version: String(cfg.version),
    }));
    const mine = await (
      await this.personal()
    )
      .find({ $or: [{ ownerId: v.userId }, { sharedRoleIds: { $in: v.roleIds } }] })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean<PersonalDashboard[]>();
    const all = [...company, ...mine.map((p) => this.personalEntry(p, v))].filter((e) =>
      this.canSee(v, e),
    );
    // One home dashboard: the first company dashboard marked home for the viewer's roles.
    const home =
      all.find(
        (e) =>
          e.home &&
          e.kind === 'company' &&
          !!(e.def.roleIds?.length || e.def.roleKeys?.length) &&
          this.catalog.holdsAny(v, e.def.roleIds, e.def.roleKeys),
      ) ??
      all.find((e) => e.home) ??
      all[0];
    return all.map((e) => ({ ...e, home: e === home }));
  }

  async get(v: Viewer, ref: string): Promise<DashboardEntry> {
    const my = MY_RE.exec(ref);
    let entry: DashboardEntry | undefined;
    if (my) {
      const p = await (await this.personal()).findById(my[1]).lean<PersonalDashboard>();
      if (p) entry = this.personalEntry(p, v);
    } else {
      const cfg = await this.catalog.config();
      const d = cfg.dashboards.find((x) => x.key === ref);
      if (d)
        entry = {
          ref,
          kind: 'company',
          label: pickText(d.label, v.lang),
          home: !!d.home,
          def: d,
          version: String(cfg.version),
        };
    }
    if (!entry || !this.canSee(v, entry)) throw AppError.notFound('Dashboard');
    return entry;
  }

  /** Data of every report widget. A widget that fails shows its message; the others still load. */
  async data(v: Viewer, ref: string, filters: DashboardFilters, refresh = false) {
    const entry = await this.get(v, ref);
    const allowed: DashboardFilters = {
      dateRange: entry.def.filters?.dateRange ? filters.dateRange : undefined,
      orgUnitId: entry.def.filters?.orgUnit ? filters.orgUnitId : undefined,
    };
    const aclHash = createHash('sha256').update(JSON.stringify(v.acl)).digest('hex').slice(0, 16);
    const widgets = entry.def.widgets.filter(
      (w) => ['kpi', 'chart', 'list'].includes(w.type) && w.report,
    );
    const out: Record<string, WidgetData> = {};
    // A few at a time, to keep the database responsive.
    for (let i = 0; i < widgets.length; i += 4) {
      await Promise.all(
        widgets.slice(i, i + 4).map(async (w) => {
          const key = [
            requireTenantId(),
            ref,
            entry.version,
            w.id,
            aclHash,
            v.lang,
            JSON.stringify(allowed),
          ].join('|');
          const hit = this.cache.get(key);
          if (!refresh && hit && hit.expires > this.clock.now().getTime()) {
            out[w.id] = hit.value;
            return;
          }
          const value = await this.widget(v, w, allowed).catch((e): WidgetData => ({
            kind: 'error',
            message: e instanceof AppError ? e.message : 'Could not load',
          }));
          if (value.kind !== 'error') this.remember(key, value);
          out[w.id] = value;
        }),
      );
    }
    return { ref, data: out, loadedAt: this.clock.now().toISOString() };
  }

  private remember(key: string, value: WidgetData) {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: this.clock.now().getTime() + CACHE_MS, value });
  }

  private async widget(v: Viewer, w: DashboardWidget, f: DashboardFilters): Promise<WidgetData> {
    const entry = await this.catalog.get(v, w.report!);
    const params: ReportRunParams = { dateRange: f.dateRange, orgUnitId: f.orgUnitId };
    if (w.type === 'kpi') return this.kpi(v, entry.def, w, params);
    const def: ReportDef =
      w.type === 'chart' && w.chart ? { ...entry.def, chart: w.chart } : entry.def;
    const result = await this.catalog.run(v, def, {
      ...params,
      page: 1,
      pageSize: w.type === 'list' ? (w.limit ?? 10) : 50,
    });
    if (w.type === 'list' && result.kind === 'groups') {
      return {
        kind: 'report',
        result: { ...result, rows: result.rows.slice(0, w.limit ?? 10), subtotals: [] },
      };
    }
    return { kind: 'report', result };
  }

  /** One number: an aggregate over all matching records, with the period before for comparison. */
  private async kpi(
    v: Viewer,
    report: ReportDef,
    w: DashboardWidget,
    params: ReportRunParams,
  ): Promise<WidgetData> {
    const index = w.kpi?.aggregate ?? 0;
    const aggregates = report.aggregates?.length ? report.aggregates : [{ fn: 'count' as const }];
    const def: ReportDef = {
      ...report,
      columns: [],
      groupBy: [],
      pivot: undefined,
      chart: undefined,
      aggregates,
    };
    const valueOf = (r: ReportResult) => (r.kind === 'groups' ? r.grandTotal[`a${index}`] : null);
    const current = await this.catalog.run(v, def, params);
    const column =
      current.kind === 'groups' ? current.columns.find((c) => c.key === `a${index}`) : undefined;
    if (!w.kpi?.compare) return { kind: 'kpi', value: valueOf(current), column };
    // The period before: of the dashboard's date range, or of the report's relative date filter.
    let prevDef = def;
    let prevParams: ReportRunParams | undefined;
    if (params.dateRange) {
      const prev = previousRange({
        from: params.dateRange.from,
        to: addDays(params.dateRange.to, 1),
      });
      prevParams = { ...params, dateRange: { from: prev.from, to: addDays(prev.to, -1) } };
    } else {
      const i = def.filters.findIndex((x) => x.op === 'relative' && x.relative);
      if (i >= 0) {
        const cfg = await this.catalog.config();
        const f = def.filters[i];
        const range = resolveRelative(f.relative!.period, {
          timezone: cfg.tenant.timezone ?? 'UTC',
          fyStartMonth: cfg.settings.fiscalYearStartMonth,
          n: f.relative!.n,
          now: this.clock.now(),
        });
        const prev = previousRange(range);
        const filters = [...def.filters];
        filters[i] = { path: f.path, op: 'between', value: [prev.from, addDays(prev.to, -1)] };
        prevDef = { ...def, filters };
        prevParams = params;
      }
    }
    if (!prevParams) return { kind: 'kpi', value: valueOf(current), column };
    const previous = await this.catalog.run(v, prevDef, prevParams);
    return { kind: 'kpi', value: valueOf(current), previous: valueOf(previous), column };
  }

  // ---- personal dashboards ----

  private async check(v: Viewer, body: unknown): Promise<DashboardDef> {
    if (!hasPermission({ acl: v.acl }, 'reports.personal'))
      throw AppError.forbidden('Missing permission: reports.personal');
    const parsed = dashboardSchema.safeParse({ key: 'personal', ...(body as object) });
    if (!parsed.success) {
      throw AppError.badRequest(
        'Please correct the dashboard',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const def = {
      ...(parsed.data as DashboardDef),
      key: 'personal',
      roleIds: undefined,
      home: false,
    };
    // Widgets can only show reports their owner can see.
    for (const w of def.widgets) {
      if (w.report) await this.catalog.get(v, w.report);
    }
    return def;
  }

  async create(v: Viewer, body: unknown) {
    const def = await this.check(v, body);
    const [doc] = await (
      await this.personal()
    ).create([{ ownerId: v.userId, def, sharedRoleIds: [] }]);
    return this.personalEntry(doc.toObject() as PersonalDashboard, v);
  }

  private async own(v: Viewer, id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Dashboard');
    const P = await this.personal();
    const doc = await P.findById(id).lean<PersonalDashboard>();
    if (!doc || doc.ownerId !== v.userId) throw AppError.notFound('Dashboard');
    return P;
  }

  async update(v: Viewer, id: string, body: unknown) {
    const P = await this.own(v, id);
    await P.updateOne({ _id: id }, { $set: { def: await this.check(v, body) } });
    return this.get(v, `my:${id}`);
  }

  async remove(v: Viewer, id: string) {
    const P = await this.own(v, id);
    await P.deleteOne({ _id: id });
    return { deleted: true };
  }

  async share(v: Viewer, id: string, roleIds: string[]) {
    if (!hasPermission({ acl: v.acl }, 'reports.share'))
      throw AppError.forbidden('Missing permission: reports.share');
    const P = await this.own(v, id);
    await P.updateOne({ _id: id }, { $set: { sharedRoleIds: [...new Set(roleIds)] } });
    return this.get(v, `my:${id}`);
  }
}
