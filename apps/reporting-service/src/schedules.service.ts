import { Inject, Injectable } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import { z } from 'zod';
import {
  EventTypes,
  hasPermission,
  NotifyTypes,
  type AclEntry,
  type MailSendPayload,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { reportRunParamsSchema } from '@erp/metadata';
import { AppError, MONGO_CONNECTION } from '@erp/service-kit';
import { requireTenantId, runAsTenant } from '@erp/tenancy';
import { ReportCatalog, type ReportEntry, type Viewer } from './catalog';
import { CLIENTS, CLOCK, type Clients, type Clock } from './clients';
import { Exporter, type StoredFile } from './exporter';
import { baseName } from './exports.service';
import { scheduleModel, type ExportFormat, type Schedule } from './models';
import { resultSize } from './tables';
import { nextScheduleRun } from './zoned-time';

/** Most people one schedule sends to (the design's limit). */
export const MAX_RECIPIENTS = 50;
const LEASE_MS = 15 * 60_000;
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

export const scheduleInputSchema = z
  .object({
    ref: z.string().regex(/^([a-z][a-z0-9_]{1,39}|my:[a-f0-9]{24})$/),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    weekday: z.number().int().min(1).max(7).optional(),
    monthDay: z.number().int().min(1).max(28).optional(),
    formats: z
      .array(z.enum(['xlsx', 'pdf', 'csv']))
      .min(1)
      .max(3),
    recipients: z.object({
      userIds: z.array(objectId).max(MAX_RECIPIENTS).default([]),
      roleIds: z.array(objectId).max(20).default([]),
    }),
    params: reportRunParamsSchema.default({}),
    skipEmpty: z.boolean().default(false),
    subject: z.string().trim().max(200).optional(),
    active: z.boolean().default(true),
  })
  .refine((s) => s.recipients.userIds.length + s.recipients.roleIds.length > 0, {
    message: 'Choose who receives the report',
    path: ['recipients'],
  });
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

function dto(s: Schedule) {
  return {
    id: String(s._id),
    ref: s.ref,
    label: s.label,
    ownerId: s.ownerId,
    frequency: s.frequency,
    at: s.at,
    weekday: s.weekday ?? null,
    monthDay: s.monthDay ?? null,
    formats: s.formats,
    recipients: s.recipients,
    params: s.params,
    skipEmpty: s.skipEmpty,
    subject: s.subject ?? null,
    active: s.active,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt ?? null,
    lastResult: s.lastResult ?? null,
  };
}

interface UserInfo {
  id: string;
  email: string;
  name: string;
  status: string;
  language?: string;
}

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly catalog: ReportCatalog,
    private readonly exporter: Exporter,
    private readonly outbox: OutboxWriter,
  ) {}

  private get Schedules() {
    return scheduleModel(this.conn);
  }

  private async next(
    s: Pick<Schedule, 'frequency' | 'at' | 'weekday' | 'monthDay'>,
  ): Promise<Date> {
    const cfg = await this.catalog.config();
    return nextScheduleRun(this.clock.now(), s, cfg.tenant.timezone ?? 'UTC');
  }

  private canManageAll(v: Viewer) {
    return hasPermission({ acl: v.acl }, 'config.manage');
  }

  async list(v: Viewer) {
    const filter: Record<string, unknown> = { tenantId: requireTenantId() };
    if (!this.canManageAll(v)) filter.ownerId = v.userId;
    const list = await this.Schedules.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<Schedule[]>();
    return list.map(dto);
  }

  async create(v: Viewer, input: ScheduleInput) {
    if (!hasPermission({ acl: v.acl }, 'reports.export'))
      throw AppError.forbidden('Missing permission: reports.export');
    const entry = await this.catalog.get(v, input.ref);
    const [doc] = await this.Schedules.create([
      {
        ...input,
        tenantId: requireTenantId(),
        ownerId: v.userId,
        label: entry.label,
        nextRunAt: await this.next(input),
        leaseUntil: null,
      },
    ]);
    return dto(doc.toObject() as Schedule);
  }

  private async load(v: Viewer, id: string): Promise<Schedule> {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Schedule');
    const s = await this.Schedules.findOne({
      _id: id,
      tenantId: requireTenantId(),
    }).lean<Schedule>();
    if (!s || (s.ownerId !== v.userId && !this.canManageAll(v)))
      throw AppError.notFound('Schedule');
    return s;
  }

  async update(v: Viewer, id: string, input: ScheduleInput) {
    await this.load(v, id);
    const entry = await this.catalog.get(v, input.ref);
    await this.Schedules.updateOne(
      { _id: id },
      { $set: { ...input, label: entry.label, nextRunAt: await this.next(input) } },
    );
    return dto((await this.Schedules.findById(id).lean<Schedule>())!);
  }

  async remove(v: Viewer, id: string) {
    await this.load(v, id);
    await this.Schedules.deleteOne({ _id: id });
    return { deleted: true };
  }

  /** Takes one due schedule and sends it. False when none is due. */
  async runNext(): Promise<boolean> {
    const now = this.clock.now();
    const s = await this.Schedules.findOneAndUpdate(
      {
        active: true,
        nextRunAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
      },
      { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { new: true, sort: { nextRunAt: 1 } },
    ).lean<Schedule>();
    if (!s) return false;
    await runAsTenant(s.tenantId, { type: 'system', id: 'reporting-service' }, async () => {
      let result: string;
      try {
        result = await this.send(s);
      } catch (e) {
        result = `Failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      }
      await this.Schedules.updateOne(
        { _id: s._id },
        {
          $set: {
            leaseUntil: null,
            lastRunAt: now,
            lastResult: result,
            nextRunAt: await this.next(s),
          },
        },
      );
    });
    return true;
  }

  /** The people a schedule reaches: named users and everyone holding the roles. */
  private async recipients(s: Schedule): Promise<UserInfo[]> {
    const ids = new Set(s.recipients.userIds);
    for (const roleId of s.recipients.roleIds) {
      const { userIds } = await this.clients.access.get<{ userIds: string[] }>(
        `/internal/access/roles/${roleId}/holders`,
      );
      userIds.forEach((u) => ids.add(u));
    }
    const list = [...ids].slice(0, MAX_RECIPIENTS);
    if (!list.length) return [];
    const users = await this.clients.identity.post<UserInfo[]>('/internal/users/batch', {
      ids: list,
    });
    return users.filter((u) => u.status === 'active' && u.email);
  }

  private async entryFor(s: Schedule, v: Viewer): Promise<ReportEntry | undefined> {
    try {
      return await this.catalog.get(v, s.ref);
    } catch {
      return undefined;
    }
  }

  /**
   * Sends one run. Each recipient gets only what they may see: the report runs once per
   * distinct access (and language), and the files go only to the people with that access.
   */
  private async send(s: Schedule): Promise<string> {
    const cfg = await this.catalog.config();
    const users = await this.recipients(s);
    const groups = new Map<string, { viewer: Viewer; entry: ReportEntry; users: UserInfo[] }>();
    let skipped = 0;
    for (const u of users) {
      const acl = await this.clients.access.get<AclEntry[]>(`/internal/access/users/${u.id}/acl`);
      const viewer: Viewer = {
        userId: u.id,
        acl,
        lang: u.language || cfg.tenant.defaultLanguage || 'en',
        roleIds: await this.catalog.roleIdsOf(u.id),
      };
      const entry = hasPermission({ acl }, 'reports.export')
        ? await this.entryFor(s, viewer)
        : undefined;
      if (!entry) {
        skipped++;
        continue;
      }
      const key = `${viewer.lang}|${JSON.stringify(
        [...acl]
          .map((e) => ({ path: e.path, p: [...e.p].sort() }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      )}`;
      const g = groups.get(key);
      if (g) g.users.push(u);
      else groups.set(key, { viewer, entry, users: [u] });
    }
    let sent = 0;
    for (const g of groups.values()) {
      const result = await this.exporter.fetchAll(g.viewer, g.entry.def, s.params);
      if (s.skipEmpty && resultSize(result) === 0) continue;
      const now = this.clock.now();
      const files: StoredFile[] = [];
      for (const format of s.formats as ExportFormat[]) {
        files.push(
          await this.exporter.build(result, format, {
            title: g.entry.label,
            subtitle: `${now.toISOString().slice(0, 10)}`,
            lang: g.viewer.lang,
            locale: cfg.tenant.locale || 'en',
            timezone: cfg.tenant.timezone ?? 'UTC',
            baseName: baseName(g.entry.label, now),
          }),
        );
      }
      const subject = s.subject || g.entry.label;
      await this.conn.transaction(async (session) => {
        for (const u of g.users) {
          await this.outbox.record<MailSendPayload>(
            NotifyTypes.MailSend,
            {
              to: [u.email],
              subject,
              text: `Hello ${u.name},\n\nPlease find "${g.entry.label}" attached.`,
              attachments: files.map((f) => ({ fileId: f.id, name: f.name })),
            },
            { session },
          );
        }
      });
      sent += g.users.length;
    }
    await this.conn.transaction((session) =>
      this.outbox.record(
        EventTypes.ReportScheduleSent,
        { scheduleId: String(s._id), ref: s.ref, sent, skipped, runs: groups.size },
        { session },
      ),
    );
    return `Sent to ${sent}${skipped ? `, skipped ${skipped} without access` : ''}`;
  }
}
