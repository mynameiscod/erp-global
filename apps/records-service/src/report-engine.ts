import { Inject, Injectable } from '@nestjs/common';
import { Types, type Model, type PipelineStage } from 'mongoose';
import { hasPermission, recordPermission, scopePathsFor, type AclEntry } from '@erp/contracts';
import {
  bucketRange,
  checkPersonalReport,
  findEntity,
  resolveRelative,
  resolveReportPath,
  reportPathLabel,
  pickText,
  zonedDayStart,
  type AggregateFn,
  type DateBucket,
  type EffectiveConfig,
  type FilterValue,
  type GroupRow,
  type ReportAggregate,
  type ReportDef,
  type ReportFilter,
  type ReportGroup,
  type ReportResult,
  type ReportRunParams,
  type ResolvedPath,
  type ResultColumn,
} from '@erp/metadata';
import {
  AppError,
  TENANT_DATABASES,
  UpstreamError,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireTenantId, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients, type OrgUnitInfo } from './clients';
import { Labeler, labelKindFor, type LabelKind } from './labels';
import { RecordModel, type RecordDoc } from './models';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface RunRequest {
  report: ReportDef;
  params: ReportRunParams;
  /** The viewer's access: from their token, or looked up for a scheduled recipient. */
  acl: AclEntry[];
  lang: string;
  /** Exports read bigger pages and may run longer. */
  purpose: 'view' | 'export';
}

const LIMITS = {
  view: { pageSize: 500, maxTimeMS: 10_000 },
  export: { pageSize: 5_000, maxTimeMS: 60_000 },
};
const MAX_GROUPS = 5_000;
const MAX_PIVOT_COLUMNS = 200;

const SYSTEM_DOC_PATHS: Record<string, string> = {
  number: 'number',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  createdBy: 'createdBy',
  updatedBy: 'updatedBy',
  orgUnitId: 'orgUnitId',
};

const FN_LABELS: Record<AggregateFn, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  count_distinct: 'Distinct count',
};

interface PathInfo {
  res: ResolvedPath;
  /** Where the value is in the (joined) document, e.g. `data.amount.amount`, `_j0_student.data.name`. */
  docPath: string;
  /** Join aliases this path needs, outermost first. */
  joins: string[];
  label: LabelKind | undefined;
}

interface Join {
  alias: string;
  /** 0 for a link on the report's entity, 1 for a link on a linked record. */
  hop: number;
  /** Expression for the linked record id, e.g. `$data.student`. */
  local: string;
  target: string;
}

/** Converts database values into plain JSON: numbers, strings, booleans, ISO dates. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Types.Decimal128) return Number(v.toString());
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Types.ObjectId) return String(v);
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('amount' in o && 'currency' in o) return plain(o.amount);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

@Injectable()
export class ReportEngine {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  async run(input: RunRequest): Promise<ReportResult> {
    let req = input;
    const cfg = await this.clients.config.effective();
    const report = req.report;
    const entity = findEntity(cfg, report.entity);
    if (!entity || entity.kind !== 'custom' || entity.archived) throw AppError.notFound('Entity');
    // Company reports are checked at publish; personal ones are checked here, on every run.
    const issues = checkPersonalReport(report, cfg.entities);
    if (issues.length) {
      throw AppError.badRequest(
        'This report no longer matches the configuration',
        issues.map((i) => ({ path: i.path, message: i.message })),
      );
    }
    if (req.params.records) {
      // The records behind a group: the report's columns, or its number, title, date and totals.
      const defaults = [
        'number',
        ...(entity.titleField ? [entity.titleField] : []),
        ...(report.dateField ? [report.dateField] : []),
        ...[...(report.aggregates ?? []), ...(report.pivot?.values ?? [])].flatMap((a) =>
          a.path ? [a.path] : [],
        ),
      ];
      req = {
        ...req,
        report: {
          ...report,
          groupBy: undefined,
          pivot: undefined,
          aggregates: undefined,
          chart: undefined,
          columns: report.columns.length
            ? report.columns
            : [...new Set(defaults)].map((path) => ({ path })),
        },
      };
    }
    const ctx = new RunContext(cfg, req, this.clients);
    const Records = await this.dbs.model(RecordModel);
    const base = await ctx.baseMatch(entity.orgScoped !== false);
    const def = req.report;

    if (def.pivot) return ctx.pivot(Records, base);
    // Totals without columns (a KPI) are a grouped report with no groups: the grand total.
    if (def.groupBy?.length || (def.aggregates?.length && !def.columns.length))
      return ctx.groups(Records, base);
    return ctx.rows(Records, base);
  }
}

/** Everything about one run: resolved paths, joins, filters and the steps to build. */
class RunContext {
  private readonly paths = new Map<string, PathInfo>();
  private readonly joins = new Map<string, Join>();
  private readonly tz: string;
  private readonly fy: number;
  private readonly report: ReportDef;
  private readonly limits: (typeof LIMITS)['view'];

