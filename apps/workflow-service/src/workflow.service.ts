import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Types, type ClientSession, type Connection } from 'mongoose';
import {
  EventTypes,
  hasPermission,
  NotifyTypes,
  recordPermission,
  type UserNotifyPayload,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  conditionHolds,
  findEntity,
  pickText,
  stateOf,
  workflowFor,
  type ApprovalLevel,
  type EntityDef,
  type RuleEnv,
  type WorkflowAction,
  type WorkflowDef,
} from '@erp/metadata';
import {
  AppError,
  MONGO_CONNECTION,
  TENANT_DATABASES,
  UpstreamError,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, CLOCK, type Clients, type Clock, type RecordInfo } from './clients';
import { Directory } from './directory';
import { JobStore } from './jobs';
import { nextRun } from './zoned-time';
import {
  InstanceModel,
  TaskModel,
  type ApprovalRun,
  type ApprovalTask,
  type HistoryEntry,
  type WorkflowInstance,
} from './models';

const HOUR = 3_600_000;

class VersionConflict extends Error {}

/** Placeholders for messages about a record. */
export function recordVars(record: RecordInfo, entity: EntityDef | undefined) {
  const title =
    (entity?.titleField && record.data[entity.titleField]) ?? record.number ?? record.id;
  return {
    record: { ...record.data, id: record.id, number: record.number, title: String(title) },
    entity: entity?.label ?? {},
  };
}

export const recordLink = (entity: string, id: string) => `/r/${entity}/${id}`;

