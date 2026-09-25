import { Inject, Injectable } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import {
  EventTypes,
  hasPermission,
  scopePathsFor,
  type CreateOrgUnitInput,
  type OrgUnitMovedPayload,
  type PermissionKey,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  AppError,
  MONGO_CONNECTION,
  TENANT_DATABASES,
  validateCustomFields,
} from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { OrgUnitModel, toOrgUnitDto, type OrgUnit } from './org-unit.model';

/** Deepest allowed hierarchy. Plenty for Group > Company > Region > ... > Team. */
export const MAX_DEPTH = 15;

const DEFAULT_TYPES = [
  'Company',
  'Division',
  'Region',
  'Branch',
  'Department',
  'Team',
  'Campus',
  'Store',
  'Clinic',
  'Warehouse',
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class OrgService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly outbox: OutboxWriter,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  private units() {
    return this.dbs.model(OrgUnitModel);
  }

  /** Throws unless the caller holds `perm` at `path` (or above it). */
  private assertScope(perm: PermissionKey, path: string): void {
    const ctx = requireContext();
    if (ctx.actor?.type === 'service') return;
    if (!hasPermission({ acl: ctx.acl ?? [], plat: ctx.plat }, perm, path)) {
      throw AppError.forbidden('This organization unit is outside your access');
    }
  }

  private async load(id: string): Promise<OrgUnit> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Organization unit');
    const unit = await (await this.units()).findById(id).lean();
    if (!unit) throw AppError.notFound('Organization unit');
    return unit;
  }

  // ---- queries ----

  /** Units the caller may see: every assigned unit and everything below it. */
  async list(includeInactive: boolean) {
    const ctx = requireContext();
    const scopes = scopePathsFor({ acl: ctx.acl ?? [] }, 'org.unit.read');
    if (!scopes.length) return [];
    const Units = await this.units();
    const filter: Record<string, unknown> = {
      $or: scopes.map((p) => ({ path: { $regex: `^${escapeRegex(p)}` } })),
    };
    if (!includeInactive) filter.status = 'active';
    const units = await Units.find(filter).sort({ path: 1 }).lean();
    return units.map(toOrgUnitDto);
  }

  async get(id: string) {
    const unit = await this.load(id);
    this.assertScope('org.unit.read', unit.path);
    return toOrgUnitDto(unit);
  }

  async types() {
    const used = (await (await this.units()).distinct('type')) as string[];
    return [...new Set([...DEFAULT_TYPES, ...used])];
  }

  // ---- commands ----

  async create(input: CreateOrgUnitInput) {
    const parent = await this.load(input.parentId);
    this.assertScope('org.unit.create', parent.path);
    if (parent.status !== 'active') throw AppError.badRequest('Parent unit is inactive');
    if (parent.depth + 1 >= MAX_DEPTH)
      throw AppError.badRequest(`Hierarchy cannot be deeper than ${MAX_DEPTH} levels`);

    const custom = await validateCustomFields(
      this.clients.config,
      'org_unit',
      input.custom,
      undefined,
      parent.path,
    );
    const Units = await this.units();
    const id = new Types.ObjectId();
    const doc = {
      _id: id,
      name: input.name,
      code: input.code || undefined,
      type: input.type,
      parentId: String(parent._id),
      path: `${parent.path}${String(id)}/`,
      depth: parent.depth + 1,
      status: 'active' as const,
      custom,
    };
    await this.conn.transaction(async (session) => {
      await Units.create([doc], { session }).catch((e: { code?: number }) => {
        if (e.code === 11000) throw AppError.conflict('Code already used by another unit');
        throw e;
      });
      await this.outbox.record(
        EventTypes.OrgUnitCreated,
        {
          unitId: String(id),
          parentId: doc.parentId,
          path: doc.path,
          name: doc.name,
          type: doc.type,
        },
        { session },
      );
    });
    return this.get(String(id));
  }

  async update(
    id: string,
    patch: {
      name?: string;
      code?: string;
      type?: string;
      custom?: Record<string, unknown>;
      headUserId?: string | null;
    },
  ) {
    const unit = await this.load(id);
    this.assertScope('org.unit.update', unit.path);
    const { headUserId, ...rest } = patch;
    const set: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const unset: Record<string, ''> = {};
    if (headUserId === null && unit.headUserId) unset.headUserId = '';
    if (headUserId && headUserId !== unit.headUserId) {
      const head = await this.clients.identity
        .get<{ status: string }>(`/internal/users/${headUserId}`)
        .catch(() => null);
      if (!head || head.status === 'deactivated')
        throw AppError.badRequest('Choose an active user as head');
      set.headUserId = headUserId;
    }
    if (set.custom !== undefined) {
      set.custom = await validateCustomFields(
        this.clients.config,
        'org_unit',
        set.custom as Record<string, unknown>,
        unit.custom ?? {},
        unit.path,
      );
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return toOrgUnitDto(unit);
    const Units = await this.units();
    await this.conn.transaction(async (session) => {
      await Units.updateOne(
        { _id: unit._id },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { session },
      ).catch((e: { code?: number }) => {
        if (e.code === 11000) throw AppError.conflict('Code already used by another unit');
        throw e;
      });
      await this.outbox.record(
        EventTypes.OrgUnitUpdated,
        {
          unitId: id,
          changes: Object.fromEntries(
            Object.entries({
              ...set,
              ...(unset.headUserId === '' ? { headUserId: null } : {}),
            }).map(([k, v]) => [
              k,
              { from: (unit as unknown as Record<string, unknown>)[k] ?? null, to: v },
            ]),
          ),
        },
        { session },
      );
    });
    return this.get(id);
  }

  /** Moves a unit and its whole subtree under a new parent. */
  async move(id: string, newParentId: string) {
    const unit = await this.load(id);
    if (!unit.parentId) throw AppError.badRequest('The top-level unit cannot be moved');
    const parent = await this.load(newParentId);
    this.assertScope('org.unit.move', unit.path);
    this.assertScope('org.unit.move', parent.path);
    if (parent.path.startsWith(unit.path))
      throw AppError.badRequest('A unit cannot be moved under itself');
    if (parent.status !== 'active') throw AppError.badRequest('Target parent is inactive');
    if (String(parent._id) === unit.parentId) return toOrgUnitDto(unit);

    const Units = await this.units();
    const oldPath = unit.path;
    const newPath = `${parent.path}${id}/`;
    const delta = parent.depth + 1 - unit.depth;
    const deepest = await Units.findOne({ path: { $regex: `^${escapeRegex(oldPath)}` } })
      .sort({ depth: -1 })
      .lean();
    if ((deepest?.depth ?? unit.depth) + delta >= MAX_DEPTH) {
      throw AppError.badRequest(`Hierarchy cannot be deeper than ${MAX_DEPTH} levels`);
    }

    await this.conn.transaction(async (session) => {
      await Units.updateMany(
        { path: { $regex: `^${escapeRegex(oldPath)}` } },
        [
          {
            $set: {
              path: { $concat: [newPath, { $substrCP: ['$path', oldPath.length, 100000] }] },
              depth: { $add: ['$depth', delta] },
            },
          },
        ],
        { session },
      );
      await Units.updateOne(
        { _id: unit._id },
        { $set: { parentId: String(parent._id) } },
        { session },
      );
      await this.outbox.record<OrgUnitMovedPayload>(
        EventTypes.OrgUnitMoved,
        { unitId: id, oldPath, newPath },
        { session },
      );
    });
    return this.get(id);
  }

  async deactivate(id: string) {
    const unit = await this.load(id);
    this.assertScope('org.unit.deactivate', unit.path);
    if (!unit.parentId) throw AppError.badRequest('The top-level unit cannot be deactivated');
    const Units = await this.units();
    if (await Units.exists({ parentId: id, status: 'active' })) {
      throw AppError.conflict('Deactivate or move the child units first');
    }
    await this.conn.transaction(async (session) => {
      await Units.updateOne({ _id: unit._id }, { $set: { status: 'inactive' } }, { session });
      await this.outbox.record(
        EventTypes.OrgUnitDeactivated,
        { unitId: id, path: unit.path },
        { session },
      );
    });
    return this.get(id);
  }

  // ---- internal (sign-up saga, other services) ----

  async bootstrap(name: string) {
    const Units = await this.units();
    const existing = await Units.findOne({ parentId: null }).lean();
    if (existing) return { rootUnitId: String(existing._id), rootPath: existing.path };
    const id = new Types.ObjectId();
    const path = `/${String(id)}/`;
    await this.conn.transaction(async (session) => {
      await Units.create(
        [{ _id: id, name, type: 'Company', parentId: null, path, depth: 0, status: 'active' }],
        { session },
      );
      await this.outbox.record(
        EventTypes.OrgUnitCreated,
        { unitId: String(id), parentId: null, path, name, type: 'Company' },
        { session },
      );
    });
    return { rootUnitId: String(id), rootPath: path };
  }

  async undoBootstrap() {
    const { deletedCount } = await (await this.units()).deleteMany({});
    return { deleted: deletedCount };
  }

  /** The unit and every unit above it, from the top of the tree down. */
  async internalAncestors(id: string) {
    const unit = await this.load(id);
    const ids = unit.path.split('/').filter(Boolean);
    const units = await (await this.units()).find({ _id: { $in: ids } }).lean();
    const byId = new Map(units.map((u) => [String(u._id), u]));
    return ids
      .map((i) => byId.get(i))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => ({
        id: String(u._id),
        name: u.name,
        code: u.code ?? null,
        path: u.path,
        headUserId: u.headUserId ?? null,
      }));
  }

  async internalGet(id: string) {
    const u = await this.load(id);
    return {
      id: String(u._id),
      name: u.name,
      code: u.code ?? null,
      path: u.path,
      status: u.status,
      headUserId: u.headUserId ?? null,
    };
  }
}