  constructor(
    private readonly cfg: EffectiveConfigResponse,
    private readonly req: RunRequest,
    private readonly clients: Clients,
  ) {
    this.tz = cfg.tenant.timezone ?? 'UTC';
    this.fy = cfg.settings.fiscalYearStartMonth;
    this.report = req.report;
    this.limits = LIMITS[req.purpose];
  }

  private claims() {
    return { acl: this.req.acl };
  }

  // ---- access ----

  async baseMatch(orgScoped: boolean): Promise<Record<string, unknown>> {
    const key = this.report.entity;
    const match: Record<string, unknown> = { entity: key, deletedAt: null };
    if (!orgScoped) {
      if (!hasPermission(this.claims(), recordPermission(key, 'read')))
        throw AppError.forbidden('You do not have permission to read this');
      return match;
    }
    let scopes = scopePathsFor(this.claims(), recordPermission(key, 'read'));
    if (!scopes.length) throw AppError.forbidden('You do not have permission to read this');
    if (this.req.params.orgUnitId) {
      const unit = await this.unit(this.req.params.orgUnitId);
      // The unit itself if it is inside the viewer's access; else the parts of it that are.
      scopes = scopes.some((s) => unit.path.startsWith(s))
        ? [unit.path]
        : scopes.filter((s) => s.startsWith(unit.path));
      if (!scopes.length) throw AppError.forbidden('This organization unit is outside your access');
    }
    match.$or = scopes.map((p) => ({ orgPath: { $regex: `^${escapeRegex(p)}` } }));
    return match;
  }

  private async unit(id: string): Promise<OrgUnitInfo> {
    try {
      return await this.clients.org.get<OrgUnitInfo>(`/internal/org/units/${id}`);
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        throw AppError.notFound('Organization unit');
      throw e;
    }
  }

  // ---- paths and joins ----

  private path(path: string): PathInfo {
    const hit = this.paths.get(path);
    if (hit) return hit;
    const res = resolveReportPath(this.cfg.entities, this.report.entity, path);
    if (typeof res === 'string') throw AppError.badRequest(res);
    const joins: string[] = [];
    let prefix = '';
    res.hops.forEach((hop, i) => {
      const alias = `_j${i}_${res.hops
        .slice(0, i + 1)
        .map((h) => h.field.key)
        .join('_')}`;
      // Reading fields of linked records needs permission to read those records.
      if (!hasPermission(this.claims(), recordPermission(hop.target, 'read'))) {
        throw AppError.forbidden(
          `You cannot see ${hop.target} records, so "${path}" is not available`,
        );
      }
      if (!this.joins.has(alias)) {
        this.joins.set(alias, {
          alias,
          hop: i,
          local: `$${prefix}data.${hop.field.key}`,
          target: hop.target,
        });
      }
      joins.push(alias);
      prefix = `${alias}.`;
    });
    const docPath = res.system
      ? `${prefix}${SYSTEM_DOC_PATHS[res.system]}`
      : `${prefix}data.${res.field!.key}${res.field!.type === 'currency' ? '.amount' : ''}`;
    const info: PathInfo = {
      res,
      docPath,
      joins,
      label: labelKindFor(res.type, res.field, res.entity),
    };
    this.paths.set(path, info);
    return info;
  }

