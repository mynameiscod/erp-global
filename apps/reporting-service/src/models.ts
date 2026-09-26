import { Schema, type Connection, type Model, type Types } from 'mongoose';
import type { AclEntry } from '@erp/contracts';
import type { DashboardDef, ReportDef, ReportRunParams } from '@erp/metadata';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

/** A report a user built for themselves, optionally shared with roles. */
export interface PersonalReport {
  _id: Types.ObjectId;
  tenantId: string;
  ownerId: string;
  def: ReportDef;
  sharedRoleIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const personalReportSchema = new Schema<PersonalReport>(
  {
    ownerId: { type: String, required: true },
    def: { type: Schema.Types.Mixed, required: true },
    sharedRoleIds: { type: [String], default: [] },
  },
  { collection: 'personal_reports', timestamps: true, versionKey: false, minimize: false },
);
personalReportSchema.plugin(tenantPlugin);
personalReportSchema.index({ tenantId: 1, ownerId: 1 });
personalReportSchema.index({ tenantId: 1, sharedRoleIds: 1 });

export const PersonalReportModel: ModelDef<PersonalReport> = {
  name: 'PersonalReport',
  schema: personalReportSchema,
};

export interface PersonalDashboard {
  _id: Types.ObjectId;
  tenantId: string;
  ownerId: string;
  def: DashboardDef;
  sharedRoleIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const personalDashboardSchema = new Schema<PersonalDashboard>(
  {
    ownerId: { type: String, required: true },
    def: { type: Schema.Types.Mixed, required: true },
    sharedRoleIds: { type: [String], default: [] },
  },
  { collection: 'personal_dashboards', timestamps: true, versionKey: false, minimize: false },
);
personalDashboardSchema.plugin(tenantPlugin);
personalDashboardSchema.index({ tenantId: 1, ownerId: 1 });
personalDashboardSchema.index({ tenantId: 1, sharedRoleIds: 1 });

export const PersonalDashboardModel: ModelDef<PersonalDashboard> = {
  name: 'PersonalDashboard',
  schema: personalDashboardSchema,
};

export type ExportFormat = 'xlsx' | 'csv' | 'pdf';

/**
 * Exports run in the background from a queue shared by all companies (like workflow
 * jobs), so any replica can pick them up. The requester's access is kept with the job.
 */
export interface ExportJob {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  acl: AclEntry[];
  lang: string;
  ref: string;
  title: string;
  report: ReportDef;
  params: ReportRunParams;
  format: ExportFormat;
  status: 'queued' | 'running' | 'done' | 'failed';
  leaseUntil: Date | null;
  attempts: number;
  fileId?: string;
  fileName?: string;
  rows?: number;
  error?: string;
  createdAt: Date;
  finishedAt?: Date;
}

const exportSchema = new Schema<ExportJob>(
  {
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    acl: { type: Schema.Types.Mixed, required: true },
    lang: { type: String, required: true },
    ref: { type: String, required: true },
    title: { type: String, required: true },
    report: { type: Schema.Types.Mixed, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    format: { type: String, required: true },
    status: { type: String, required: true },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    fileId: String,
    fileName: String,
    rows: Number,
    error: String,
    finishedAt: Date,
  },
  {
    collection: 'exports',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  },
);
exportSchema.index({ status: 1, leaseUntil: 1 });
exportSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
// Export records (not the files) are kept for a week.
exportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 });

export function exportModel(conn: Connection): Model<ExportJob> {
  return (
    (conn.models.ExportJob as Model<ExportJob>) ?? conn.model<ExportJob>('ExportJob', exportSchema)
  );
}

export type Frequency = 'daily' | 'weekly' | 'monthly';

/** A report emailed on a schedule. Recipients each get what their own access allows. */
export interface Schedule {
  _id: Types.ObjectId;
  tenantId: string;
  ownerId: string;
  ref: string;
  label: string;
  frequency: Frequency;
  /** HH:MM in the company's time zone. */
  at: string;
  /** Weekly: 1 = Monday … 7 = Sunday. */
  weekday?: number;
  /** Monthly: day 1–28. */
  monthDay?: number;
  formats: ExportFormat[];
  recipients: { userIds: string[]; roleIds: string[] };
  params: ReportRunParams;
  skipEmpty: boolean;
  subject?: string;
  active: boolean;
  nextRunAt: Date;
  leaseUntil: Date | null;
  lastRunAt?: Date;
  lastResult?: string;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleSchema = new Schema<Schedule>(
  {
    tenantId: { type: String, required: true },
    ownerId: { type: String, required: true },
    ref: { type: String, required: true },
    label: { type: String, required: true },
    frequency: { type: String, required: true },
    at: { type: String, required: true },
    weekday: Number,
    monthDay: Number,
    formats: { type: [String], required: true },
    recipients: { type: Schema.Types.Mixed, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    skipEmpty: { type: Boolean, default: false },
    subject: String,
    active: { type: Boolean, default: true },
    nextRunAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    lastRunAt: Date,
    lastResult: String,
  },
  { collection: 'schedules', timestamps: true, versionKey: false, minimize: false },
);
scheduleSchema.index({ active: 1, nextRunAt: 1 });
scheduleSchema.index({ tenantId: 1, ownerId: 1 });

export function scheduleModel(conn: Connection): Model<Schedule> {
  return (
    (conn.models.Schedule as Model<Schedule>) ?? conn.model<Schedule>('Schedule', scheduleSchema)
  );
}
