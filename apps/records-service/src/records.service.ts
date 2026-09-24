import { Inject, Injectable } from '@nestjs/common';
import { Types, type ClientSession, type Connection, type SortOrder } from 'mongoose';
import {
  EventTypes,
  hasPermission,
  recordPermission,
  scopePathsFor,
  type RecordAction,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  activeFields,
  findEntity,
  isEmpty,
  SYSTEM_COLUMNS,
  validateRecord,
  type EntityDef,
  type RecordData,
  type RecordIssue,
} from '@erp/metadata';
import {
  AppError,
  MONGO_CONNECTION,
  TENANT_DATABASES,
  UpstreamError,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients, type OrgUnitInfo } from './clients';
import { RecordModel, UniqueModel, type RecordDoc } from './models';
import { fromStorage, toStorage, uniqueKey } from './storage';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID_RE = /^[a-f0-9]{24}$/;
/** Records of entities that are not org-scoped live at the top of the org tree for every user. */
const COMPANY_PATH = '/';

export interface ListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  filter?: Record<string, unknown>;
  orgUnitId?: string;
}

export interface WriteBody {
  orgUnitId?: string | null;
  data: Record<string, unknown>;
}

function invalid(issues: RecordIssue[]): AppError {
  return AppError.badRequest(
    'Please correct the highlighted fields',
    issues.map((i) => ({ path: i.field, message: i.message })),
  );
}

