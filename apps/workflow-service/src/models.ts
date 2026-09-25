import { Schema, type Connection, type Model, type Types } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

export interface HistoryEntry {
  at: Date;
  /** Who acted; `system` for automations, escalations and timeouts. */
  by: string;
  /** Set when a delegate acted for the assignee. */
  onBehalfOf?: string;
  action: string;
  from: string | null;
  to: string | null;
  comment?: string;
  level?: string;
}

export interface ApprovalRun {
  /** The workflow action that started the approval, e.g. `submit`. */
  action: string;
  pendingState: string;
  approvedState: string;
  rejectedState: string;
  /** Levels whose condition held when the approval started, in order. */
  levels: string[];
  current: number;
  startedAt: Date;
}

/** One per record of an entity with a workflow. Holds the state and everything that happened. */
export interface WorkflowInstance {
  _id: Types.ObjectId;
  tenantId: string;
  entity: string;
  recordId: string;
  orgPath: string;
  requesterId: string;
  state: string | null;
  approval?: ApprovalRun | null;
  history: HistoryEntry[];
  /** Pending copy of the state to the record, retried by the scheduler if the call failed. */
  statusSync?: { from: string | null; to: string; action: string | null } | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<HistoryEntry>(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true },
    onBehalfOf: String,
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    comment: String,
    level: String,
  },
  { _id: false },
);

const instanceSchema = new Schema<WorkflowInstance>(
  {
    entity: { type: String, required: true },
    recordId: { type: String, required: true },
    orgPath: { type: String, required: true },
    requesterId: { type: String, required: true },
    state: { type: String, default: null },
    approval: { type: Schema.Types.Mixed, default: null },
    history: { type: [historySchema], default: [] },
    statusSync: { type: Schema.Types.Mixed, default: null },
    version: { type: Number, default: 0 },
  },
  { collection: 'workflow_instances', timestamps: true, versionKey: false, minimize: false },
);
instanceSchema.plugin(tenantPlugin);
instanceSchema.index({ tenantId: 1, entity: 1, recordId: 1 }, { unique: true });

export const InstanceModel: ModelDef<WorkflowInstance> = {
  name: 'WorkflowInstance',
  schema: instanceSchema,
};

export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'escalated';

/** One approver's part of one approval level. */
export interface ApprovalTask {
  _id: Types.ObjectId;
  tenantId: string;
  instanceId: string;
  entity: string;
  recordId: string;
  recordTitle: string;
  orgPath: string;
  requesterId: string;
  level: string;
  levelLabel: Record<string, string>;
  mode: 'all' | 'any';
  assigneeId: string;
  status: TaskStatus;
  remindAt?: Date | null;
  escalateAt?: Date | null;
  reminded: boolean;
  decidedAt?: Date;
  decidedBy?: string;
  onBehalfOf?: string;
  comment?: string;
  createdAt: Date;
}

const taskSchema = new Schema<ApprovalTask>(
  {
    instanceId: { type: String, required: true },
    entity: { type: String, required: true },
    recordId: { type: String, required: true },
    recordTitle: { type: String, default: '' },
    orgPath: { type: String, required: true },
    requesterId: { type: String, required: true },
    level: { type: String, required: true },
    levelLabel: { type: Schema.Types.Mixed, default: {} },
    mode: { type: String, enum: ['all', 'any'], required: true },
    assigneeId: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled', 'escalated'],
      default: 'pending',
    },
    remindAt: Date,
    escalateAt: Date,
    reminded: { type: Boolean, default: false },
    decidedAt: Date,
    decidedBy: String,
    onBehalfOf: String,
    comment: String,
  },
  {
    collection: 'approval_tasks',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);
taskSchema.plugin(tenantPlugin);
taskSchema.index({ tenantId: 1, assigneeId: 1, status: 1, createdAt: -1 });
taskSchema.index({ tenantId: 1, instanceId: 1, level: 1, status: 1 });

export const TaskModel: ModelDef<ApprovalTask> = { name: 'ApprovalTask', schema: taskSchema };

export interface AutomationRun {
  _id: Types.ObjectId;
  tenantId: string;
  /** `<automation>:<event or schedule slot>:<record>`; makes a retried delivery a no-op. */
  runKey: string;
  automation: string;
  entity: string;
  recordId: string;
  trigger: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  depth: number;
  steps: { type: string; ok: boolean; info?: string }[];
  error?: string;
  attempts: number;
  /** What is needed to run it again: the triggering event's changes. */
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  createdAt: Date;
  updatedAt: Date;
}

const runSchema = new Schema<AutomationRun>(
  {
    runKey: { type: String, required: true },
    automation: { type: String, required: true },
    entity: { type: String, required: true },
    recordId: { type: String, required: true },
    trigger: { type: String, required: true },
    status: { type: String, enum: ['running', 'ok', 'failed', 'skipped'], required: true },
    depth: { type: Number, default: 0 },
    steps: { type: Schema.Types.Mixed, default: [] },
    error: String,
    attempts: { type: Number, default: 1 },
    changes: { type: Schema.Types.Mixed },
  },
  { collection: 'automation_runs', timestamps: true, versionKey: false },
);
runSchema.plugin(tenantPlugin);
runSchema.index({ tenantId: 1, runKey: 1 }, { unique: true });
runSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Keep 90 days of run history.
runSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

export const RunModel: ModelDef<AutomationRun> = { name: 'AutomationRun', schema: runSchema };

/** Per-company settings of this service. */
export interface WorkflowSettings {
  tenantId: string;
  webhookSecret: string;
}

const settingsSchema = new Schema<WorkflowSettings>(
  { webhookSecret: { type: String, required: true } },
  { collection: 'workflow_settings', versionKey: false },
);
settingsSchema.plugin(tenantPlugin);
settingsSchema.index({ tenantId: 1 }, { unique: true });

export const SettingsModel: ModelDef<WorkflowSettings> = {
  name: 'WorkflowSettings',
  schema: settingsSchema,
};

// ---- jobs (cross-tenant, in the service's own database) ----

export type JobKind = 'task' | 'schedule' | 'digest' | 'status_sync';

/**
 * Something to do at a time: an approval reminder or escalation, a scheduled automation,
 * the daily digest, or a retry of a state copy. Jobs of all companies share one small
 * collection so one poller can find what is due; the work itself runs in the company.
 */
export interface Job {
  _id: Types.ObjectId;
  tenantId: string;
  kind: JobKind;
  key: string;
  dueAt: Date;
  leaseUntil?: Date | null;
  attempts: number;
  data?: Record<string, unknown>;
}

const jobSchema = new Schema<Job>(
  {
    tenantId: { type: String, required: true },
    kind: { type: String, required: true },
    key: { type: String, required: true },
    dueAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    data: { type: Schema.Types.Mixed },
  },
  { collection: 'jobs', versionKey: false },
);
jobSchema.index({ tenantId: 1, kind: 1, key: 1 }, { unique: true });
jobSchema.index({ dueAt: 1 });

export function jobModel(conn: Connection): Model<Job> {
  return (conn.models.Job as Model<Job>) ?? conn.model<Job>('Job', jobSchema);
}
