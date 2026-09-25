import { Schema, type Types } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export interface RecordDoc {
  _id: Types.ObjectId;
  tenantId: string;
  entity: string;
  /** First auto-number of the record, for display and search. */
  number?: string;
  data: Record<string, unknown>;
  orgUnitId: string | null;
  /** Copy of the org unit path; kept current from org.unit.moved events. */
  orgPath: string;
  configVersion: number;
  /** Workflow state; null for entities without a workflow. */
  status?: string | null;
  /** Set by automations that create records, so a retried run does not create a second one. */
  sourceKey?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

const recordSchema = new Schema<RecordDoc>(
  {
    entity: { type: String, required: true },
    number: String,
    data: { type: Schema.Types.Mixed, default: {} },
    orgUnitId: { type: String, default: null },
    orgPath: { type: String, required: true },
    configVersion: { type: Number, required: true },
    status: { type: String, default: null },
    sourceKey: String,
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    deletedAt: Date,
  },
  { collection: 'records', timestamps: true, versionKey: false, minimize: false },
);
recordSchema.plugin(tenantPlugin);
recordSchema.index({ tenantId: 1, entity: 1, createdAt: -1 });
recordSchema.index({ tenantId: 1, entity: 1, orgPath: 1 });
recordSchema.index({ tenantId: 1, entity: 1, number: 1 });
recordSchema.index({ tenantId: 1, entity: 1, status: 1 });
recordSchema.index(
  { tenantId: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } },
);
// One index serves filters and sorts on any custom field, for every entity and tenant.
recordSchema.index({ tenantId: 1, entity: 1, 'data.$**': 1 });

export const RecordModel: ModelDef<RecordDoc> = { name: 'Record', schema: recordSchema };

/**
 * Values of unique fields. A unique index here enforces uniqueness per
 * (tenant, entity, field) without a database index per custom field.
 */
export interface UniqueDoc {
  tenantId: string;
  entity: string;
  field: string;
  value: string;
  recordId: string;
}

const uniqueSchema = new Schema<UniqueDoc>(
  {
    entity: { type: String, required: true },
    field: { type: String, required: true },
    value: { type: String, required: true },
    recordId: { type: String, required: true },
  },
  { collection: 'record_unique_values', versionKey: false },
);
uniqueSchema.plugin(tenantPlugin);
uniqueSchema.index({ tenantId: 1, entity: 1, field: 1, value: 1 }, { unique: true });
uniqueSchema.index({ tenantId: 1, recordId: 1 });

export const UniqueModel: ModelDef<UniqueDoc> = { name: 'UniqueValue', schema: uniqueSchema };