@Injectable()
export class RecordsService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
  ) {}

  private records() {
    return this.dbs.model(RecordModel);
  }
  private uniques() {
    return this.dbs.model(UniqueModel);
  }

  // ---- helpers ----

  private claims() {
    const ctx = requireContext();
    return { acl: ctx.acl ?? [], plat: ctx.plat };
  }

  private assertAllowed(entity: EntityDef, action: RecordAction, orgPath?: string): void {
    const path = entity.orgScoped === false ? undefined : orgPath;
    if (!hasPermission(this.claims(), recordPermission(entity.key, action), path)) {
      throw AppError.forbidden(
        path
          ? 'You cannot do this for this organization unit'
          : `You do not have permission to ${action} this`,
      );
    }
  }

  private async entity(
    key: string,
    orgPath?: string,
  ): Promise<{ entity: EntityDef; cfg: EffectiveConfigResponse }> {
    const cfg = await this.clients.config.effective(orgPath);
    const entity = findEntity(cfg, key);
    if (!entity || entity.kind !== 'custom' || entity.archived) throw AppError.notFound('Entity');
    return { entity, cfg };
  }

  private async unit(id: string): Promise<OrgUnitInfo> {
    if (!ID_RE.test(id)) throw AppError.badRequest('Invalid organization unit');
    try {
      const u = await this.clients.org.get<OrgUnitInfo>(`/internal/org/units/${id}`);
      if (u.status !== 'active') throw AppError.badRequest('Organization unit is inactive');
      return u;
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        throw AppError.notFound('Organization unit');
      throw e;
    }
  }

  private async load(key: string, id: string): Promise<RecordDoc> {
    if (!ID_RE.test(id)) throw AppError.notFound('Record');
    const doc = await (
      await this.records()
    )
      .findOne({ _id: id, entity: key, deletedAt: null })
      .lean<RecordDoc>();
    if (!doc) throw AppError.notFound('Record');
    return doc;
  }

  private toDto(doc: RecordDoc, entity?: EntityDef) {
    return {
      id: String(doc._id),
      entity: doc.entity,
      number: doc.number ?? null,
      data: fromStorage(entity, doc.data),
      orgUnitId: doc.orgUnitId,
      configVersion: doc.configVersion,
      createdBy: doc.createdBy,
      updatedBy: doc.updatedBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /** Lookups must point at things that exist in this tenant; files must be this tenant's. */
  private async checkReferences(
    entity: EntityDef,
    data: RecordData,
    keys: Iterable<string>,
  ): Promise<RecordIssue[]> {
    const issues: RecordIssue[] = [];
    const fields = new Map(entity.fields.map((f) => [f.key, f]));
    const Records = await this.records();
    for (const key of keys) {
      const f = fields.get(key);
      const value = data[key];
      if (!f || isEmpty(value)) continue;
      const ids = (Array.isArray(value) ? value : [value]) as string[];
      try {
        if (f.type === 'lookup' || f.type === 'lookup_many') {
          if (f.target === 'user') {
            await Promise.all(ids.map((id) => this.clients.identity.get(`/internal/users/${id}`)));
          } else if (f.target === 'org_unit') {
            await Promise.all(ids.map((id) => this.clients.org.get(`/internal/org/units/${id}`)));
          } else {
            const found = await Records.countDocuments({
              _id: { $in: ids },
              entity: f.target,
              deletedAt: null,
            });
            if (found !== ids.length)
              issues.push({ field: key, message: 'Linked record not found' });
          }
        } else if (f.type === 'file' || f.type === 'image') {
          const metas = await Promise.all(
            ids.map((id) =>
              this.clients.files.get<{ contentType: string; size: number }>(
                `/internal/files/${id}`,
              ),
            ),
          );
          for (const m of metas) {
            const accepted = (a: string) =>
              a.endsWith('/*') ? m.contentType.startsWith(a.slice(0, -1)) : m.contentType === a;
            if (f.type === 'image' && !m.contentType.startsWith('image/')) {
              issues.push({ field: key, message: 'Must be an image' });
            } else if (f.accept?.length && !f.accept.some(accepted)) {
              issues.push({ field: key, message: 'This type of file is not allowed here' });
            } else if (f.maxSizeMb && m.size > f.maxSizeMb * 1024 * 1024) {
              issues.push({ field: key, message: `Files can be at most ${f.maxSizeMb} MB here` });
            }
          }
        }
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 404)
          issues.push({ field: key, message: 'Linked item not found' });
        else throw e;
      }
    }
    return issues;
  }

  private async writeUniques(
    entity: EntityDef,
    recordId: string,
    before: RecordData,
    after: RecordData,
    session: ClientSession,
  ): Promise<void> {
    const Uniques = await this.uniques();
    for (const f of entity.fields.filter((x) => x.unique)) {
      const was = isEmpty(before[f.key]) ? undefined : uniqueKey(before[f.key]);
      const now = isEmpty(after[f.key]) ? undefined : uniqueKey(after[f.key]);
      if (was === now) continue;
      if (was !== undefined)
        await Uniques.deleteOne(
          { entity: entity.key, field: f.key, value: was, recordId },
          { session },
        );
      if (now !== undefined) {
        await Uniques.create([{ entity: entity.key, field: f.key, value: now, recordId }], {
          session,
        }).catch((e: { code?: number }) => {
          if (e.code === 11000)
            throw invalid([
              { field: f.key, message: 'This value is already used by another record' },
            ]);
          throw e;
        });
      }
    }
  }

  private changes(
    before: RecordData,
    after: RecordData,
  ): Record<string, { from?: unknown; to?: unknown }> {
    const out: Record<string, { from?: unknown; to?: unknown }> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
        out[k] = { from: before[k] ?? null, to: after[k] ?? null };
    }
    return out;
  }

  // ---- queries ----

  async list(key: string, q: ListQuery) {
    const scopeUnit = q.orgUnitId ? await this.unit(q.orgUnitId) : undefined;
    const { entity } = await this.entity(key, scopeUnit?.path);
    const filter: Record<string, unknown> = { entity: key, deletedAt: null };
    if (entity.orgScoped !== false) {
      const scopes = scopePathsFor(this.claims(), recordPermission(key, 'read'));
      if (!scopes.length) throw AppError.forbidden('You do not have permission to read this');
      const allowed = scopeUnit
        ? scopes.some((s) => scopeUnit.path.startsWith(s))
          ? [scopeUnit.path]
          : []
        : scopes;
      if (!allowed.length)
        throw AppError.forbidden('This organization unit is outside your access');
      filter.$or = allowed.map((p) => ({ orgPath: { $regex: `^${escapeRegex(p)}` } }));
    } else {
      this.assertAllowed(entity, 'read');
    }

    const fields = new Map(entity.fields.map((f) => [f.key, f]));
    for (const [k, v] of Object.entries(q.filter ?? {})) {
      if (!fields.has(k)) throw AppError.badRequest(`Unknown filter field "${k}"`);
      filter[`data.${k}`] = v;
    }
    if (q.q) {
      const re = { $regex: escapeRegex(q.q.slice(0, 100)), $options: 'i' };
      const searchable = entity.fields.filter(
        (f) =>
          (f.searchable || f.key === entity.titleField) &&
          ['text', 'email', 'phone', 'autonumber'].includes(f.type),
      );
      const or = [{ number: re }, ...searchable.map((f) => ({ [`data.${f.key}`]: re }))];
      filter.$and = [{ $or: or }];
    }

    let sort: Record<string, SortOrder> = { createdAt: -1 };
    if (q.sort) {
      const [field, dir] = q.sort.split(':');
      const f = fields.get(field);
      if (!(SYSTEM_COLUMNS as readonly string[]).includes(field) && !f)
        throw AppError.badRequest(`Unknown sort field "${field}"`);
      const path = f ? (f.type === 'currency' ? `data.${field}.amount` : `data.${field}`) : field;
      sort = { [path]: dir === 'asc' ? 1 : -1, _id: -1 };
    }

    const Records = await this.records();
    const [items, total] = await Promise.all([
      Records.find(filter)
        .sort(sort)
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<RecordDoc[]>(),
      Records.countDocuments(filter),
    ]);
    return {
      items: items.map((d) => this.toDto(d, entity)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(key: string, id: string) {
    const doc = await this.load(key, id);
    const { entity } = await this.entity(
      key,
      doc.orgPath === COMPANY_PATH ? undefined : doc.orgPath,
    );
    this.assertAllowed(entity, 'read', doc.orgPath);
    return this.toDto(doc, entity);
  }

  /** Small list for lookup pickers: id, number and title. */
  async lookup(key: string, q?: string) {
    const page = await this.list(key, { page: 1, pageSize: 20, q });
    const { entity } = await this.entity(key);
    return page.items.map((r) => ({
      id: r.id,
      number: r.number,
      title: String((entity.titleField && r.data[entity.titleField]) ?? r.number ?? r.id),
    }));
  }

  // ---- commands ----

  async create(key: string, body: WriteBody) {
    const { entity: companyEntity } = await this.entity(key);
    const orgScoped = companyEntity.orgScoped !== false;
    if (orgScoped && !body.orgUnitId)
      throw invalid([{ field: 'orgUnitId', message: 'Choose where this record belongs' }]);
    const unit = orgScoped ? await this.unit(body.orgUnitId!) : undefined;
    const orgPath = unit?.path ?? COMPANY_PATH;
    const { entity, cfg } = await this.entity(key, unit?.path);
    this.assertAllowed(entity, 'create', orgPath);

    const { data, issues } = validateRecord(entity, body.data, {
      cfg,
      companyCurrency: cfg.tenant.currency,
    });
    if (issues.length) throw invalid(issues);
    const refIssues = await this.checkReferences(entity, data, Object.keys(data));
    if (refIssues.length) throw invalid(refIssues);

    // Auto-numbers are allocated last, only for records that passed validation.
    let number: string | undefined;
    for (const f of activeFields(entity).filter((x) => x.type === 'autonumber')) {
      const res = await this.clients.configApi.post<{ number: string }>(
        '/internal/config/numbering/next',
        {
          series: f.numbering,
          ...(unit ? { orgUnitId: unit.id, orgPath: unit.path, orgCode: unit.code } : {}),
        },
      );
      data[f.key] = res.number;
      number ??= res.number;
    }

    const Records = await this.records();
    const id = new Types.ObjectId();
    const actor = requireContext().actor!.id;
    await this.conn.transaction(async (session) => {
      await Records.create(
        [
          {
            _id: id,
            entity: key,
            number,
            data: toStorage(entity, data),
            orgUnitId: unit?.id ?? null,
            orgPath,
            configVersion: cfg.version,
            createdBy: actor,
            updatedBy: actor,
          },
        ],
        { session },
      );
      await this.writeUniques(entity, String(id), {}, data, session);
      await this.outbox.record(
        EventTypes.RecordCreated,
        {
          entity: key,
          recordId: String(id),
          number: number ?? null,
          orgUnitId: unit?.id ?? null,
          changes: this.changes({}, data),
        },
        { session },
      );
    });
    return this.get(key, String(id));
  }

  async update(key: string, id: string, body: WriteBody) {
    const doc = await this.load(key, id);
    const { entity: current } = await this.entity(
      key,
      doc.orgPath === COMPANY_PATH ? undefined : doc.orgPath,
    );
    this.assertAllowed(current, 'update', doc.orgPath);

    let unit: OrgUnitInfo | undefined;
    let orgPath = doc.orgPath;
    if (body.orgUnitId && body.orgUnitId !== doc.orgUnitId && current.orgScoped !== false) {
      unit = await this.unit(body.orgUnitId);
      orgPath = unit.path;
      this.assertAllowed(current, 'create', orgPath);
    }
    const { entity, cfg } = await this.entity(key, orgPath === COMPANY_PATH ? undefined : orgPath);
    const before = fromStorage(entity, doc.data);
    const { data, issues } = validateRecord(
      entity,
      body.data,
      { cfg, companyCurrency: cfg.tenant.currency },
      before,
    );
    if (issues.length) throw invalid(issues);
    const changed = this.changes(before, data);
    const refIssues = await this.checkReferences(entity, data, Object.keys(changed));
    if (refIssues.length) throw invalid(refIssues);
    if (!Object.keys(changed).length && !unit) return this.toDto(doc, entity);

    const Records = await this.records();
    const actor = requireContext().actor!.id;
    await this.conn.transaction(async (session) => {
      await Records.updateOne(
        { _id: doc._id, updatedAt: doc.updatedAt },
        {
          $set: {
            data: toStorage(entity, data),
            updatedBy: actor,
            configVersion: cfg.version,
            ...(unit ? { orgUnitId: unit.id, orgPath: unit.path } : {}),
          },
        },
        { session },
      ).then((r) => {
        if (r.modifiedCount !== 1)
          throw AppError.conflict('Someone else changed this record. Reload and try again.');
      });
      await this.writeUniques(entity, id, before, data, session);
      await this.outbox.record(
        EventTypes.RecordUpdated,
        {
          entity: key,
          recordId: id,
          number: doc.number ?? null,
          orgUnitId: unit?.id ?? doc.orgUnitId,
          changes: changed,
        },
        { session },
      );
    });
    return this.get(key, id);
  }

  async remove(key: string, id: string) {
    const doc = await this.load(key, id);
    const { entity } = await this.entity(
      key,
      doc.orgPath === COMPANY_PATH ? undefined : doc.orgPath,
    );
    this.assertAllowed(entity, 'delete', doc.orgPath);
    const [Records, Uniques] = await Promise.all([this.records(), this.uniques()]);
    await this.conn.transaction(async (session) => {
      await Records.updateOne(
        { _id: doc._id },
        { $set: { deletedAt: new Date(), updatedBy: requireContext().actor!.id } },
        { session },
      );
      await Uniques.deleteMany({ recordId: id }, { session });
      await this.outbox.record(
        EventTypes.RecordDeleted,
        { entity: key, recordId: id, number: doc.number ?? null, orgUnitId: doc.orgUnitId },
        { session },
      );
    });
    return { deleted: true };
  }

  /** Keeps record paths in step with org moves. */
  async applyOrgMove(oldPath: string, newPath: string, session: ClientSession) {
    const Records = await this.records();
    await Records.updateMany(
      { orgPath: { $regex: `^${escapeRegex(oldPath)}` } },
      [
        {
          $set: {
            orgPath: { $concat: [newPath, { $substrCP: ['$orgPath', oldPath.length, 100000] }] },
          },
        },
      ],
      { session },
    );
  }
}
