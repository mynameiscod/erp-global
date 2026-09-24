import { randomUUID } from 'node:crypto';
import { Schema, type ClientSession, type Connection, type Model } from 'mongoose';
import { NOTIFY_SUBJECT_PREFIX, subjectFor, type EventEnvelope } from '@erp/contracts';
import { requireContext } from '@erp/tenancy';
import type { EventBus } from './bus';
import type { Logger } from './nats-bus';

export interface OutboxDoc {
  _id: string;
  subject: string;
  envelope: EventEnvelope;
  status: 'pending' | 'published';
  attempts: number;
  lockedUntil: Date;
  createdAt: Date;
  publishedAt?: Date;
}

const outboxSchema = new Schema<OutboxDoc>(
  {
    _id: { type: String },
    subject: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'published'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: () => new Date(0) },
    createdAt: { type: Date, default: () => new Date() },
    publishedAt: { type: Date },
  },
  { collection: 'outbox', versionKey: false, minimize: false },
);
outboxSchema.index({ status: 1, createdAt: 1 });
// Published rows are kept for a week for troubleshooting, then removed.
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export function outboxModel(conn: Connection): Model<OutboxDoc> {
  return (conn.models.Outbox as Model<OutboxDoc>) ?? conn.model<OutboxDoc>('Outbox', outboxSchema);
}

export interface RecordOptions {
  session: ClientSession;
  /** Override the tenant, e.g. for platform events about a tenant. Defaults to the context tenant. */
  tenantId?: string;
  version?: number;
}

/**
 * Writes events to the outbox in the same transaction as the data change.
 * If the transaction rolls back, the event is never published; if it commits,
 * the relay publishes it.
 */
export class OutboxWriter {
  constructor(
    private readonly conn: Connection,
    private readonly source: string,
  ) {}

  async record<T>(type: string, payload: T, opts: RecordOptions): Promise<EventEnvelope<T>> {
    const ctx = requireContext();
    const tenantId = opts.tenantId ?? ctx.tenantId;
    if (!tenantId) throw new Error(`Cannot record ${type}: no tenant`);
    const envelope: EventEnvelope<T> = {
      eventId: randomUUID(),
      type,
      version: opts.version ?? 1,
      tenantId,
      actor: ctx.actor ?? { type: 'system', id: this.source },
      occurredAt: new Date().toISOString(),
      correlationId: ctx.correlationId,
      source: this.source,
      payload,
    };
    await outboxModel(this.conn).create(
      [{ _id: envelope.eventId, subject: subjectFor(type), envelope }],
      { session: opts.session },
    );
    return envelope;
  }
}

/** Moves committed outbox rows to the bus. Safe to run in several replicas. */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly conn: Connection,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      await this.flush().catch((err) => this.log.error({ err }, 'outbox relay failed'));
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Publishes pending rows until none are left. Returns how many were published. */
  async flush(max = 500): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const Outbox = outboxModel(this.conn);
    let count = 0;
    try {
      while (count < max) {
        const now = new Date();
        const row = await Outbox.findOneAndUpdate(
          { status: 'pending', lockedUntil: { $lte: now } },
          { $set: { lockedUntil: new Date(now.getTime() + 30_000) }, $inc: { attempts: 1 } },
          { sort: { createdAt: 1 }, new: true },
        ).lean();
        if (!row) break;
        try {
          await this.bus.publish(row.subject, row.envelope, row._id);
          if (row.subject.startsWith(NOTIFY_SUBJECT_PREFIX)) {
            // Notification payloads can hold one-time links; do not keep them once handed over.
            await Outbox.deleteOne({ _id: row._id });
          } else {
            await Outbox.updateOne(
              { _id: row._id },
              { $set: { status: 'published', publishedAt: new Date() } },
            );
          }
          count++;
        } catch (err) {
          const backoff = Math.min(60_000, 500 * 2 ** Math.min(row.attempts, 7));
          await Outbox.updateOne(
            { _id: row._id },
            { $set: { lockedUntil: new Date(Date.now() + backoff) } },
          );
          this.log.warn({ err, eventId: row._id }, 'publish failed; will retry');
          break;
        }
      }
    } finally {
      this.running = false;
    }
    return count;
  }
}
