import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { runAsTenant } from '@erp/tenancy';
import { AutomationService } from './automation.service';
import { CLOCK, WORKFLOW_ENV, type Clock, type WorkflowEnv } from './clients';
import { JobStore } from './jobs';
import type { Job } from './models';
import { WorkflowService } from './workflow.service';
import { nextRun } from './zoned-time';

const SYSTEM = { type: 'system' as const, id: 'workflow-service' };

/**
 * Polls the jobs collection and runs what is due: approval reminders and escalations,
 * scheduled automations, daily digests and retries of state copies.
 */
@Injectable()
export class Scheduler implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private stopped = false;

  constructor(
    @Inject(WORKFLOW_ENV) private readonly env: WorkflowEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobStore,
    private readonly workflow: WorkflowService,
    private readonly automations: AutomationService,
    private readonly log: PinoLogger,
  ) {}

  start(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const tick = async () => {
      if (this.stopped) return;
      await this.runDue().catch((err) => this.log.error({ err }, 'scheduler tick failed'));
      if (!this.stopped) this.timer = setTimeout(tick, this.env.SCHEDULER_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, 1000);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Runs every job due by `now` (the clock by default). Returns how many ran. */
  runDue(now?: Date): Promise<number> {
    const run = async () => {
      let count = 0;
      const until = now ?? this.clock.now();
      for (let i = 0; i < 500; i++) {
        const job = await this.jobs.claim(until);
        if (!job) break;
        count++;
        await this.execute(job, until);
      }
      return count;
    };
    // One pass at a time in this process.
    this.running = (this.running ?? Promise.resolve(0)).then(run, run);
    return this.running;
  }

  private async execute(job: Job, now: Date): Promise<void> {
    try {
      await runAsTenant(job.tenantId, SYSTEM, async () => {
        switch (job.kind) {
          case 'task':
            await this.workflow.onTaskTimer(job.key);
            return this.jobs.finish(job);
          case 'status_sync':
            if (await this.workflow.pushStatus(job.key)) return this.jobs.finish(job);
            return this.jobs.retryLater(job);
          case 'schedule': {
            const next = await this.automations.runSchedule(job.key, job.dueAt);
            if (next) return this.jobs.put('schedule', job.key, next, job.data);
            return this.jobs.remove('schedule', job.key);
          }
          case 'digest': {
            await this.workflow.sendDigest();
            const cfg = await this.workflow.cfgFor('/');
            return this.jobs.put(
              'digest',
              job.key,
              nextRun(now, 'day', '08:00', cfg.tenant.timezone ?? 'UTC'),
            );
          }
        }
      });
    } catch (err) {
      this.log.error(
        { err, job: { kind: job.kind, key: job.key, tenantId: job.tenantId } },
        'job failed',
      );
      await this.jobs.retryLater(job);
    }
  }
}
