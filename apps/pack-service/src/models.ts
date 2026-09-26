import { Schema, type Types } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

/** What happened to a pack in a company: the installation record the Packs page shows. */
export interface PackHistory {
  _id: Types.ObjectId;
  tenantId: string;
  packId: string;
  action: 'installed' | 'upgraded' | 'removed' | 'samples_added' | 'samples_removed';
  version: string;
  fromVersion?: string;
  by: string;
  at: Date;
}

const packHistorySchema = new Schema<PackHistory>(
  {
    packId: { type: String, required: true },
    action: { type: String, required: true },
    version: { type: String, required: true },
    fromVersion: String,
    by: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { collection: 'pack_history', versionKey: false },
);
packHistorySchema.plugin(tenantPlugin);
packHistorySchema.index({ tenantId: 1, packId: 1, at: -1 });

export const PackHistoryModel: ModelDef<PackHistory> = {
  name: 'PackHistory',
  schema: packHistorySchema,
};

/** Sample records a pack added, by the sample's ref. */
export interface PackSamples {
  _id: Types.ObjectId;
  tenantId: string;
  packId: string;
  version: string;
  records: { ref: string; entity: string; id: string }[];
  addedAt: Date;
}

const packSamplesSchema = new Schema<PackSamples>(
  {
    packId: { type: String, required: true },
    version: { type: String, required: true },
    records: { type: [{ _id: false, ref: String, entity: String, id: String }], default: [] },
    addedAt: { type: Date, required: true },
  },
  { collection: 'pack_samples', versionKey: false },
);
packSamplesSchema.plugin(tenantPlugin);
packSamplesSchema.index({ tenantId: 1, packId: 1 }, { unique: true, name: 'tenant_pack_unique' });

export const PackSamplesModel: ModelDef<PackSamples> = {
  name: 'PackSamples',
  schema: packSamplesSchema,
};
