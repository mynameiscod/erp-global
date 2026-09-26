import { Inject, Injectable } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import { EventTypes, hasPermission, NotifyTypes, type UserNotifyPayload } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import type { ReportRunParams } from '@erp/metadata';
import { AppError, MONGO_CONNECTION } from '@erp/service-kit';
import { requireTenantId, runAsTenant } from '@erp/tenancy';
import { ReportCatalog, type Viewer } from './catalog';
import { CLOCK, type Clock } from './clients';
import { Exporter } from './exporter';
import { exportModel, type ExportFormat, type ExportJob } from './models';

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export function exportDto(j: ExportJob) {
  return {
    id: String(j._id),
    ref: j.ref,
    title: j.title,
    format: j.format,
    status: j.status,
    fileId: j.fileId ?? null,
    fileName: j.fileName ?? null,
    rows: j.rows ?? null,
    error: j.error ?? null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? null,
  };
}

/** A safe base file name: the report title and today's date. */
export function baseName(title: string, now: Date): string {
  const clean = [...title]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .slice(0, 80);
  return `${clean || 'report'}-${now.toISOString().slice(0, 10)}`;
}

@Injectable()
export class ExportsService {
  constructor(
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly catalog: ReportCatalog,
    private readonly exporter: Exporter,
    private readonly outbox: OutboxWriter,
  ) {}

  private get Exports() {
    return exportModel(this.conn);
  }

  async request(v: Viewer, ref: string, format: ExportFormat, params: ReportRunParams) {
    if (!hasPermission({ acl: v.acl }, 'reports.export'))
      throw AppError.forbidden('Missing permission: reports.export');
    const entry = await this.catalog.get(v, ref);
    const [job] = await this.Exports.create([
      {
        tenantId: requireTenantId(),
        userId: v.userId,
        acl: v.acl,
        lang: v.lang,
        ref,
        title: entry.label,
        report: entry.def,
        params,
        format,
        status: 'queued',
        leaseUntil: null,
        attempts: 0,
      },
    ]);
    return exportDto(job.toObject() as ExportJob);
  }

  async list(v: Viewer) {
    const jobs = await this.Exports.find({ tenantId: requireTenantId(), userId: v.userId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean<ExportJob[]>();
    return jobs.map(exportDto);
  }

  async get(v: Viewer, id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Export');
    const j = await this.Exports.findOne({
      _id: id,
      tenantId: requireTenantId(),
      userId: v.userId,
    }).lean<ExportJob>();
    if (!j) throw AppError.notFound('Export');
    return exportDto(j);
  }

  /** Takes one waiting export (or one whose worker died) and runs it. False when none is left. */
  async runNext(): Promise<boolean> {
    const now = this.clock.now();
    const job = await this.Exports.findOneAndUpdate(
      {
        $or: [
          { status: 'queued', $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
          { status: 'running', leaseUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'running', leaseUntil: new Date(now.getTime() + LEASE_MS) },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { createdAt: 1 } },
    ).lean<ExportJob>();
    if (!job) return false;
    await runAsTenant(job.tenantId, { type: 'user', id: job.userId }, () => this.process(job));
    return true;
  }

  private async process(job: ExportJob): Promise<void> {
    const v: Viewer = { userId: job.userId, acl: job.acl, lang: job.lang, roleIds: [] };
    try {
      const cfg = await this.catalog.config();
      const result = await this.exporter.fetchAll(v, job.report, job.params);
      const now = this.clock.now();
      const file = await this.exporter.build(result, job.format, {
        title: job.title,
        lang: job.lang,
        locale: cfg.tenant.locale || 'en',
        timezone: cfg.tenant.timezone ?? 'UTC',
        baseName: baseName(job.title, now),
      });
      await this.Exports.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'done',
            fileId: file.id,
            fileName: file.name,
            rows: file.rows,
            leaseUntil: null,
            finishedAt: now,
          },
        },
      );
      await this.conn.transaction(async (session) => {
        await this.outbox.record(
          EventTypes.ReportExported,
          { ref: job.ref, title: job.title, format: job.format, rows: file.rows, fileId: file.id },
          { session },
        );
        await this.outbox.record<UserNotifyPayload>(
          NotifyTypes.UserNotify,
          {
            userIds: [job.userId],
            template: 'report.ready',
            channels: ['inapp'],
            vars: { report: job.title, format: job.format.toUpperCase(), rows: file.rows },
            link: `/reports/exports`,
          },
          { session },
        );
      });
    } catch (e) {
      const message = e instanceof AppError ? e.message : 'The export failed';
      const failed = job.attempts >= MAX_ATTEMPTS || (e instanceof AppError && e.status < 500);
      await this.Exports.updateOne(
        { _id: job._id },
        failed
          ? {
              $set: {
                status: 'failed',
                error: message,
                leaseUntil: null,
                finishedAt: this.clock.now(),
              },
            }
          : {
              $set: { status: 'queued', leaseUntil: new Date(this.clock.now().getTime() + 60_000) },
            },
      );
      if (!failed) throw e;
    }
  }
}
