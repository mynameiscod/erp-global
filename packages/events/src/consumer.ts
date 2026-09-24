import { Schema, type ClientSession, type Connection, type Model } from 'mongoose';
import type { EventEnvelope } from '@erp/contracts';
import { runAsTenant } from '@erp/tenancy';

interface ProcessedDoc {
  _id: string;
  consumer: string;
  eventId: string;
  processedAt: Date;
}

const processedSchema = new Schema<ProcessedDoc>(
  {
    _id: { type: String },
    consumer: { type: String, required: true },
    eventId: { type: String, required: true },
    processedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'processed_events', versionKey: false },
);
// Redelivery can only happen within the stream's retention, so old markers can go.
processedSchema.index({ processedAt: 1 }, { expireAfterSeconds: 45 * 24 * 3600 });

function processedModel(conn: Connection): Model<ProcessedDoc> {
  return (
    (conn.models.ProcessedEvent as Model<ProcessedDoc>) ??
    conn.model('ProcessedEvent', processedSchema)
  );
}

export async function ensureConsumerIndexes(conn: Connection): Promise<void> {
  await processedModel(conn).init();
}

/** For handlers with side effects outside the database (email, webhooks): check before acting. */
export async function alreadyProcessed(
  conn: Connection,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  return !!(await processedModel(conn).exists({ _id: `${consumer}:${eventId}` }));
}

/**
 * Runs `fn` exactly once per (consumer, event), in the event's tenant context
 * and in one transaction with the "processed" marker. A redelivered event is
 * skipped; a failed handler rolls back and the event is retried.
 *
 * `fn` may run more than once (transactions retry on transient errors), so it
 * must only write to the database. Do external side effects before calling this.
 */
export async function handleOnce(
  conn: Connection,
  consumer: string,
  event: EventEnvelope,
  fn: (session: ClientSession) => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  return runAsTenant(
    event.tenantId,
    event.actor,
    async () => {
      const Processed = processedModel(conn);
      const key = `${consumer}:${event.eventId}`;
      if (await Processed.exists({ _id: key })) return 'duplicate' as const;
      try {
        await conn.transaction(async (session) => {
          await Processed.create([{ _id: key, consumer, eventId: event.eventId }], { session });
          await fn(session);
        });
        return 'processed' as const;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return 'duplicate' as const;
        throw err;
      }
    },
    event.correlationId,
  );
}
