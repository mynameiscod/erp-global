import { Schema, type Types } from 'mongoose';
import type { Permission } from '@erp/contracts';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export interface Role {
  _id: Types.ObjectId;
  tenantId: string;
  name: string;
  description?: string;
  permissions: Permission[];
  /** System roles are created at sign-up and cannot be edited or deleted. */
  system: boolean;
  /** Tenant Admin: always holds every tenant permission, including ones added in later releases. */
  allPermissions: boolean;
  key?: string;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<Role>(
  {
    name: { type: String, required: true },
    description: String,
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false },
    allPermissions: { type: Boolean, default: false },
    key: String,
  },
  { collection: 'roles', timestamps: true, versionKey: false },
);
roleSchema.plugin(tenantPlugin);
roleSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
roleSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { key: { $type: 'string' } } },
);

export const RoleModel: ModelDef<Role> = { name: 'Role', schema: roleSchema };

export interface Assignment {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  roleId: string;
  orgUnitId: string;
  /** Copy of the org unit path; kept current from org.unit.moved events. */
  orgUnitPath: string;
  createdAt: Date;
}

const assignmentSchema = new Schema<Assignment>(
  {
    userId: { type: String, required: true },
    roleId: { type: String, required: true },
    orgUnitId: { type: String, required: true },
    orgUnitPath: { type: String, required: true },
  },
  {
    collection: 'assignments',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);
assignmentSchema.plugin(tenantPlugin);
assignmentSchema.index({ tenantId: 1, userId: 1, roleId: 1, orgUnitId: 1 }, { unique: true });
assignmentSchema.index({ tenantId: 1, roleId: 1 });
assignmentSchema.index({ tenantId: 1, orgUnitPath: 1 });

export const AssignmentModel: ModelDef<Assignment> = {
  name: 'Assignment',
  schema: assignmentSchema,
};