  private joinStages(aliases: Set<string>): PipelineStage[] {
    const tenantId = requireTenantId();
    // Each path lists every join it needs (first hop before second), so order by hop.
    const ordered = [...this.joins.values()]
      .filter((j) => aliases.has(j.alias))
      .sort((x, y) => x.hop - y.hop);
    return ordered.flatMap((j): PipelineStage[] => [
      {
        $lookup: {
          from: 'records',
          let: {
            rid: { $convert: { input: j.local, to: 'objectId', onError: null, onNull: null } },
          },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$rid'] } } },
            { $match: { tenantId, entity: j.target, deletedAt: null } },
            {
              $project: {
                data: 1,
                number: 1,
                status: 1,
                createdAt: 1,
                updatedAt: 1,
                createdBy: 1,
                updatedBy: 1,
                orgUnitId: 1,
              },
            },
          ],
          as: j.alias,
        },
      },
      { $set: { [j.alias]: { $first: `$${j.alias}` } } },
    ]);
  }

  // ---- filters ----

  private coerce(info: PathInfo, v: FilterValue): unknown {
    if (v === null) return null;
    const t = info.res.type;
    if (['integer', 'decimal', 'currency', 'percent', 'number'].includes(t)) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw AppError.badRequest(`"${String(v)}" is not a number`);
      return n;
    }
    if (t === 'boolean') return v === true || v === 'true';
    if (t === 'date') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
        throw AppError.badRequest('Use dates like 2026-09-30');
      return v;
    }
    return String(v);
  }

  /** A date bound for a date or date-time path; date-times use the company's time zone. */
  private dateBound(info: PathInfo, day: string): unknown {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw AppError.badRequest('Use dates like 2026-09-30');
    return info.res.type === 'date' ? day : zonedDayStart(day, this.tz);
  }

  private nextDay(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
  }

  private range(info: PathInfo, from: string, toExclusive: string) {
    return {
      [info.docPath]: { $gte: this.dateBound(info, from), $lt: this.dateBound(info, toExclusive) },
    };
  }

  private condition(f: ReportFilter): Record<string, unknown> | undefined {
    const info = this.path(f.path);
    const p = info.docPath;
    const isDateTime = info.res.type === 'datetime';
    const isDate = info.res.type === 'date' || isDateTime;
    const values = Array.isArray(f.value) ? f.value : [f.value ?? null];
    const one = values[0] ?? null;
    switch (f.op) {
      case 'empty':
        return { [p]: { $in: [null, '', []] } };
      case 'not_empty':
        return { [p]: { $nin: [null, '', []] } };
      case 'relative': {
        if (!f.relative) return undefined;
        const r = resolveRelative(f.relative.period, {
          timezone: this.tz,
          fyStartMonth: this.fy,
          n: f.relative.n,
        });
        return this.range(info, r.from, r.to);
      }
      case 'between': {
        const [a, b] = values;
        if (a === null || a === undefined || b === null || b === undefined) return undefined;
        if (isDate) return this.range(info, String(a), this.nextDay(String(b)));
        return { [p]: { $gte: this.coerce(info, a), $lte: this.coerce(info, b) } };
      }
      case 'in':
        return { [p]: { $in: values.map((v) => this.coerce(info, v)) } };
      case 'contains':
        if (one === null) return undefined;
        return { [p]: { $regex: escapeRegex(String(one).slice(0, 100)), $options: 'i' } };
      case 'eq':
      case 'ne': {
        if (one === null)
          return { [p]: f.op === 'eq' ? { $in: [null, '', []] } : { $nin: [null, '', []] } };
        if (isDateTime) {
          const day = String(one);
          const r = this.range(info, day, this.nextDay(day))[p];
          return f.op === 'eq'
            ? { [p]: r }
            : { $or: [{ [p]: { $lt: r.$gte } }, { [p]: { $gte: r.$lt } }] };
        }
        const v = this.coerce(info, one);
        return { [p]: f.op === 'eq' ? v : { $ne: v } };
      }
      default: {
        if (one === null) return undefined;
        const op = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' }[f.op]!;
        const v = isDate ? this.dateBound(info, String(one)) : this.coerce(info, one);
        return { [p]: { [op]: v } };
      }
    }
  }

  /** The report's filters with the viewer's changes, the dashboard range and drill-down. */
  private filters(): ReportFilter[] {
    const params = this.req.params;
    const out: ReportFilter[] = [];
    this.report.filters.forEach((f, i) => {
      const change = f.prompt ? params.filters?.[String(i)] : undefined;
      const merged = { ...f, ...(change ?? {}), path: f.path } as ReportFilter;
      // A prompt left empty means "any".
      const needsValue = !['empty', 'not_empty', 'relative'].includes(merged.op);
      const empty =
        merged.value === undefined ||
        merged.value === '' ||
        (Array.isArray(merged.value) && !merged.value.length);
      if (f.prompt && needsValue && empty) return;
      out.push(merged);
    });
    if (params.dateRange) {
      out.push({
        path: this.report.dateField ?? 'createdAt',
        op: 'between',
        value: [params.dateRange.from, params.dateRange.to],
      });
    }
    return out;
  }

  private drillConditions(): Record<string, unknown>[] {
    return (this.req.params.drill ?? []).map((d) => {
      const info = this.path(d.path);
      if (d.bucket && d.value !== null) {
        const r = bucketRange(String(d.value), d.bucket, this.fy);
        return this.range(info, r.from, r.to);
      }
      if (d.value === null) return { [info.docPath]: { $in: [null, '', []] } };
      return {
        [info.docPath]:
          info.res.type === 'datetime' ? new Date(String(d.value)) : this.coerce(info, d.value),
      };
    });
  }

  /**
   * The shared start of every query: scope, filters on the record itself, joins,
   * then filters on linked records.
   */
  private matchStages(base: Record<string, unknown>, extraPaths: string[]): PipelineStage[] {
    const pre: Record<string, unknown>[] = [];
    const post: Record<string, unknown>[] = [];
    const drill = this.drillConditions();
    const conds = [
      ...this.filters().map((f) => ({ path: f.path, cond: this.condition(f) })),
      ...(this.req.params.drill ?? []).map((d, i) => ({ path: d.path, cond: drill[i] })),
    ];
    for (const { path, cond } of conds) {
      if (!cond) continue;
      (this.path(path).joins.length ? post : pre).push(cond);
    }
    const aliases = new Set<string>();
    for (const p of [...conds.map((c) => c.path), ...extraPaths]) {
      for (const a of this.path(p).joins) aliases.add(a);
    }
    const stages: PipelineStage[] = [{ $match: pre.length ? { ...base, $and: pre } : base }];
    stages.push(...this.joinStages(aliases));
    if (post.length) stages.push({ $match: { $and: post } });
    return stages;
  }

  private async aggregate<T>(Records: Model<RecordDoc>, pipeline: PipelineStage[]): Promise<T[]> {
    try {
      return await Records.aggregate<T>(pipeline)
        .option({ maxTimeMS: this.limits.maxTimeMS, allowDiskUse: this.req.purpose === 'export' })
        .exec();
    } catch (e) {
      if ((e as { code?: number }).code === 50) {
        throw new AppError(
          422,
          'REPORT_TOO_SLOW',
          'The report took too long. Add filters (for example a date range) to narrow it down.',
        );
      }
      throw e;
    }
  }

  private labeler(Records: Model<RecordDoc>) {
    return new Labeler(this.cfg as EffectiveConfig, this.req.lang, this.clients, Records);
  }

  private column(key: string, info: PathInfo, label?: Record<string, string>): ResultColumn {
    const f = info.res.field;
    const currency =
      info.res.type === 'currency' ? (f?.currency ?? this.cfg.tenant.currency) : undefined;
    return {
      key,
      label: label ? pickText(label, this.req.lang) : reportPathLabel(info.res, this.req.lang),
      type: info.label ? 'text' : info.res.type,
      ...(currency ? { currency } : {}),
    };
  }

  // ---- rows ----

  async rows(Records: Model<RecordDoc>, base: Record<string, unknown>): Promise<ReportResult> {
    const report = this.report;
    const columns = report.columns.map((c, i) => ({
      key: `c${i}`,
      info: this.path(c.path),
      def: c,
    }));
    const sorts = (report.sort ?? []).map((s) => ({ info: this.path(s.path), dir: s.dir }));
    const stages = this.matchStages(base, [
      ...report.columns.map((c) => c.path),
      ...(report.sort ?? []).map((s) => s.path),
    ]);
    const pageSize = Math.min(this.req.params.pageSize ?? 100, this.limits.pageSize);
    const page = this.req.params.page ?? 1;
    const sort: Record<string, 1 | -1> = {};
    for (const s of sorts) sort[s.info.docPath] = s.dir === 'asc' ? 1 : -1;
    if (!sorts.length) sort.createdAt = -1;
    sort._id = -1;
    const project: Record<string, unknown> = {};
    for (const c of columns) project[c.key] = `$${c.info.docPath}`;

    const [docs, count] = await Promise.all([
      this.aggregate<Record<string, unknown>>(Records, [
        ...stages,
        { $sort: sort },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        { $project: project },
      ]),
      this.aggregate<{ n: number }>(Records, [...stages, { $count: 'n' }]),
    ]);
    const labels = this.labeler(Records);
    for (const d of docs) for (const c of columns) labels.add(c.info.label, plain(d[c.key]));
    await labels.resolve();
    return {
      kind: 'rows',
      columns: columns.map((c) => this.column(c.key, c.info, c.def.label)),
      rows: docs.map((d) => {
        const row: Record<string, unknown> = { __id: String(d._id) };
        for (const c of columns) {
          const v = plain(d[c.key]);
          row[c.key] = c.info.label ? labels.label(c.info.label, v) : v;
        }
        return row;
      }),
      total: count[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  // ---- groups ----

  private groupExpr(g: ReportGroup): unknown {
    const info = this.path(g.path);
    const value = `$${info.docPath}`;
    if (!g.bucket) return value;
    return bucketExpr(value, info.res.type === 'date', g.bucket, this.fy, this.tz);
  }

  private accumulator(a: ReportAggregate): Record<string, unknown> {
    if (a.fn === 'count') return { $sum: 1 };
    const expr = `$${this.path(a.path!).docPath}`;
    switch (a.fn) {
      case 'sum':
        return { $sum: expr };
      case 'avg':
        return { $avg: expr };
      case 'min':
        return { $min: expr };
      case 'max':
        return { $max: expr };
      case 'count_distinct':
        return { $addToSet: expr };
    }
  }

  private aggregateColumn(a: ReportAggregate, i: number): ResultColumn {
    const key = `a${i}`;
    if (a.fn === 'count' || a.fn === 'count_distinct') {
      const label = a.label
        ? pickText(a.label, this.req.lang)
        : a.fn === 'count'
          ? FN_LABELS.count
          : `${FN_LABELS.count_distinct} of ${reportPathLabel(this.path(a.path!).res, this.req.lang)}`;
      return { key, label, type: 'integer' };
    }
    const info = this.path(a.path!);
    const col = this.column(key, info, a.label);
    if (!a.label) col.label = `${FN_LABELS[a.fn]} of ${col.label}`;
    if (a.fn === 'avg' && col.type === 'integer') col.type = 'number';
    return col;
  }

  private values(doc: Record<string, unknown>, aggregates: ReportAggregate[]) {
    const out: Record<string, unknown> = {};
    aggregates.forEach((a, i) => {
      const v = doc[`a${i}`];
      out[`a${i}`] = a.fn === 'count_distinct' ? (Array.isArray(v) ? v.length : 0) : plain(v);
    });
    return out;
  }

  private groupStage(groups: ReportGroup[], aggregates: ReportAggregate[], keyPrefix = 'g') {
    const id: Record<string, unknown> = {};
    groups.forEach((g, i) => (id[`${keyPrefix}${i}`] = this.groupExpr(g)));
    const stage: Record<string, unknown> = { _id: groups.length ? id : null };
    aggregates.forEach((a, i) => (stage[`a${i}`] = this.accumulator(a)));
    return stage;
  }

  private async labelGroups(
    Records: Model<RecordDoc>,
    groups: ReportGroup[],
    rows: { keys: Record<string, unknown> }[],
    keyPrefix = 'g',
  ): Promise<(keys: Record<string, unknown>) => Record<string, string>> {
    const labels = this.labeler(Records);
    const kinds = groups.map((g) => (g.bucket ? undefined : this.path(g.path).label));
    for (const r of rows)
      groups.forEach((_, i) => labels.add(kinds[i], r.keys[`${keyPrefix}${i}`]));
    await labels.resolve();
    return (keys) =>
      Object.fromEntries(
        groups.map((_, i) => {
          const v = keys[`${keyPrefix}${i}`];
          return [
            `${keyPrefix}${i}`,
            v === null || v === undefined ? '' : labels.label(kinds[i], v),
          ];
        }),
      );
  }

  async groups(Records: Model<RecordDoc>, base: Record<string, unknown>): Promise<ReportResult> {
    const groups = this.report.groupBy ?? [];
    const aggregates = this.report.aggregates ?? [];
    const stages = this.matchStages(base, [
      ...groups.map((g) => g.path),
      ...aggregates.flatMap((a) => (a.path ? [a.path] : [])),
    ]);
    const sortOf = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`_id.g${i}`, 1 as const]));
    // One query per level (leaves, then each subtotal level) and one for the grand total, so
    // averages and distinct counts are right at every level.
    const levels = await Promise.all(
      groups.map((_, depth) =>
        this.aggregate<Record<string, unknown>>(Records, [
          ...stages,
          { $group: this.groupStage(groups.slice(0, depth + 1), aggregates) as never },
          { $sort: sortOf(depth + 1) },
          { $limit: MAX_GROUPS + 1 },
        ]),
      ),
    );
    const [grand] = await this.aggregate<Record<string, unknown>>(Records, [
      ...stages,
      { $group: this.groupStage([], aggregates) as never },
    ]);
    const toRow = (doc: Record<string, unknown>, level: number): GroupRow => ({
      level,
      keys: plain(doc._id) as Record<string, unknown>,
      labels: {},
      values: this.values(doc, aggregates),
    });
    const leaves = levels[levels.length - 1] ?? [];
    const truncated = leaves.length > MAX_GROUPS;
    const rows = leaves.slice(0, MAX_GROUPS).map((d) => toRow(d, 0));
    const subtotals = levels
      .slice(0, -1)
      .flatMap((docs, depth) =>
        docs.slice(0, MAX_GROUPS).map((d) => toRow(d, groups.length - 1 - depth)),
      );
    const label = await this.labelGroups(Records, groups, [...rows, ...subtotals]);
    for (const r of [...rows, ...subtotals]) r.labels = label(r.keys);
    return {
      kind: 'groups',
      columns: [
        ...groups.map((g, i) => ({
          key: `g${i}`,
          label:
            reportPathLabel(this.path(g.path).res, this.req.lang) +
            (g.bucket ? ` (${g.bucket.replace('_', ' ')})` : ''),
          type: g.bucket ? 'text' : this.column(`g${i}`, this.path(g.path)).type,
        })),
        ...aggregates.map((a, i) => this.aggregateColumn(a, i)),
      ],
      rows,
      subtotals,
      grandTotal: grand ? this.values(grand, aggregates) : this.values({}, aggregates),
      truncated,
    };
  }

  // ---- pivot ----

  async pivot(Records: Model<RecordDoc>, base: Record<string, unknown>): Promise<ReportResult> {
    const { rows: rowGroups, column, values } = this.report.pivot!;
    const stages = this.matchStages(base, [
      ...rowGroups.map((g) => g.path),
      column.path,
      ...values.flatMap((a) => (a.path ? [a.path] : [])),
    ]);
    const all = [...rowGroups, column];
    const colKey = `g${rowGroups.length}`;
    const [cells, rowTotals, colTotals, [grand]] = await Promise.all([
      this.aggregate<Record<string, unknown>>(Records, [
        ...stages,
        { $group: this.groupStage(all, values) as never },
        { $limit: MAX_GROUPS * 10 },
      ]),
      this.aggregate<Record<string, unknown>>(Records, [
        ...stages,
        { $group: this.groupStage(rowGroups, values) as never },
        { $sort: Object.fromEntries(rowGroups.map((_, i) => [`_id.g${i}`, 1 as const])) },
        { $limit: MAX_GROUPS + 1 },
      ]),
      this.aggregate<Record<string, unknown>>(Records, [
        ...stages,
        { $group: { ...this.groupStage([], values), _id: this.groupExpr(column) } as never },
        { $sort: { _id: 1 } },
        { $limit: MAX_PIVOT_COLUMNS + 1 },
      ]),
      this.aggregate<Record<string, unknown>>(Records, [
        ...stages,
        { $group: this.groupStage([], values) as never },
      ]),
    ]);
    const truncated = rowTotals.length > MAX_GROUPS || colTotals.length > MAX_PIVOT_COLUMNS;
    const colDocs = colTotals.slice(0, MAX_PIVOT_COLUMNS);
    const keyOf = (v: unknown) => (v === null || v === undefined ? '' : String(plain(v)));

    // Labels of the column values and of the row groups.
    const colLabeler = this.labeler(Records);
    const colKind = column.bucket ? undefined : this.path(column.path).label;
    for (const d of colDocs) colLabeler.add(colKind, plain(d._id));
    await colLabeler.resolve();
    const columnKeys = colDocs.map((d) => ({
      key: keyOf(d._id),
      label: d._id === null || d._id === undefined ? '—' : colLabeler.label(colKind, plain(d._id)),
    }));
    const wanted = new Set(columnKeys.map((c) => c.key));

    const byRow = new Map<
      string,
      NonNullable<Extract<ReportResult, { kind: 'pivot' }>['rows'][number]>
    >();
    for (const d of rowTotals.slice(0, MAX_GROUPS)) {
      const keys = plain(d._id) as Record<string, unknown>;
      byRow.set(JSON.stringify(keys), {
        keys,
        labels: {},
        cells: { __total: this.values(d, values) },
      });
    }
    for (const d of cells) {
      const id = plain(d._id) as Record<string, unknown>;
      const col = keyOf(id[colKey]);
      if (!wanted.has(col)) continue;
      const rowKeys = Object.fromEntries(rowGroups.map((_, i) => [`g${i}`, id[`g${i}`] ?? null]));
      const row = byRow.get(JSON.stringify(rowKeys));
      if (row) row.cells[col] = this.values(d, values);
    }
    const rows = [...byRow.values()];
    const label = await this.labelGroups(Records, rowGroups, rows);
    for (const r of rows) r.labels = label(r.keys);
    return {
      kind: 'pivot',
      rowColumns: rowGroups.map((g, i) => ({
        key: `g${i}`,
        label: reportPathLabel(this.path(g.path).res, this.req.lang),
        type: 'text',
      })),
      columnKeys,
      values: values.map((a, i) => this.aggregateColumn(a, i)),
      rows,
      columnTotals: Object.fromEntries(colDocs.map((d) => [keyOf(d._id), this.values(d, values)])),
      grandTotal: grand ? this.values(grand, values) : this.values({}, values),
      truncated,
    };
  }
}

