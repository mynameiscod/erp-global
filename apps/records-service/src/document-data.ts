import { Inject, Injectable } from '@nestjs/common';
import { hasPermission, recordPermission, scopePathsFor, type AclEntry } from '@erp/contracts';
import { findEntity, type EntityDef, type FieldDef, type RecordData } from '@erp/metadata';
import { AppError, TENANT_DATABASES } from '@erp/service-kit';
import type { TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { RecordModel, type RecordDoc } from './models';
import { fromStorage } from './storage';

const ID_RE = /^[a-f0-9]{24}$/;
const COMPANY_PATH = '/';
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Rows of a "records that point here" table in one document. */
const MAX_RELATED = 500;

export interface DocumentRecord {
  id: string;
  entity: string;
  number: string | null;
  status: string | null;
  orgUnitId: string | null;
  orgPath: string;
  data: RecordData;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface DocumentData {
  records: DocumentRecord[];
  /** Records that lookups point to, by id, with their title. */
  links: Record<string, DocumentRecord & { title: string }>;
  users: Record<string, { name: string; email: string }>;
  units: Record<string, { name: string; code: string | null; custom: Record<string, unknown> }>;
  /** `related[recordId]["entity.field"]`: records of `entity` whose `field` points to the record. */
  related: Record<string, Record<string, DocumentRecord[]>>;
}

/**
 * Everything a print template reads, for records the user may read. Linked and
 * related records are included as the template's author chose, like any printed
 * document shows the customer's name on an invoice.
 */
@Injectable()
export class DocumentDataService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  async load(input: {
    entity: string;
    ids: string[];
    acl: AclEntry[];
    related?: { entity: string; field: string }[];
  }): Promise<DocumentData> {
    const cfg = await this.clients.config.effective();
    const entity = findEntity(cfg, input.entity);
    if (!entity || entity.kind !== 'custom') throw AppError.notFound('Entity');
    const ids = input.ids.filter((i) => ID_RE.test(i));
    const Records = await this.dbs.model(RecordModel);
    const docs = await Records.find({
      _id: { $in: ids },
      entity: input.entity,
      deletedAt: null,
    }).lean<RecordDoc[]>();
    if (docs.length !== new Set(input.ids).size) throw AppError.notFound('Record');
    const claims = { acl: input.acl };
    for (const d of docs) {
      const path = entity.orgScoped === false ? undefined : d.orgPath;
      if (!hasPermission(claims, recordPermission(input.entity, 'read'), path))
        throw AppError.forbidden('You do not have permission to read this');
    }
    const order = new Map(input.ids.map((id, i) => [id, i]));
    docs.sort((a, b) => order.get(String(a._id))! - order.get(String(b._id))!);
    // Branch overrides can add fields, so each record is read with the entity where it lives.
    const records = await Promise.all(
      docs.map(async (d) => {
        const here =
          d.orgPath && d.orgPath !== COMPANY_PATH
            ? findEntity(await this.clients.config.effective(d.orgPath), input.entity)
            : entity;
        return this.toRecord(d, here ?? entity);
      }),
    );

    // Related records: of another entity, pointing at each printed record.
    const related: DocumentData['related'] = {};
    const relatedDocs: { record: DocumentRecord; entity: EntityDef }[] = [];
    for (const rel of input.related ?? []) {
      const other = findEntity(cfg, rel.entity);
      const link = other?.fields.find((f) => f.key === rel.field);
      if (!other || link?.type !== 'lookup' || link.target !== input.entity) continue;
      const filter: Record<string, unknown> = {
        entity: rel.entity,
        deletedAt: null,
        [`data.${rel.field}`]: { $in: records.map((r) => r.id) },
      };
      if (other.orgScoped !== false) {
        const scopes = scopePathsFor(claims, recordPermission(rel.entity, 'read'));
        // Without access to those records the table stays empty rather than failing the print.
        if (!scopes.length) continue;
        filter.$or = scopes.map((p) => ({ orgPath: { $regex: `^${escapeRegex(p)}` } }));
      } else if (!hasPermission(claims, recordPermission(rel.entity, 'read'))) continue;
      const found = await Records.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .limit(MAX_RELATED * records.length)
        .lean<RecordDoc[]>();
      for (const d of found) {
        const r = this.toRecord(d, other);
        const owner = String(r.data[rel.field]);
        const key = `${rel.entity}.${rel.field}`;
        related[owner] ??= {};
        related[owner][key] ??= [];
        if (related[owner][key].length < MAX_RELATED) related[owner][key].push(r);
        relatedDocs.push({ record: r, entity: other });
      }
    }

    // Ids that lookups point to, from the records, their table rows and related records.
    const byTarget = new Map<string, Set<string>>();
    const collect = (fields: FieldDef[], data: RecordData) => {
      for (const f of fields) {
        const v = data[f.key];
        if (v === undefined || v === null) continue;
        if (f.type === 'table' && Array.isArray(v)) {
          for (const row of v) collect(f.columns ?? [], row as RecordData);
        } else if ((f.type === 'lookup' || f.type === 'lookup_many') && f.target) {
          let set = byTarget.get(f.target);
          if (!set) byTarget.set(f.target, (set = new Set()));
          for (const id of Array.isArray(v) ? v : [v]) set.add(String(id));
        }
      }
    };
    for (const r of records) collect(entity.fields, r.data);
    for (const { record, entity: e } of relatedDocs) collect(e.fields, record.data);
    const userIds = new Set([...(byTarget.get('user') ?? []), ...records.map((r) => r.createdBy)]);
    const unitIds = new Set([
      ...(byTarget.get('org_unit') ?? []),
      ...records.flatMap((r) => (r.orgUnitId ? [r.orgUnitId] : [])),
    ]);
    byTarget.delete('user');
    byTarget.delete('org_unit');

    const links: DocumentData['links'] = {};
    for (const [target, set] of byTarget) {
      const e = findEntity(cfg, target);
      if (!e) continue;
      const found = await Records.find({
        _id: { $in: [...set].filter((i) => ID_RE.test(i)) },
        entity: target,
        deletedAt: null,
      }).lean<RecordDoc[]>();
      for (const d of found) {
        const r = this.toRecord(d, e);
        const title = e.titleField ? r.data[e.titleField] : undefined;
        links[r.id] = { ...r, title: String(title ?? r.number ?? r.id) };
      }
    }
    const [users, units] = await Promise.all([
      userIds.size
        ? this.clients.identity.post<{ id: string; name: string; email: string }[]>(
            '/internal/users/batch',
            { ids: [...userIds] },
          )
        : [],
      unitIds.size
        ? this.clients.org.post<
            { id: string; name: string; code: string | null; custom?: Record<string, unknown> }[]
          >('/internal/org/units/batch', { ids: [...unitIds] })
        : [],
    ]);
    return {
      records,
      links,
      users: Object.fromEntries(users.map((u) => [u.id, { name: u.name, email: u.email }])),
      units: Object.fromEntries(
        units.map((u) => [u.id, { name: u.name, code: u.code, custom: u.custom ?? {} }]),
      ),
      related,
    };
  }

  private toRecord(d: RecordDoc, entity: EntityDef): DocumentRecord {
    return {
      id: String(d._id),
      entity: d.entity,
      number: d.number ?? null,
      status: d.status ?? null,
      orgUnitId: d.orgUnitId,
      orgPath: d.orgPath ?? COMPANY_PATH,
      data: fromStorage(entity, d.data),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
    };
  }
}
