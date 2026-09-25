import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Internal, RequirePermissions } from '@erp/auth';
import { paginationSchema, taskDecisionSchema, workflowActionSchema } from '@erp/contracts';
import { AppError, ApiZodBody, ZodPipe } from '@erp/service-kit';
import { AutomationService } from './automation.service';
import { AdjustableClock, CLOCK, WORKFLOW_ENV, type Clock, type WorkflowEnv } from './clients';
import { Scheduler } from './scheduler';
import { WorkflowService } from './workflow.service';

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const key = (v: string, what: string) => {
  if (!KEY_RE.test(v)) throw AppError.notFound(what);
  return v;
};
const id = (v: string) => {
  if (!/^[a-f0-9]{24}$/.test(v)) throw AppError.notFound('Record');
  return v;
};

const tasksQuery = paginationSchema.extend({
  status: z.enum(['pending', 'done']).default('pending'),
});
const runsQuery = paginationSchema.extend({
  status: z.enum(['running', 'ok', 'failed', 'skipped']).optional(),
});

@ApiTags('workflow')
@ApiBearerAuth()
@Controller('api/v1/workflow')
export class WorkflowController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly automations: AutomationService,
  ) {}

  /** State, available actions, open approvals and history of a record. */
  @Get('records/:entity/:id')
  view(@Param('entity') entity: string, @Param('id') recordId: string) {
    return this.workflow.view(key(entity, 'Entity'), id(recordId));
  }

  @Post('records/:entity/:id/actions/:action')
  @HttpCode(200)
  @ApiZodBody(workflowActionSchema)
  act(
    @Param('entity') entity: string,
    @Param('id') recordId: string,
    @Param('action') action: string,
    @Body(new ZodPipe(workflowActionSchema)) body: z.infer<typeof workflowActionSchema>,
  ) {
    return this.workflow.act(
      key(entity, 'Entity'),
      id(recordId),
      key(action, 'Action'),
      body.comment,
    );
  }

  /** My approvals inbox, including requests of people I stand in for. */
  @Get('tasks')
  tasks(@Query(new ZodPipe(tasksQuery)) q: z.infer<typeof tasksQuery>) {
    return this.workflow.myTasks(q.status, q.page, q.pageSize);
  }

  @Get('tasks/count')
  count() {
    return this.workflow.pendingCount();
  }

  @Post('tasks/decide')
  @HttpCode(200)
  @ApiZodBody(taskDecisionSchema)
  decide(@Body(new ZodPipe(taskDecisionSchema)) body: z.infer<typeof taskDecisionSchema>) {
    return this.workflow.decideMany(body.taskIds, body.decision, body.comment);
  }

  @Get('automation-runs')
  @RequirePermissions('workflow.automation.manage')
  runs(@Query(new ZodPipe(runsQuery)) q: z.infer<typeof runsQuery>) {
    return this.automations.listRuns(q.status, q.page, q.pageSize);
  }

  @Post('automation-runs/:id/retry')
  @HttpCode(200)
  @RequirePermissions('workflow.automation.manage')
  retry(@Param('id') runId: string) {
    return this.automations.retryRun(runId);
  }

  /** The secret receivers use to check `X-Erp-Signature` on webhooks. */
  @Get('webhook-secret')
  @RequirePermissions('workflow.automation.manage')
  async secret() {
    return { secret: await this.automations.webhookSecret() };
  }

  @Post('webhook-secret/rotate')
  @HttpCode(200)
  @RequirePermissions('workflow.automation.manage')
  async rotate() {
    return { secret: await this.automations.rotateWebhookSecret() };
  }
}

const runSchema = z.object({ now: z.string().datetime().optional() });

@Controller('internal/workflow')
@Internal()
export class InternalWorkflowController {
  constructor(
    private readonly scheduler: Scheduler,
    @Inject(WORKFLOW_ENV) private readonly env: WorkflowEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs due jobs now. Outside production, `now` moves this service's clock forward so
   * tests can check reminders and escalations without waiting.
   */
  @Post('scheduler/run')
  @HttpCode(200)
  async run(@Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>) {
    if (body.now && this.env.NODE_ENV === 'production') {
      throw AppError.forbidden('Not available in production');
    }
    if (body.now) {
      if (!(this.clock instanceof AdjustableClock)) throw AppError.forbidden('Clock is fixed');
      this.clock.set(new Date(body.now));
    }
    return { ran: await this.scheduler.runDue() };
  }
}
