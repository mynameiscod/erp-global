import { Inject, Injectable } from '@nestjs/common';
import { Types, type ClientSession, type Connection } from 'mongoose';
import {
  EventTypes,
  hasPermission,
  PERMISSIONS,
  scopePathsFor,
  TENANT_PERMISSION_KEYS,
  type AclEntry,
  type CreateAssignmentInput,
  type CreateRoleInput,
  type PermissionKey,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, TENANT_DATABASES, UpstreamError } from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { AssignmentModel, RoleModel, type Assignment, type Role } from './models';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const READ_PERMISSIONS = TENANT_PERMISSION_KEYS.filter((k) => k.endsWith('.read'));

function effectivePermissions(role: Pick<Role, 'permissions' | 'allPermissions'>): PermissionKey[] {
  return role.allPermissions ? [...TENANT_PERMISSION_KEYS] : role.permissions;
}

function toRoleDto(r: Role, assignmentCount?: number) {
  return {
    id: String(r._id),
    name: r.name,
    description: r.description ?? null,
    permissions: effectivePermissions(r),
    system: r.system,
    key: r.key ?? null,
    assignmentCount,
  };
}

function toAssignmentDto(a: Assignment, role?: Role) {
  return {
    id: String(a._id),
    userId: a.userId,
    roleId: a.roleId,
    roleName: role?.name ?? null,
    orgUnitId: a.orgUnitId,
    orgUnitPath: a.orgUnitPath,
    createdAt: a.createdAt,
  };
}