/**
 * The group key of a date in the database; must produce the same keys as
 * `bucketKey` in @erp/metadata (tested together).
 */
export function bucketExpr(
  value: string,
  isDateString: boolean,
  bucket: DateBucket,
  fyStartMonth: number,
  timezone: string,
): unknown {
  const date = isDateString
    ? { $dateFromString: { dateString: value, format: '%Y-%m-%d', onError: null, onNull: null } }
    : value;
  const tz = isDateString ? 'UTC' : timezone;
  const fmt = (format: string) => ({ $dateToString: { date, format, timezone: tz, onNull: null } });
  const year = { $year: { date, timezone: tz } };
  const month = { $month: { date, timezone: tz } };
  const fyStart = { $cond: [{ $gte: [month, fyStartMonth] }, year, { $subtract: [year, 1] }] };
  const pad2 = (n: unknown) => ({
    $let: {
      vars: { s: { $toString: n } },
      in: { $cond: [{ $lt: [{ $strLenCP: '$$s' }, 2] }, { $concat: ['0', '$$s'] }, '$$s'] },
    },
  });
  const fyLabel =
    fyStartMonth === 1
      ? { $toString: fyStart }
      : { $concat: [{ $toString: fyStart }, '-', pad2({ $mod: [{ $add: [fyStart, 1] }, 100] })] };
  const guard = (expr: unknown) => ({ $cond: [{ $eq: [{ $type: date }, 'date'] }, expr, null] });
  switch (bucket) {
    case 'day':
      return fmt('%Y-%m-%d');
    case 'week':
      return fmt('%G-W%V');
    case 'month':
      return fmt('%Y-%m');
    case 'year':
      return fmt('%Y');
    case 'fiscal_year':
      return guard(fyLabel);
    case 'quarter': {
      const q = {
        $add: [
          {
            $floor: {
              $divide: [{ $mod: [{ $add: [{ $subtract: [month, fyStartMonth] }, 12] }, 12] }, 3],
            },
          },
          1,
        ],
      };
      return guard({ $concat: [fyLabel, ' Q', { $toString: q }] });
    }
  }
}
