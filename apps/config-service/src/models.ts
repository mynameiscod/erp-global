import { Schema } from 'mongoose';
import type { TenantConfig } from '@erp/metadata';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

/** The company's working copy. One per tenant; users never see it until it is published. */
export interface Draft {
  tenantId: string;
  config: TenantConfig;
  /** Published version the draft started from. */
  baseVersion: number;
  /** Optimistic concurrency: bumped on every save. */
  rev: number;
  updatedBy?: string;
  updatedAt: Date;
}

const draftSchema = new Schema<Draft>(
  {
    config: { type: Schema.Types.Mixed, required: true },
    baseVersion: { type: Number, required: true },
    rev: { type: Number, required: true, default: 0 },
    updatedBy: String,
    updatedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'config_drafts', versionKey: false, minimize: false },
);
draftSchema.plugin(tenantPlugin);
draftSchema.index({ tenantId: 1 }, { unique: true, name: 'tenantId_unique' });

export const DraftModel: ModelDef<Draft> = { name: 'Draft', schema: draftSchema };

/** An immutable published configuration. Rollback publishes a new version; history is never rewritten. */
export interface Version {
  tenantId: string;
  version: number;
  config: TenantConfig;
  note?: string;
  summary: string[];
  rolledBackFrom?: number;
  publishedBy?: string;
  publishedAt: Date;
}

const versionSchema = new Schema<Version>(
  {
    version: { type: Number, required: true },
    config: { type: Schema.Types.Mixed, required: true },
    note: String,
    summary: { type: [String], default: [] },
    rolledBackFrom: Number,
    publishedBy: String,
    publishedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'config_versions', versionKey: false, minimize: false },
);
versionSchema.plugin(tenantPlugin);
versionSchema.index({ tenantId: 1, version: -1 }, { unique: true });

export const VersionModel: ModelDef<Version> = { name: 'Version', schema: versionSchema };

/** One running number per (series, bucket, period). `$inc` makes allocation atomic. */
export interface Counter {
  tenantId: string;
  series: string;
  bucket: string;
  period: string;
  seq: number;
}

const counterSchema = new Schema<Counter>(
  {
    series: { type: String, required: true },
    bucket: { type: String, required: true },
    period: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: 'number_counters', versionKey: false },
);
counterSchema.plugin(tenantPlugin);
counterSchema.index({ tenantId: 1, series: 1, bucket: 1, period: 1 }, { unique: true });

export const CounterModel: ModelDef<Counter> = { name: 'Counter', schema: counterSchema };
