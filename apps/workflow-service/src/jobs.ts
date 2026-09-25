import { Inject, Injectable } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';
import { MONGO_CONNECTION } from '@erp/service-kit';
import { requireTenantId } from '@erp/tenancy';
import { CLOCK, type Clock } from './clients';
import { jobModel, type Job, type JobKind } from './models';

const LEASE_MS = 60_000;

/** Timers in the shared jobs collection (see `Job`). */
@Injectable()
export class JobStore {
  constructor(
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get Jobs() {
    return jobModel(this.conn);
  }

  /** Creates or moves a job of the current company. */
  async put(
    kind: JobKind,
    key: string,
    dueAt: Date,
    data?: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<void> {
    await this.Jobs.updateOne(
      { tenantId: requireTenantId(), kind, key },
      { $set: { dueAt, data, leaseUntil: null, attempts: 0 } },
      { upsert: true, session },
    );
  }

  /** Creates the job only if it does not exist yet (e.g. the daily digest). */
  async ensure(kind: JobKind, key: string, dueAt: Date, data?: Record<string, unknown>) {
    await this.Jobs.updateOne(
      { tenantId: requireTenantId(), kind, key },
      { $setOnInsert: { dueAt, data, leaseUntil: null, attempts: 0 } },
      { upsert: true },
    );
  }

  async remove(kind: JobKind, key: string, session?: ClientSession): Promise<void> {
    await this.Jobs.deleteOne({ tenantId: requireTenantId(), kind, key }, { session });
  }

  async removeMany(kind: JobKind, keys: string[], session?: ClientSession): Promise<void> {
    if (!keys.length) return;
    await this.Jobs.deleteMany(
      { tenantId: requireTenantId(), kind, key: { $in: keys } },
      { session },
    );
  }

  async list(kind: JobKind): Promise<Job[]> {
    return this.Jobs.find({ tenantId: requireTenantId(), kind }).lean();
  }

  /** Takes one due job for this worker, so replicas never run the same job twice at once. */
  async claim(now: Date): Promise<Job | null> {
    return this.Jobs.findOneAndUpdate(
      {
        dueAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: this.clock.now() } }],
      },
      {
        $set: { leaseUntil: new Date(this.clock.now().getTime() + LEASE_MS) },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { dueAt: 1 } },
    ).lean();
  }

  /** Done: remove it, unless it was moved while it ran. */
  async finish(job: Job): Promise<void> {
    await this.Jobs.deleteOne({ _id: job._id, dueAt: job.dueAt });
    await this.Jobs.updateOne({ _id: job._id }, { $set: { leaseUntil: null, attempts: 0 } });
  }

  /** Runs again later, backing off with each failure (1 min, 2, 4… up to an hour). */
  async retryLater(job: Job): Promise<void> {
    const wait = Math.min(60_000 * 2 ** Math.max(0, job.attempts - 1), 3_600_000);
    await this.Jobs.updateOne(
      { _id: job._id },
      { $set: { dueAt: new Date(this.clock.now().getTime() + wait), leaseUntil: null } },
    );
  }
}
