import { Schema, type Types } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export interface OrgUnit {
  _id: Types.ObjectId;
  tenantId: string;
  name: string;
  code?: string;
  /** Client-defined level label: Company, Region, Branch, Campus, Department... */
  type: string;
  parentId: string | null;
  /** Materialized path of ids, e.g. `/root/region/branch/`. Always ends with the unit's own id. */
  path: string;
  depth: number;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<OrgUnit>(
  {
    name: { type: String, required: true },
    code: { type: String },
    type: { type: String, required: true },
    parentId: { type: String, default: null },
    path: { type: String, required: true },
    depth: { type: Number, required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { collection: 'org_units', timestamps: true, versionKey: false },
);
schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, path: 1 }, { unique: true });
schema.index({ tenantId: 1, parentId: 1 });
schema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } },
);

export const OrgUnitModel: ModelDef<OrgUnit> = { name: 'OrgUnit', schema };

export function toOrgUnitDto(u: OrgUnit) {
  return {
    id: String(u._id),
    name: u.name,
    code: u.code ?? null,
    type: u.type,
    parentId: u.parentId,
    path: u.path,
    depth: u.depth,
    status: u.status,
  };
}
export type OrgUnitDto = ReturnType<typeof toOrgUnitDto>;