@Injectable()
export class AccessService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
  ) {}

  private roles() {
    return this.dbs.model(RoleModel);
  }
  private assignments() {
    return this.dbs.model(AssignmentModel);
  }

  private caller() {
    const ctx = requireContext();
    return { acl: ctx.acl ?? [], plat: ctx.plat };
  }

  /** Nobody can hand out permissions they do not hold themselves at that place. */
  private assertCanGrant(perms: PermissionKey[], path?: string): void {
    const caller = this.caller();
    const missing = perms.filter((p) => !hasPermission(caller, p, path));
    if (missing.length) {
      throw AppError.forbidden(
        `You cannot grant permissions you do not have: ${missing.join(', ')}`,
      );
    }
  }

  private async loadRole(id: string): Promise<Role> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Role');
    const role = await (await this.roles()).findById(id).lean();
    if (!role) throw AppError.notFound('Role');
    return role;
  }

  // ---- catalog and roles ----

  permissionCatalog() {
    return PERMISSIONS.filter((p) => p.scope === 'tenant');
  }

  async listRoles() {
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    const [roles, counts] = await Promise.all([
      Roles.find().sort({ system: -1, name: 1 }).lean(),
      Assignments.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$roleId', n: { $sum: 1 } } },
      ]),
    ]);
    const byRole = new Map(counts.map((c) => [c._id, c.n]));
    return roles.map((r) => toRoleDto(r, byRole.get(String(r._id)) ?? 0));
  }

  async createRole(input: CreateRoleInput) {
    const permissions = [...new Set(input.permissions)] as PermissionKey[];
    this.assertCanGrant(permissions);
    const Roles = await this.roles();
    const id = new Types.ObjectId();
    await this.conn.transaction(async (session) => {
      await Roles.create(
        [{ _id: id, name: input.name, description: input.description, permissions }],
        { session },
      ).catch((e: { code?: number }) => {
        if (e.code === 11000) throw AppError.conflict('A role with this name already exists');
        throw e;
      });
      await this.outbox.record(
        EventTypes.RoleCreated,
        { roleId: String(id), name: input.name, permissions },
        { session },
      );
    });
    return toRoleDto(await this.loadRole(String(id)));
  }

  async updateRole(id: string, input: Partial<CreateRoleInput>) {
    const role = await this.loadRole(id);
    if (role.system) throw AppError.forbidden('System roles cannot be changed');
    const set: Partial<Role> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (input.permissions !== undefined) {
      const next = [...new Set(input.permissions)] as PermissionKey[];
      // Adding or removing a permission changes what holders can do: the caller must hold both sets.
      this.assertCanGrant([...new Set([...next, ...role.permissions])]);
      set.permissions = next;
    }
    const Roles = await this.roles();
    await this.conn.transaction(async (session) => {
      await Roles.updateOne({ _id: role._id }, { $set: set }, { session }).catch(
        (e: { code?: number }) => {
          if (e.code === 11000) throw AppError.conflict('A role with this name already exists');
          throw e;
        },
      );
      await this.outbox.record(
        EventTypes.RoleUpdated,
        {
          roleId: id,
          changes: {
            ...(set.name !== undefined && { name: { from: role.name, to: set.name } }),
            ...(set.permissions && {
              permissions: {
                added: set.permissions.filter((p) => !role.permissions.includes(p)),
                removed: role.permissions.filter((p) => !set.permissions!.includes(p)),
              },
            }),
          },
        },
        { session },
      );
    });
    return toRoleDto(await this.loadRole(id));
  }

  async deleteRole(id: string) {
    const role = await this.loadRole(id);
    if (role.system) throw AppError.forbidden('System roles cannot be deleted');
    this.assertCanGrant(role.permissions);
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    if (await Assignments.exists({ roleId: id }))
      throw AppError.conflict('Remove this role from all users first');
    await this.conn.transaction(async (session) => {
      await Roles.deleteOne({ _id: role._id }, { session });
      await this.outbox.record(
        EventTypes.RoleDeleted,
        { roleId: id, name: role.name },
        { session },
      );
    });
    return { deleted: true };
  }

  // ---- assignments ----

  async listAssignments(filter: { userId?: string; orgUnitId?: string }) {
    const scopes = scopePathsFor(this.caller(), 'access.assignment.read');
    if (!scopes.length) return [];
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    const q: Record<string, unknown> = {
      $or: scopes.map((p) => ({ orgUnitPath: { $regex: `^${escapeRegex(p)}` } })),
    };
    if (filter.userId) q.userId = filter.userId;
    if (filter.orgUnitId) q.orgUnitId = filter.orgUnitId;
    const list = await Assignments.find(q).sort({ createdAt: 1 }).limit(1000).lean();
    const roles = new Map(
      (await Roles.find({ _id: { $in: [...new Set(list.map((a) => a.roleId))] } }).lean()).map(
        (r) => [String(r._id), r],
      ),
    );
    return list.map((a) => toAssignmentDto(a, roles.get(a.roleId)));
  }

  async createAssignment(input: CreateAssignmentInput) {
    const role = await this.loadRole(input.roleId);
    const unit = await this.clients.org
      .get<{ id: string; path: string; status: string }>(`/internal/org/units/${input.orgUnitId}`)
      .catch((e: unknown) => {
        if (e instanceof UpstreamError && e.status === 404)
          throw AppError.notFound('Organization unit');
        throw e;
      });
    if (unit.status !== 'active') throw AppError.badRequest('Organization unit is inactive');
    if (!hasPermission(this.caller(), 'access.assignment.manage', unit.path)) {
      throw AppError.forbidden('This organization unit is outside your access');
    }
    this.assertCanGrant(effectivePermissions(role), unit.path);
    const user = await this.clients.identity
      .get<{ id: string; status: string }>(`/internal/users/${input.userId}`)
      .catch((e: unknown) => {
        if (e instanceof UpstreamError && e.status === 404) throw AppError.notFound('User');
        throw e;
      });
    if (user.status === 'deactivated') throw AppError.badRequest('User is deactivated');

    const Assignments = await this.assignments();
    const id = new Types.ObjectId();
    await this.conn.transaction(async (session) => {
      await Assignments.create(
        [
          {
            _id: id,
            userId: input.userId,
            roleId: input.roleId,
            orgUnitId: unit.id,
            orgUnitPath: unit.path,
          },
        ],
        { session },
      ).catch((e: { code?: number }) => {
        if (e.code === 11000) throw AppError.conflict('This user already has this role here');
        throw e;
      });
      await this.outbox.record(
        EventTypes.AssignmentCreated,
        {
          assignmentId: String(id),
          userId: input.userId,
          roleId: input.roleId,
          roleName: role.name,
          orgUnitId: unit.id,
        },
        { session },
      );
    });
    const created = await Assignments.findById(id).lean();
    return toAssignmentDto(created!, role);
  }

  async removeAssignment(id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Assignment');
    const Assignments = await this.assignments();
    const a = await Assignments.findById(id).lean();
    if (!a) throw AppError.notFound('Assignment');
    if (!hasPermission(this.caller(), 'access.assignment.manage', a.orgUnitPath)) {
      throw AppError.forbidden('This organization unit is outside your access');
    }
    const role = await this.loadRole(a.roleId);
    this.assertCanGrant(effectivePermissions(role), a.orgUnitPath);
    const isRootLevel = a.orgUnitPath.split('/').length === 3;
    if (role.key === 'tenant_admin' && isRootLevel) {
      const rootAdmins = await Assignments.countDocuments({
        roleId: a.roleId,
        orgUnitPath: a.orgUnitPath,
      });
      if (rootAdmins <= 1) throw AppError.conflict('The last Tenant Admin cannot be removed');
    }
    await this.conn.transaction(async (session) => {
      await Assignments.deleteOne({ _id: a._id }, { session });
      await this.outbox.record(
        EventTypes.AssignmentRemoved,
        {
          assignmentId: id,
          userId: a.userId,
          roleId: a.roleId,
          roleName: role.name,
          orgUnitId: a.orgUnitId,
        },
        { session },
      );
    });
    return { deleted: true };
  }

  // ---- internal ----

  /** The ACL that identity-service puts into the user's access token. */
  async aclFor(userId: string): Promise<AclEntry[]> {
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    const list = await Assignments.find({ userId }).lean();
    if (!list.length) return [];
    const roles = new Map(
      (await Roles.find({ _id: { $in: [...new Set(list.map((a) => a.roleId))] } }).lean()).map(
        (r) => [String(r._id), r],
      ),
    );
    const byUnit = new Map<string, AclEntry>();
    for (const a of list) {
      const role = roles.get(a.roleId);
      if (!role) continue;
      const entry = byUnit.get(a.orgUnitId) ?? { ou: a.orgUnitId, path: a.orgUnitPath, p: [] };
      entry.p = [...new Set([...entry.p, ...effectivePermissions(role)])];
      byUnit.set(a.orgUnitId, entry);
    }
    return [...byUnit.values()];
  }

  async bootstrap(input: { adminUserId: string; rootOrgUnitId: string; rootPath: string }) {
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    await this.conn.transaction(async (session) => {
      const admin = await this.upsertSystemRole(Roles, session, 'tenant_admin', {
        name: 'Tenant Admin',
        description: 'Full access to everything in this company',
        permissions: [],
        allPermissions: true,
      });
      await this.upsertSystemRole(Roles, session, 'viewer', {
        name: 'Viewer',
        description: 'Read-only access',
        permissions: READ_PERMISSIONS,
        allPermissions: false,
      });
      const existing = await Assignments.findOne(
        { userId: input.adminUserId, roleId: String(admin._id) },
        null,
        { session },
      );
      if (!existing) {
        const [a] = await Assignments.create(
          [
            {
              userId: input.adminUserId,
              roleId: String(admin._id),
              orgUnitId: input.rootOrgUnitId,
              orgUnitPath: input.rootPath,
            },
          ],
          { session },
        );
        await this.outbox.record(
          EventTypes.AssignmentCreated,
          {
            assignmentId: String(a._id),
            userId: input.adminUserId,
            roleId: String(admin._id),
            roleName: 'Tenant Admin',
            orgUnitId: input.rootOrgUnitId,
          },
          { session },
        );
      }
    });
    return { ok: true };
  }

  private async upsertSystemRole(
    Roles: Awaited<ReturnType<AccessService['roles']>>,
    session: ClientSession,
    key: string,
    def: Pick<Role, 'name' | 'description' | 'permissions' | 'allPermissions'>,
  ) {
    const found = await Roles.findOne({ key }, null, { session }).lean();
    if (found) return found;
    const [role] = await Roles.create([{ ...def, key, system: true }], { session });
    await this.outbox.record(
      EventTypes.RoleCreated,
      {
        roleId: String(role._id),
        name: def.name,
        permissions: effectivePermissions(def),
        system: true,
      },
      { session },
    );
    return role.toObject();
  }

  async undoBootstrap() {
    const [Roles, Assignments] = await Promise.all([this.roles(), this.assignments()]);
    const a = await Assignments.deleteMany({});
    const r = await Roles.deleteMany({});
    return { deleted: a.deletedCount + r.deletedCount };
  }

  /** Keeps assignment paths in step with org moves. */
  async applyOrgMove(oldPath: string, newPath: string, session: ClientSession) {
    const Assignments = await this.assignments();
    await Assignments.updateMany(
      { orgUnitPath: { $regex: `^${escapeRegex(oldPath)}` } },
      [
        {
          $set: {
            orgUnitPath: {
              $concat: [newPath, { $substrCP: ['$orgUnitPath', oldPath.length, 100000] }],
            },
          },
        },
      ],
      { session },
    );
  }
}
