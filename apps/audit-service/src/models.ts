import { Schema } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export interface AuditRecord {
  tenantId: string;
  seq: number;
  eventId: string;
  type: string;
  source: string;
  actor: { type: string; id: string };
  occurredAt: string;
  recordedAt: string;
  correlationId?: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

const recordSchema = new Schema<AuditRecord>(
  {
    seq: { type: Number, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    source: { type: String, required: true },
    actor: { type: { type: String, required: true }, id: { type: String, required: true } },
    occurredAt: { type: String, required: true },
    recordedAt: { type: String, required: true },
    correlationId: String,
    payload: { type: Schema.Types.Mixed },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { collection: 'audit_records', versionKey: false, minimize: false, _id: true },
);
recordSchema.plugin(tenantPlugin);
// One record per position: two writers can never fork the chain.
recordSchema.index({ tenantId: 1, seq: 1 }, { unique: true });
recordSchema.index({ tenantId: 1, eventId: 1 }, { unique: true });
recordSchema.index({ tenantId: 1, type: 1, seq: -1 });
recordSchema.index({ tenantId: 1, 'actor.id': 1, seq: -1 });

export const AuditRecordModel: ModelDef<AuditRecord> = {
  name: 'AuditRecord',
  schema: recordSchema,
};

/** The newest position of each tenant's chain. */
export interface AuditHead {
  tenantId: string;
  seq: number;
  hash: string;
}

const headSchema = new Schema<AuditHead>(
  {
    seq: { type: Number, required: true },
    hash: { type: String, required: true },
  },
  { collection: 'audit_heads', versionKey: false },
);
headSchema.plugin(tenantPlugin);
headSchema.index({ tenantId: 1 }, { unique: true, name: 'tenantId_unique' });

export const AuditHeadModel: ModelDef<AuditHead> = { name: 'AuditHead', schema: headSchema };
