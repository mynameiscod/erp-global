import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { Types, type Connection } from 'mongoose';
import {
  EventTypes,
  NotifyTypes,
  type EventEnvelope,
  type RecordEventPayload,
  type RecordStatusChangedPayload,
  type UserNotifyPayload,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  conditionHolds,
  evaluateValue,
  findEntity,
  type AutomationDef,
  type FieldAssignment,
  type RuleEnv,
} from '@erp/metadata';
import {
  AppError,
  MONGO_CONNECTION,
  TENANT_DATABASES,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import {
  CLIENTS,
  CLOCK,
  WORKFLOW_ENV,
  type Clients,
  type Clock,
  type RecordInfo,
  type WorkflowEnv,
} from './clients';
import { Directory } from './directory';
import { JobStore } from './jobs';
import { RunModel, SettingsModel, type AutomationRun } from './models';
import { sendWebhook } from './webhook';
import { recordLink, recordVars, WorkflowService } from './workflow.service';
import { nextRun } from './zoned-time';

/** Automations triggered by automations stop at this depth, so they cannot loop forever. */
export const MAX_DEPTH = 3;
const SCHEDULE_MAX_RECORDS = 5000;

type Trigger = 'created' | 'updated' | 'deleted' | 'status_changed' | 'schedule';

interface RunInput {
  automation: AutomationDef;
  record: RecordInfo;
  trigger: Trigger;
  runKey: string;
  depth: number;
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  actorId?: string;
}

const EVENT_TRIGGER: Record<string, Trigger> = {
  [EventTypes.RecordCreated]: 'created',
  [EventTypes.RecordUpdated]: 'updated',
  [EventTypes.RecordDeleted]: 'deleted',
  [EventTypes.RecordStatusChanged]: 'status_changed',
};

@Injectable()
export class AutomationService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFLOW_ENV) private readonly env: WorkflowEnv,
    private readonly directory: Directory,
    private readonly workflow: WorkflowService,
    private readonly jobs: JobStore,
    private readonly outbox: OutboxWriter,
    private readonly log: PinoLogger,
  ) {}

  runs() {
    return this.dbs.model(RunModel);
  }

  // ---- triggers ----

  /** Does an automation's trigger match this record event? */
  private matches(a: AutomationDef, trigger: Trigger, payload: RecordEventPayload): boolean {
    const t = a.trigger;
    switch (t.type) {
      case 'created':
      case 'updated':
      case 'deleted':
        return t.type === trigger;
      case 'field_changed':
        return (
          (trigger === 'created' || trigger === 'updated') &&
          !!payload.changes &&
          t.field in payload.changes
        );
      case 'status_changed':
        return (
          trigger === 'status_changed' &&
          (!t.to || (payload as RecordStatusChangedPayload).to === t.to)
        );
      case 'schedule':
        return false;
    }
  }

  /** Runs the automations a record event triggers. Runs in the event's company. */
  async onRecordEvent(event: EventEnvelope): Promise<void> {
    const trigger = EVENT_TRIGGER[event.type];
    const payload = event.payload as RecordEventPayload;
    if (!trigger || !payload.orgPath) return;
    const cfg = await this.workflow.cfgFor(payload.orgPath);
    const automations = (cfg.automations ?? []).filter(
      (a) => a.entity === payload.entity && a.active !== false && this.matches(a, trigger, payload),
    );
    if (!automations.length) return;
    const depth = payload.depth ?? 0;
    const record = await this.workflow
      .record(payload.entity, payload.recordId, true)
      .catch(() => null);
    if (!record) return;
    for (const automation of automations) {
      await this.run({
        automation,
        record,
        trigger,
        runKey: `${automation.key}:${event.eventId}`,
        depth,
        changes: payload.changes,
        actorId: event.actor.type === 'user' ? event.actor.id : undefined,
      });
    }
  }

  // ---- running ----

  private async conditionEnv(input: RunInput): Promise<RuleEnv> {
    const { automation, record, changes, actorId } = input;
    let old: Record<string, unknown> | undefined;
    if (changes && input.trigger !== 'created') {
      old = { ...record.data };
      for (const [k, c] of Object.entries(changes)) old[k] = c.from;
    }
    const texts = [
      automation.condition,
      ...automation.actions.flatMap((a) => ('set' in a ? a.set.map((s) => s.value) : [])),
    ].join(' ');
    return {
      old,
      user: actorId
        ? {
            id: actorId,
            roles: /HAS_ROLE/i.test(texts) ? (await this.directory.roles(actorId)).names : [],
          }
        : undefined,
      unitCodes: /IN_UNIT/i.test(texts) ? await this.directory.unitCodes(record.orgUnitId) : [],
      status: record.status,
      now: this.clock.now(),
    };
  }

  /**
   * Runs one automation for one record, once per run key. Each step is logged; the first
   * failing step stops the run, which an admin can re-run from the automation log.
   */
  async run(input: RunInput, retry = false): Promise<AutomationRun | null> {
    const { automation, record, depth } = input;
    const Runs = await this.runs();
    const base = {
      runKey: input.runKey,
      automation: automation.key,
      entity: record.entity,
      recordId: record.id,
      trigger: input.trigger,
      depth,
      changes: input.changes,
    };
    if (!retry) {
      try {
        await Runs.create({ ...base, status: 'running', steps: [] });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return null; // already ran for this event
        throw e;
      }
    }
    const finish = async (
      status: AutomationRun['status'],
      steps: AutomationRun['steps'],
      error?: string,
    ) => {
      await Runs.updateOne(
        { runKey: input.runKey },
        error
          ? { $set: { status, steps, error } }
          : { $set: { status, steps }, $unset: { error: '' } },
      );
      if (status === 'failed') {
        await this.conn.transaction(async (session) => {
          await this.outbox.record(
            EventTypes.AutomationFailed,
            {
              automation: automation.key,
              entity: record.entity,
              recordId: record.id,
              error: error ?? null,
            },
            { session },
          );
        });
      }
      return (await Runs.findOne({ runKey: input.runKey }).lean())!;
    };

    if (depth >= MAX_DEPTH) {
      return finish(
        'skipped',
        [],
        `Stopped: automations triggered each other ${depth} times in a row`,
      );
    }
    const env = await this.conditionEnv(input);
    if (!conditionHolds(automation.condition, record.data, env)) {
      return finish('skipped', [], 'Condition not met');
    }
    const cfg = await this.workflow.cfgFor(record.orgPath);
    const steps: AutomationRun['steps'] = [];
    for (const [i, action] of automation.actions.entries()) {
      try {
        const info = await this.step(action, i, input, cfg, env);
        steps.push({ type: action.type, ok: true, info });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        steps.push({ type: action.type, ok: false, info: message });
        this.log.warn(
          { err: e, automation: automation.key, recordId: record.id },
          'automation step failed',
        );
        return finish('failed', steps, message);
      }
    }
    return finish('ok', steps);
  }

  private values(
    set: FieldAssignment[],
    targetEntity: string,
    cfg: EffectiveConfigResponse,
    data: Record<string, unknown>,
    env: RuleEnv,
  ) {
    const target = findEntity(cfg, targetEntity);
    const fields = new Map(target?.fields.map((f) => [f.key, f]) ?? []);
    return Object.fromEntries(
      set.map((s) => [s.field, evaluateValue(s.value, fields.get(s.field), data, env) ?? null]),
    );
  }

  private async step(
    action: AutomationDef['actions'][number],
    index: number,
    input: RunInput,
    cfg: EffectiveConfigResponse,
    env: RuleEnv,
  ): Promise<string | undefined> {
    const { record, automation, depth } = input;
    switch (action.type) {
      case 'notify': {
        const userIds = await this.directory.resolve(action.recipients, record, record.createdBy);
        const vars = recordVars(record, findEntity(cfg, record.entity));
        const actorName = input.actorId
          ? ((await this.directory.user(input.actorId))?.name ?? '')
          : '';
        await this.conn.transaction(async (session) => {
          await this.outbox.record<UserNotifyPayload>(
            NotifyTypes.UserNotify,
            {
              userIds,
              template: action.template,
              channels: action.channels,
              vars: { ...vars, actor: { name: actorName }, state: record.status ?? '' },
              link: recordLink(record.entity, record.id),
              orgPath: record.orgPath,
            },
            { session },
          );
        });
        return `${userIds.length} recipient(s)`;
      }
      case 'update': {
        if (record.deleted) throw new Error('The record was deleted');
        const data = this.values(action.set, record.entity, cfg, record.data, env);
        await this.clients.records.request(
          'PATCH',
          `/internal/records/${record.entity}/${record.id}`,
          {
            data,
            depth: depth + 1,
          },
        );
        return Object.keys(data).join(', ');
      }
      case 'create': {
        const data = this.values(action.set, action.entity, cfg, record.data, env);
        const target = findEntity(cfg, action.entity);
        const orgUnitId =
          target?.orgScoped === false ? null : action.orgUnit === 'none' ? null : record.orgUnitId;
        const created = await this.clients.records.post<{ id: string }>(
          `/internal/records/${action.entity}`,
          {
            orgUnitId,
            data,
            depth: depth + 1,
            sourceKey: `${input.runKey}:${index}`,
          },
        );
        return `${action.entity} ${created.id}`;
      }
      case 'workflow_action': {
        if (record.deleted) throw new Error('The record was deleted');
        await this.workflow.act(record.entity, record.id, action.action, undefined, {
          system: true,
          depth: depth + 1,
        });
        return action.action;
      }
      case 'document': {
        if (record.deleted) throw new Error('The record was deleted');
        if (!this.clients.documents) throw new Error('DOCUMENT_SERVICE_URL is not configured');
        const res = await this.clients.documents.post<{ fileName: string; emailedTo: string[] }>(
          '/internal/documents/generate',
          {
            entity: record.entity,
            recordId: record.id,
            template: action.template,
            attachField: action.attachField,
            emailFields: action.emailFields,
            emailTo: action.emailTo,
            subject: action.subject,
            message: action.message,
            depth: depth,
          },
          { timeoutMs: 90_000 },
        );
        return res.emailedTo.length
          ? `${res.fileName} emailed to ${res.emailedTo.join(', ')}`
          : res.fileName;
      }
      case 'webhook': {
        const secret = await this.webhookSecret();
        const deliveryId = `${input.runKey}:${index}`;
        const res = await sendWebhook({
          url: action.url,
          secret,
          deliveryId,
          allowPrivate: this.env.WEBHOOK_ALLOW_PRIVATE,
          body: {
            event: input.trigger,
            automation: automation.key,
            entity: record.entity,
            record: {
              id: record.id,
              number: record.number,
              status: record.status,
              orgUnitId: record.orgUnitId,
              data: record.data,
              deleted: !!record.deleted,
            },
            changes: input.changes ?? null,
            deliveryId,
            sentAt: this.clock.now().toISOString(),
          },
        });
        await this.conn.transaction(async (session) => {
          await this.outbox.record(
            EventTypes.WebhookCalled,
            {
              automation: automation.key,
              url: new URL(action.url).origin,
              status: res.status,
              deliveryId,
            },
            { session },
          );
        });
        return `HTTP ${res.status}`;
      }
    }
  }

  // ---- admin ----

  async listRuns(status: string | undefined, page: number, pageSize: number) {
    const Runs = await this.runs();
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      Runs.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Runs.countDocuments(filter),
    ]);
    return {
      items: items.map((r) => ({
        id: String(r._id),
        automation: r.automation,
        entity: r.entity,
        recordId: r.recordId,
        trigger: r.trigger,
        status: r.status,
        steps: r.steps,
        error: r.error ?? null,
        attempts: r.attempts,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Runs a failed automation again with the current record and configuration. */
  async retryRun(id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Run');
    const Runs = await this.runs();
    const run = await Runs.findOneAndUpdate(
      { _id: id, status: 'failed' },
      { $set: { status: 'running' }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (!run) throw AppError.conflict('Only failed runs can be run again');
    const record = await this.workflow.record(run.entity, run.recordId, true);
    const cfg = await this.workflow.cfgFor(record.orgPath);
    const automation = cfg.automations.find((a) => a.key === run.automation);
    if (!automation) {
      await Runs.updateOne(
        { _id: run._id },
        { $set: { status: 'failed', error: 'The automation no longer exists' } },
      );
      throw AppError.conflict('The automation no longer exists');
    }
    const result = await this.run(
      {
        automation,
        record,
        trigger: run.trigger as Trigger,
        runKey: run.runKey,
        depth: run.depth,
        changes: run.changes,
        actorId: requireContext().actor?.id,
      },
      true,
    );
    return { status: result?.status ?? 'ok', error: result?.error ?? null };
  }

  async webhookSecret(): Promise<string> {
    const Settings = await this.dbs.model(SettingsModel);
    const found = await Settings.findOne().lean();
    if (found) return found.webhookSecret;
    try {
      await Settings.create({ webhookSecret: `whsec_${randomBytes(24).toString('base64url')}` });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    return (await Settings.findOne().lean())!.webhookSecret;
  }

  async rotateWebhookSecret(): Promise<string> {
    const Settings = await this.dbs.model(SettingsModel);
    await this.webhookSecret();
    const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    await Settings.updateOne({}, { $set: { webhookSecret } });
    return webhookSecret;
  }

  // ---- schedules ----

  /** Keeps one job per scheduled automation of the company in line with the published config. */
  async syncSchedules(): Promise<void> {
    const cfg = await this.workflow.cfgFor('/');
    const tz = cfg.tenant.timezone ?? 'UTC';
    const scheduled = (cfg.automations ?? []).filter(
      (a) => a.active !== false && a.trigger.type === 'schedule',
    );
    const existing = await this.jobs.list('schedule');
    const now = this.clock.now();
    for (const a of scheduled) {
      const t = a.trigger as { every: 'day' | 'hour' | '15min'; at?: string };
      const signature = `${t.every}@${t.at ?? ''}@${tz}`;
      const job = existing.find((j) => j.key === a.key);
      if (job?.data?.signature === signature) continue;
      await this.jobs.put('schedule', a.key, nextRun(now, t.every, t.at, tz), { signature });
    }
    const keep = new Set(scheduled.map((a) => a.key));
    await this.jobs.removeMany(
      'schedule',
      existing.filter((j) => !keep.has(j.key)).map((j) => j.key),
    );
  }

  /**
   * A scheduled automation's time came: check every record of the entity (up to 5,000)
   * and run it for those that match, then book the next run.
   */
  async runSchedule(key: string, slot: Date): Promise<Date | null> {
    const cfg = await this.workflow.cfgFor('/');
    const automation = (cfg.automations ?? []).find((a) => a.key === key && a.active !== false);
    if (!automation || automation.trigger.type !== 'schedule') return null;
    const t = automation.trigger;
    const cfgByPath = new Map<string, Promise<EffectiveConfigResponse>>();
    const cfgAt = (path: string) => {
      if (!cfgByPath.has(path)) cfgByPath.set(path, this.workflow.cfgFor(path));
      return cfgByPath.get(path)!;
    };
    const pageSize = 200;
    for (let page = 1; page <= SCHEDULE_MAX_RECORDS / pageSize; page++) {
      const records = await this.clients.records.get<RecordInfo[]>(
        `/internal/records/${automation.entity}?page=${page}&pageSize=${pageSize}`,
      );
      for (const record of records) {
        // A branch override may change or remove the automation for records under it.
        const local = (await cfgAt(record.orgPath)).automations.find((a) => a.key === key);
        if (!local || local.active === false || local.trigger.type !== 'schedule') continue;
        await this.run({
          automation: local,
          record,
          trigger: 'schedule',
          runKey: `${key}:${slot.toISOString()}:${record.id}`,
          depth: 0,
        });
      }
      if (records.length < pageSize) break;
    }
    return nextRun(this.clock.now(), t.every, t.at, cfg.tenant.timezone ?? 'UTC');
  }
}