/**
 * Workflow actions and approvals. The instance in this service holds the state; the
 * record carries a copy (`status`) so lists can filter and forms can lock. The copy is
 * made right after each change and retried by the scheduler if that call fails.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly directory: Directory,
    private readonly jobs: JobStore,
    private readonly outbox: OutboxWriter,
    private readonly log: PinoLogger,
  ) {}

  instances() {
    return this.dbs.model(InstanceModel);
  }
  tasks() {
    return this.dbs.model(TaskModel);
  }

  // ---- loading ----

  async record(entity: string, id: string, includeDeleted = false): Promise<RecordInfo> {
    try {
      return await this.clients.records.get<RecordInfo>(
        `/internal/records/${entity}/${id}${includeDeleted ? '?includeDeleted=1' : ''}`,
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) throw AppError.notFound('Record');
      throw e;
    }
  }

  cfgFor(orgPath: string): Promise<EffectiveConfigResponse> {
    return this.clients.config.effective(orgPath === '/' ? undefined : orgPath);
  }

  private workflow(cfg: EffectiveConfigResponse, entity: string): WorkflowDef {
    const wf = workflowFor(cfg, entity);
    if (!wf) throw AppError.notFound('Workflow');
    return wf;
  }

  private async instanceFor(record: RecordInfo): Promise<WorkflowInstance> {
    const Instances = await this.instances();
    const found = await Instances.findOne({ entity: record.entity, recordId: record.id }).lean();
    if (found) return found;
    try {
      await Instances.create({
        entity: record.entity,
        recordId: record.id,
        orgPath: record.orgPath,
        requesterId: record.createdBy,
        state: record.status,
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    return (await Instances.findOne({ entity: record.entity, recordId: record.id }).lean())!;
  }

  private path(record: RecordInfo): string | undefined {
    return record.orgPath === '/' ? undefined : record.orgPath;
  }

  /** What a condition needs; roles and unit codes are only fetched when the text uses them. */
  private async env(
    texts: (string | undefined)[],
    record: RecordInfo,
    userId: string | null,
    status: string | null,
  ): Promise<RuleEnv> {
    const text = texts.join(' ');
    const roles =
      userId && /HAS_ROLE/i.test(text) ? (await this.directory.roles(userId)).names : [];
    const unitCodes = /IN_UNIT/i.test(text) ? await this.directory.unitCodes(record.orgUnitId) : [];
    return {
      user: userId ? { id: userId, roles } : undefined,
      unitCodes,
      status,
      now: this.clock.now(),
    };
  }

  // ---- committing a change ----

  /**
   * Writes an instance change guarded by its version, with any extra writes in the same
   * transaction. Conflicting writers get `VersionConflict` and retry from fresh data.
   */
  private async commit(
    inst: WorkflowInstance,
    change: { set?: Partial<WorkflowInstance>; history?: HistoryEntry[] },
    extra: (session: ClientSession) => Promise<void>,
  ): Promise<void> {
    const Instances = await this.instances();
    await this.conn.transaction(async (session) => {
      const res = await Instances.updateOne(
        { _id: inst._id, version: inst.version },
        {
          $set: change.set ?? {},
          ...(change.history?.length ? { $push: { history: { $each: change.history } } } : {}),
          $inc: { version: 1 },
        },
        { session },
      );
      if (res.modifiedCount !== 1) throw new VersionConflict();
      await extra(session);
    });
  }

  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof VersionConflict) || i >= 4) {
          if (e instanceof VersionConflict) {
            throw AppError.conflict(
              'Someone else acted on this at the same moment. Please try again.',
            );
          }
          throw e;
        }
      }
    }
  }

  /** Copies the state to the record. On failure the scheduler tries again. */
  async pushStatus(instanceId: Types.ObjectId | string, depth = 0): Promise<boolean> {
    const Instances = await this.instances();
    const inst = await Instances.findById(instanceId).lean();
    const sync = inst?.statusSync;
    if (!inst || !sync) return true;
    try {
      await this.clients.records.post(`/internal/records/${inst.entity}/${inst.recordId}/status`, {
        ...sync,
        depth,
      });
    } catch (e) {
      const alreadyThere =
        e instanceof UpstreamError &&
        e.status === 409 &&
        (await this.record(inst.entity, inst.recordId, true)).status === sync.to;
      if (!alreadyThere) {
        this.log.warn({ err: e, instanceId: String(inst._id) }, 'state copy to record failed');
        return false;
      }
    }
    await Instances.updateOne(
      { _id: inst._id, 'statusSync.to': sync.to },
      { $set: { statusSync: null } },
    );
    await this.jobs.remove('status_sync', String(inst._id));
    return true;
  }

  private async notify(payload: UserNotifyPayload, session: ClientSession) {
    if (!payload.userIds.length) return;
    await this.outbox.record<UserNotifyPayload>(NotifyTypes.UserNotify, payload, { session });
  }

  /** Assignees plus whoever is standing in for them today. */
  private async withDelegates(userIds: string[]): Promise<string[]> {
    const delegates = await Promise.all(userIds.map((u) => this.directory.delegateOf(u)));
    return [...new Set([...userIds, ...delegates.filter((d): d is string => !!d)])];
  }

  // ---- approval levels ----

  private levelDef(
    wf: WorkflowDef,
    run: ApprovalRun,
    key: string,
  ): { action: WorkflowAction | undefined; level: ApprovalLevel | undefined } {
    const action = wf.actions.find((a) => a.key === run.action);
    return { action, level: action?.approval?.levels.find((l) => l.key === key) };
  }

  /** Active approvers of a level, never the requester (no self-approval). */
  private async approversFor(level: ApprovalLevel, record: RecordInfo, requesterId: string) {
    const ids = await this.directory.resolve(level.approvers, record, requesterId);
    return ids.filter((id) => id !== requesterId);
  }

  private noApprover(level: ApprovalLevel, lang?: string) {
    return new AppError(
      409,
      'NO_APPROVER',
      `Nobody can approve "${pickText(level.label, lang ?? 'en')}". Ask your administrator to set the approvers.`,
    );
  }

  /** Creates the tasks of a level, their timers and the "approval needed" messages. */
  private async startLevel(
    inst: WorkflowInstance,
    record: RecordInfo,
    entity: EntityDef | undefined,
    level: ApprovalLevel,
    assignees: string[],
    actorName: string,
    session: ClientSession,
  ): Promise<void> {
    const Tasks = await this.tasks();
    const now = this.clock.now();
    const vars = recordVars(record, entity);
    for (const assigneeId of assignees) {
      const remindAt = level.remindAfterHours
        ? new Date(now.getTime() + level.remindAfterHours * HOUR)
        : null;
      const escalateAt = level.escalateAfterHours
        ? new Date(now.getTime() + level.escalateAfterHours * HOUR)
        : null;
      const [task] = await Tasks.create(
        [
          {
            instanceId: String(inst._id),
            entity: inst.entity,
            recordId: inst.recordId,
            recordTitle: vars.record.title,
            orgPath: record.orgPath,
            requesterId: inst.requesterId,
            level: level.key,
            levelLabel: level.label,
            mode: level.mode,
            assigneeId,
            remindAt,
            escalateAt,
          },
        ],
        { session },
      );
      const due = [remindAt, escalateAt].filter((d): d is Date => !!d).sort((a, b) => +a - +b)[0];
      if (due) await this.jobs.put('task', String(task._id), due, undefined, session);
      await this.outbox.record(
        EventTypes.ApprovalTaskCreated,
        {
          taskId: String(task._id),
          entity: inst.entity,
          recordId: inst.recordId,
          level: level.key,
          assigneeId,
        },
        { session },
      );
    }
    await this.notify(
      {
        userIds: await this.withDelegates(assignees),
        template: 'approval.requested',
        channels: ['inapp', 'email', 'whatsapp', 'push'],
        vars: { ...vars, actor: { name: actorName }, level: level.label },
        link: '/approvals',
        orgPath: record.orgPath,
        essential: true,
      },
      session,
    );
    // The daily digest of this company, at 08:00 in its time zone.
    const cfg = await this.cfgFor('/');
    await this.jobs.ensure(
      'digest',
      'daily',
      nextRun(now, 'day', '08:00', cfg.tenant.timezone ?? 'UTC'),
    );
  }

  private async actorName(): Promise<string> {
    const actor = requireContext().actor;
    if (actor?.type !== 'user') return 'global-erp';
    return (await this.directory.user(actor.id))?.name ?? '';
  }

  // ---- queries ----

  /** The record's state, what I can do, and its history. */
  async view(entity: string, id: string) {
    const record = await this.record(entity, id);
    const ctx = requireContext();
    if (
      !hasPermission({ acl: ctx.acl ?? [] }, recordPermission(entity, 'read'), this.path(record))
    ) {
      throw AppError.forbidden('You do not have permission to read this');
    }
    const cfg = await this.cfgFor(record.orgPath);
    const wf = workflowFor(cfg, entity);
    if (!wf) return { workflow: false as const };
    const Instances = await this.instances();
    const inst = await Instances.findOne({ entity, recordId: id }).lean();
    const state = inst?.state ?? record.status ?? wf.initialState;
    const me = ctx.actor!.id;
    const [myTaskIds, pending] = await this.pendingFor(inst, me);
    const actions = await this.availableActions(wf, record, state, !!inst?.approval);
    const users = await this.directory.users([
      ...(inst?.history ?? []).flatMap((h) => [h.by, h.onBehalfOf ?? '']),
      ...pending.map((t) => t.assigneeId),
    ]);
    const name = (uid: string) => users.get(uid)?.name ?? (uid === 'system' ? 'System' : uid);
    const st = stateOf(wf, state);
    return {
      workflow: true as const,
      state,
      stateLabel: st?.label ?? { en: state },
      color: st?.color ?? null,
      locked: !!st?.locked,
      states: wf.states.map((s) => ({ key: s.key, label: s.label, color: s.color ?? null })),
      actions,
      myTaskIds,
      pending: pending.map((t) => ({
        id: String(t._id),
        level: t.level,
        levelLabel: t.levelLabel,
        assigneeId: t.assigneeId,
        assigneeName: name(t.assigneeId),
      })),
      history: (inst?.history ?? []).map((h) => ({
        ...h,
        byName: name(h.by),
        onBehalfOfName: h.onBehalfOf ? name(h.onBehalfOf) : null,
      })),
    };
  }

  private async pendingFor(inst: WorkflowInstance | null, me: string) {
    if (!inst?.approval) return [[], []] as [string[], ApprovalTask[]];
    const Tasks = await this.tasks();
    const pending = await Tasks.find({ instanceId: String(inst._id), status: 'pending' }).lean();
    const delegators = new Set(await this.directory.delegatorsOf(me));
    const mine = pending
      .filter((t) => (t.assigneeId === me || delegators.has(t.assigneeId)) && t.requesterId !== me)
      .map((t) => String(t._id));
    return [mine, pending] as [string[], ApprovalTask[]];
  }

  /** Actions the signed-in user may take now (buttons on the record page). */
  private async availableActions(
    wf: WorkflowDef,
    record: RecordInfo,
    state: string,
    approvalRunning: boolean,
  ) {
    const me = requireContext().actor!.id;
    const out: { key: string; label: Record<string, string>; commentRequired: boolean }[] = [];
    for (const a of wf.actions) {
      if (!a.from.includes(state)) continue;
      if (approvalRunning && a.approval) continue;
      try {
        await this.checkActor(a, record, me);
      } catch {
        continue;
      }
      const env = await this.env([a.condition], record, me, state);
      if (!conditionHolds(a.condition, record.data, env)) continue;
      out.push({ key: a.key, label: a.label, commentRequired: !!a.commentRequired });
    }
    return out;
  }

  private async checkActor(action: WorkflowAction, record: RecordInfo, userId: string) {
    const ctx = requireContext();
    if (
      !hasPermission(
        { acl: ctx.acl ?? [] },
        recordPermission(record.entity, 'update'),
        this.path(record),
      )
    ) {
      throw AppError.forbidden('You do not have permission to change this');
    }
    if (action.requesterOnly && record.createdBy !== userId) {
      throw AppError.forbidden('Only the person who created this can do that');
    }
    if (action.roleIds?.length) {
      const roles = await this.directory.roles(userId);
      const held = roles.idsAt(record.orgPath);
      if (!action.roleIds.some((r) => held.has(r))) {
        throw AppError.forbidden('Your role cannot do this');
      }
    }
  }

  // ---- actions ----

  /**
   * Runs a workflow action (Submit, Cancel…). With `system`, an automation runs it: no
   * user checks, and `depth` carries the automation chain length.
   */
  async act(
    entity: string,
    id: string,
    actionKey: string,
    comment: string | undefined,
    opts: { system?: boolean; depth?: number } = {},
  ) {
    const record = await this.record(entity, id);
    const cfg = await this.cfgFor(record.orgPath);
    const wf = this.workflow(cfg, entity);
    const action = wf.actions.find((a) => a.key === actionKey);
    if (!action) throw AppError.notFound('Action');
    const entityDef = findEntity(cfg, entity);
    const actor = requireContext().actor!;
    const userId = opts.system ? null : actor.id;
    const lang = requireContext().lang;

    await this.retrying(async () => {
      const inst = await this.instanceFor(record);
      const state = inst.state ?? wf.initialState;
      if (!action.from.includes(state) || (inst.approval && action.approval)) {
        throw new AppError(409, 'ACTION_NOT_AVAILABLE', 'This action is not available now');
      }
      if (userId) await this.checkActor(action, record, userId);
      if (action.commentRequired && !comment?.trim()) {
        throw AppError.badRequest('Please add a comment');
      }
      const texts = [action.condition, ...(action.approval?.levels.map((l) => l.condition) ?? [])];
      const env = await this.env(texts, record, userId, state);
      if (!conditionHolds(action.condition, record.data, env)) {
        throw new AppError(409, 'CONDITION_NOT_MET', 'The conditions for this action are not met');
      }

      let target = action.to;
      let run: ApprovalRun | null = null;
      let first: { level: ApprovalLevel; assignees: string[] } | undefined;
      if (action.approval) {
        const levels = action.approval.levels.filter((l) =>
          conditionHolds(l.condition, record.data, env),
        );
        if (!levels.length) target = action.approval.approvedState;
        else {
          const assignees = await this.approversFor(levels[0], record, inst.requesterId);
          if (!assignees.length) throw this.noApprover(levels[0], lang);
          first = { level: levels[0], assignees };
          run = {
            action: action.key,
            pendingState: action.to,
            approvedState: action.approval.approvedState,
            rejectedState: action.approval.rejectedState,
            levels: levels.map((l) => l.key),
            current: 0,
            startedAt: this.clock.now(),
          };
        }
      }
      const by = userId ?? 'system';
      const actorName = await this.actorName();
      const Tasks = await this.tasks();
      await this.commit(
        inst,
        {
          set: {
            state: target,
            approval: run,
            statusSync: { from: state, to: target, action: action.key },
          },
          history: [
            { at: this.clock.now(), by, action: action.key, from: state, to: target, comment },
          ],
        },
        async (session) => {
          if (inst.approval) {
            // Leaving an approval (e.g. Cancel while pending): open tasks are withdrawn.
            const open = await Tasks.find(
              { instanceId: String(inst._id), status: 'pending' },
              { _id: 1 },
              { session },
            ).lean();
            await Tasks.updateMany(
              { instanceId: String(inst._id), status: 'pending' },
              { $set: { status: 'cancelled', decidedAt: this.clock.now() } },
              { session },
            );
            await this.jobs.removeMany(
              'task',
              open.map((t) => String(t._id)),
              session,
            );
          }
          if (first) {
            await this.startLevel(
              inst,
              record,
              entityDef,
              first.level,
              first.assignees,
              actorName,
              session,
            );
          }
          await this.jobs.put(
            'status_sync',
            String(inst._id),
            new Date(this.clock.now().getTime() + 30_000),
            undefined,
            session,
          );
          await this.outbox.record(
            EventTypes.WorkflowActionTaken,
            {
              entity,
              recordId: id,
              action: action.key,
              from: state,
              to: target,
              comment: comment ?? null,
            },
            { session },
          );
        },
      );
      await this.pushStatus(inst._id, opts.depth ?? 0);
    });
    return opts.system ? { ok: true } : this.view(entity, id);
  }

  // ---- approvals ----

  /** Pending (or decided) tasks of the signed-in user and of those they stand in for. */
  async myTasks(status: 'pending' | 'done', page: number, pageSize: number) {
    const me = requireContext().actor!.id;
    const delegators = await this.directory.delegatorsOf(me);
    const Tasks = await this.tasks();
    const filter =
      status === 'pending'
        ? { assigneeId: { $in: [me, ...delegators] }, status: 'pending', requesterId: { $ne: me } }
        : { $or: [{ decidedBy: me }, { assigneeId: me }], status: { $ne: 'pending' } };
    const [items, total] = await Promise.all([
      Tasks.find(filter)
        .sort({ createdAt: status === 'pending' ? 1 : -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Tasks.countDocuments(filter),
    ]);
    const users = await this.directory.users(items.flatMap((t) => [t.assigneeId, t.requesterId]));
    return {
      items: items.map((t) => ({
        id: String(t._id),
        entity: t.entity,
        recordId: t.recordId,
        recordTitle: t.recordTitle,
        level: t.level,
        levelLabel: t.levelLabel,
        status: t.status,
        requesterName: users.get(t.requesterId)?.name ?? '',
        onBehalfOf: t.assigneeId !== me ? (users.get(t.assigneeId)?.name ?? t.assigneeId) : null,
        remindAt: t.remindAt ?? null,
        escalateAt: t.escalateAt ?? null,
        decidedAt: t.decidedAt ?? null,
        comment: t.comment ?? null,
        createdAt: t.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async pendingCount() {
    const me = requireContext().actor!.id;
    const delegators = await this.directory.delegatorsOf(me);
    const n = await (
      await this.tasks()
    ).countDocuments({
      assigneeId: { $in: [me, ...delegators] },
      status: 'pending',
      requesterId: { $ne: me },
    });
    return { pending: n };
  }

  /** Approves or rejects several tasks; each is decided on its own. */
  async decideMany(taskIds: string[], decision: 'approve' | 'reject', comment?: string) {
    const results: { taskId: string; ok: boolean; error?: string }[] = [];
    for (const taskId of taskIds) {
      try {
        await this.decide(taskId, decision, comment);
        results.push({ taskId, ok: true });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ taskId, ok: false, error: e.message });
      }
    }
    return { results };
  }

  async decide(taskId: string, decision: 'approve' | 'reject', comment?: string) {
    if (!Types.ObjectId.isValid(taskId)) throw AppError.notFound('Task');
    const me = requireContext().actor!.id;
    const lang = requireContext().lang;
    const Tasks = await this.tasks();
    await this.retrying(async () => {
      const task = await Tasks.findById(taskId).lean();
      if (!task) throw AppError.notFound('Task');
      if (task.status !== 'pending') throw AppError.conflict('This request was already decided');
      let onBehalfOf: string | undefined;
      if (task.assigneeId !== me) {
        if ((await this.directory.delegateOf(task.assigneeId)) !== me) {
          throw AppError.forbidden('This request is not assigned to you');
        }
        onBehalfOf = task.assigneeId;
      }
      if (task.requesterId === me) {
        throw AppError.forbidden('You cannot approve your own request');
      }
      const inst = await (await this.instances()).findById(task.instanceId).lean();
      if (!inst?.approval) throw AppError.conflict('This request was already decided');
      const run = inst.approval;
      const record = await this.record(inst.entity, inst.recordId);
      const cfg = await this.cfgFor(record.orgPath);
      const wf = this.workflow(cfg, inst.entity);
      const entityDef = findEntity(cfg, inst.entity);
      const now = this.clock.now();
      const vars = recordVars(record, entityDef);
      const actorName = await this.actorName();
      const decided = {
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: now,
        decidedBy: me,
        onBehalfOf,
        comment,
      };
      const entry: HistoryEntry = {
        at: now,
        by: me,
        onBehalfOf,
        action: decision,
        from: inst.state,
        to: inst.state,
        comment,
        level: task.level,
      };
      const decidedEvent = (session: ClientSession) =>
        this.outbox.record(
          EventTypes.ApprovalTaskDecided,
          {
            taskId,
            entity: inst.entity,
            recordId: inst.recordId,
            level: task.level,
            decision,
            onBehalfOf: onBehalfOf ?? null,
          },
          { session },
        );
      const closeOpen = async (session: ClientSession, filter: Record<string, unknown>) => {
        const open = await Tasks.find(
          { instanceId: String(inst._id), status: 'pending', _id: { $ne: task._id }, ...filter },
          { _id: 1 },
          { session },
        ).lean();
        await Tasks.updateMany(
          { _id: { $in: open.map((t) => t._id) } },
          { $set: { status: 'cancelled', decidedAt: now } },
          { session },
        );
        await this.jobs.removeMany(
          'task',
          open.map((t) => String(t._id)),
          session,
        );
      };

      if (decision === 'reject') {
        const to = run.rejectedState;
        await this.commit(
          inst,
          {
            set: {
              state: to,
              approval: null,
              statusSync: { from: inst.state, to, action: 'reject' },
            },
            history: [{ ...entry, to }],
          },
          async (session) => {
            await Tasks.updateOne(
              { _id: task._id, status: 'pending' },
              { $set: decided },
              { session },
            );
            await this.jobs.remove('task', taskId, session);
            await closeOpen(session, {});
            await decidedEvent(session);
            await this.jobs.put(
              'status_sync',
              String(inst._id),
              new Date(now.getTime() + 30_000),
              undefined,
              session,
            );
            await this.notify(
              {
                userIds: [inst.requesterId],
                template: 'approval.rejected',
                channels: ['inapp', 'email', 'push'],
                vars: { ...vars, actor: { name: actorName }, comment: comment ?? '' },
                link: recordLink(inst.entity, inst.recordId),
                orgPath: record.orgPath,
              },
              session,
            );
          },
        );
        await this.pushStatus(inst._id);
        return;
      }

      // Approve: is the level complete?
      const othersPending = await Tasks.countDocuments({
        instanceId: String(inst._id),
        level: task.level,
        status: 'pending',
        _id: { $ne: task._id },
      });
      const levelDone = task.mode === 'any' || othersPending === 0;
      if (!levelDone) {
        await this.commit(inst, { history: [entry] }, async (session) => {
          await Tasks.updateOne(
            { _id: task._id, status: 'pending' },
            { $set: decided },
            { session },
          );
          await this.jobs.remove('task', taskId, session);
          await decidedEvent(session);
        });
        return;
      }

      const next = await this.nextLevel(wf, run, record, inst.requesterId, run.current + 1, lang);
      if (next) {
        await this.commit(
          inst,
          { set: { approval: { ...run, current: next.index } }, history: [entry] },
          async (session) => {
            await Tasks.updateOne(
              { _id: task._id, status: 'pending' },
              { $set: decided },
              { session },
            );
            await this.jobs.remove('task', taskId, session);
            await closeOpen(session, { level: task.level });
            await decidedEvent(session);
            await this.startLevel(
              inst,
              record,
              entityDef,
              next.level,
              next.assignees,
              actorName,
              session,
            );
          },
        );
        return;
      }
      const to = run.approvedState;
      await this.commit(
        inst,
        {
          set: {
            state: to,
            approval: null,
            statusSync: { from: inst.state, to, action: 'approve' },
          },
          history: [{ ...entry, to }],
        },
        async (session) => {
          await Tasks.updateOne(
            { _id: task._id, status: 'pending' },
            { $set: decided },
            { session },
          );
          await this.jobs.remove('task', taskId, session);
          await closeOpen(session, {});
          await decidedEvent(session);
          await this.jobs.put(
            'status_sync',
            String(inst._id),
            new Date(now.getTime() + 30_000),
            undefined,
            session,
          );
          await this.notify(
            {
              userIds: [inst.requesterId],
              template: 'approval.approved',
              channels: ['inapp', 'email', 'push'],
              vars: { ...vars, actor: { name: actorName } },
              link: recordLink(inst.entity, inst.recordId),
              orgPath: record.orgPath,
            },
            session,
          );
        },
      );
      await this.pushStatus(inst._id);
    });
    return { ok: true };
  }

  /** The next level that still exists in the config, with its approvers. */
  private async nextLevel(
    wf: WorkflowDef,
    run: ApprovalRun,
    record: RecordInfo,
    requesterId: string,
    from: number,
    lang?: string,
  ) {
    for (let i = from; i < run.levels.length; i++) {
      const { level } = this.levelDef(wf, run, run.levels[i]);
      if (!level) continue; // removed from the config since the request started
      const assignees = await this.approversFor(level, record, requesterId);
      if (!assignees.length) throw this.noApprover(level, lang);
      return { index: i, level, assignees };
    }
    return undefined;
  }

  // ---- timers ----

  /** A task's reminder or escalation time came. */
  async onTaskTimer(taskId: string): Promise<void> {
    const Tasks = await this.tasks();
    const task = await Tasks.findById(taskId).lean();
    if (!task || task.status !== 'pending') return;
    const now = this.clock.now();
    const inst = await (await this.instances()).findById(task.instanceId).lean();
    if (!inst?.approval) return;
    const record = await this.record(inst.entity, inst.recordId);
    const cfg = await this.cfgFor(record.orgPath);
    const wf = workflowFor(cfg, inst.entity);
    const entityDef = findEntity(cfg, inst.entity);
    const vars = recordVars(record, entityDef);

    if (task.escalateAt && task.escalateAt <= now) {
      await this.escalate(task, inst, record, wf, entityDef);
      return;
    }
    if (task.remindAt && task.remindAt <= now && !task.reminded) {
      await this.conn.transaction(async (session) => {
        await Tasks.updateOne({ _id: task._id }, { $set: { reminded: true } }, { session });
        if (task.escalateAt)
          await this.jobs.put('task', taskId, task.escalateAt, undefined, session);
        else await this.jobs.remove('task', taskId, session);
        await this.outbox.record(
          EventTypes.ApprovalTaskReminded,
          { taskId, entity: inst.entity, recordId: inst.recordId, assigneeId: task.assigneeId },
          { session },
        );
        await this.notify(
          {
            userIds: await this.withDelegates([task.assigneeId]),
            template: 'approval.reminder',
            channels: ['inapp', 'email', 'whatsapp', 'push'],
            vars,
            link: '/approvals',
            orgPath: record.orgPath,
            essential: true,
          },
          session,
        );
      });
    }
  }

  /**
   * Escalation: the task goes to the level's "escalate to" people. Without them, the
   * level is skipped and the next one starts; on the last level the task stays with
   * its approver, who is reminded again.
   */
  private async escalate(
    task: ApprovalTask,
    inst: WorkflowInstance,
    record: RecordInfo,
    wf: WorkflowDef | undefined,
    entityDef: EntityDef | undefined,
  ): Promise<void> {
    const run = inst.approval!;
    const Tasks = await this.tasks();
    const now = this.clock.now();
    const { level } = wf ? this.levelDef(wf, run, task.level) : { level: undefined };
    const entry: HistoryEntry = {
      at: now,
      by: 'system',
      action: 'escalate',
      from: inst.state,
      to: inst.state,
      level: task.level,
    };
    const escalated = { status: 'escalated', decidedAt: now, decidedBy: 'system' };

    if (level?.escalateTo?.length) {
      const current = await Tasks.find({
        instanceId: String(inst._id),
        level: task.level,
        status: 'pending',
      }).lean();
      const targets = (
        await this.directory.resolve(level.escalateTo, record, inst.requesterId)
      ).filter((id) => id !== inst.requesterId && !current.some((t) => t.assigneeId === id));
      if (targets.length) {
        // The new approvers get a reminder time but no further escalation.
        const next = { ...level, escalateAfterHours: undefined };
        await this.retrying(async () => {
          const fresh = (await (await this.instances()).findById(inst._id).lean())!;
          await this.commit(fresh, { history: [entry] }, async (session) => {
            await Tasks.updateOne(
              { _id: task._id, status: 'pending' },
              { $set: escalated },
              { session },
            );
            await this.jobs.remove('task', String(task._id), session);
            await this.outbox.record(
              EventTypes.ApprovalTaskEscalated,
              {
                taskId: String(task._id),
                entity: inst.entity,
                recordId: inst.recordId,
                level: task.level,
                to: targets,
              },
              { session },
            );
            await this.startLevelAs(fresh, record, entityDef, next, targets, session);
          });
        });
        return;
      }
    }

    const hasNext = run.current + 1 < run.levels.length;
    if (hasNext && !level?.escalateTo?.length) {
      await this.retrying(async () => {
        const fresh = (await (await this.instances()).findById(inst._id).lean())!;
        if (!fresh.approval || fresh.approval.levels[fresh.approval.current] !== task.level) return;
        const next = await this.nextLevel(
          wf!,
          fresh.approval,
          record,
          fresh.requesterId,
          fresh.approval.current + 1,
        ).catch(() => undefined);
        if (!next) return;
        await this.commit(
          fresh,
          { set: { approval: { ...fresh.approval, current: next.index } }, history: [entry] },
          async (session) => {
            const open = await Tasks.find(
              { instanceId: String(inst._id), level: task.level, status: 'pending' },
              { _id: 1 },
              { session },
            ).lean();
            await Tasks.updateMany(
              { _id: { $in: open.map((t) => t._id) } },
              { $set: escalated },
              { session },
            );
            await this.jobs.removeMany(
              'task',
              open.map((t) => String(t._id)),
              session,
            );
            await this.outbox.record(
              EventTypes.ApprovalTaskEscalated,
              {
                taskId: String(task._id),
                entity: inst.entity,
                recordId: inst.recordId,
                level: task.level,
                to: next.assignees,
              },
              { session },
            );
            await this.startLevelAs(fresh, record, entityDef, next.level, next.assignees, session);
          },
        );
      });
      return;
    }

    // Last level, nobody to escalate to: remind the approver again and stop the timer.
    await this.conn.transaction(async (session) => {
      await Tasks.updateOne(
        { _id: task._id },
        { $set: { escalateAt: null, reminded: true } },
        { session },
      );
      await this.jobs.remove('task', String(task._id), session);
      await this.notify(
        {
          userIds: await this.withDelegates([task.assigneeId]),
          template: 'approval.reminder',
          channels: ['inapp', 'email', 'whatsapp', 'push'],
          vars: recordVars(record, entityDef),
          link: '/approvals',
          orgPath: record.orgPath,
          essential: true,
        },
        session,
      );
    });
  }

  /** `startLevel` for escalations, announced with the "escalated" message. */
  private async startLevelAs(
    inst: WorkflowInstance,
    record: RecordInfo,
    entityDef: EntityDef | undefined,
    level: ApprovalLevel,
    assignees: string[],
    session: ClientSession,
  ) {
    await this.startLevel(inst, record, entityDef, level, assignees, 'global-erp', session);
    await this.notify(
      {
        userIds: await this.withDelegates(assignees),
        template: 'approval.escalated',
        channels: ['inapp', 'email', 'push'],
        vars: recordVars(record, entityDef),
        link: '/approvals',
        orgPath: record.orgPath,
        essential: true,
      },
      session,
    );
  }

  /** The daily digest: one message per approver with the number of requests waiting. */
  async sendDigest(): Promise<void> {
    const Tasks = await this.tasks();
    const counts = await Tasks.aggregate<{ _id: string; count: number }>([
      { $match: { tenantId: requireContext().tenantId, status: 'pending' } },
      { $group: { _id: '$assigneeId', count: { $sum: 1 } } },
    ]);
    if (!counts.length) return;
    await this.conn.transaction(async (session) => {
      for (const c of counts) {
        await this.notify(
          {
            userIds: [c._id],
            template: 'approval.digest',
            channels: ['email'],
            vars: { count: c.count },
            link: '/approvals',
          },
          session,
        );
      }
    });
  }
}
