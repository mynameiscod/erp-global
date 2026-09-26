import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { REPORTING_ENV, type ReportingEnv } from './clients';
import { ExportsService } from './exports.service';
import { SchedulesService } from './schedules.service';

/** Runs queued exports and due schedules, polling (and when an export is asked for). */
@Injectable()
export class Worker implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private stopped = false;

  constructor(
    @Inject(REPORTING_ENV) private readonly env: ReportingEnv,
    private readonly exports: ExportsService,
    private readonly schedules: SchedulesService,
    private readonly log: PinoLogger,
  ) {}

  start(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const tick = async () => {
      if (this.stopped) return;
      await this.runDue().catch((err) => this.log.error({ err }, 'reporting worker tick failed'));
      if (!this.stopped) this.timer = setTimeout(tick, this.env.SCHEDULER_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, 1000);
  }

  /** Starts a pass now, e.g. right after an export is requested. */
  kick(): void {
    if (this.env.SCHEDULER_ENABLED && !this.stopped) {
      void this.runDue().catch((err) => this.log.error({ err }, 'reporting worker failed'));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Runs every waiting export and due schedule. Returns how many ran. */
  runDue(): Promise<number> {
    const run = async () => {
      let count = 0;
      for (let i = 0; i < 50; i++) {
        const did = await this.exports.runNext().catch((err) => {
          this.log.error({ err }, 'export failed');
          return true;
        });
        if (!did) break;
        count++;
      }
      for (let i = 0; i < 100; i++) {
        if (!(await this.schedules.runNext())) break;
        count++;
      }
      return count;
    };
    // One pass at a time in this process.
    this.running = (this.running ?? Promise.resolve(0)).then(run, run);
    return this.running;
  }
}
