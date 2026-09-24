import {
  AckPolicy,
  connect,
  DeliverPolicy,
  JSONCodec,
  nanos,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type StreamConfig,
} from 'nats';
import {
  EVENTS_STREAM,
  EVENTS_SUBJECT_PREFIX,
  NOTIFY_STREAM,
  NOTIFY_SUBJECT_PREFIX,
  type EventEnvelope,
} from '@erp/contracts';
import type { EventBus, Subscription } from './bus';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const STREAMS: Partial<StreamConfig>[] = [
  {
    name: EVENTS_STREAM,
    subjects: [`${EVENTS_SUBJECT_PREFIX}>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(30 * DAY_MS),
    duplicate_window: nanos(2 * 60 * 1000),
  },
  {
    name: NOTIFY_STREAM,
    subjects: [`${NOTIFY_SUBJECT_PREFIX}>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: nanos(DAY_MS),
    duplicate_window: nanos(2 * 60 * 1000),
  },
];

/** JetStream-backed bus: durable streams, explicit acks, redelivery with back-off. */
export class NatsEventBus implements EventBus {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private readonly consumers: ConsumerMessages[] = [];
  private readonly codec = JSONCodec<EventEnvelope>();

  constructor(
    private readonly servers: string,
    private readonly name: string,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.nc = await connect({
      servers: this.servers.split(','),
      name: this.name,
      maxReconnectAttempts: -1,
    });
    this.jsm = await this.nc.jetstreamManager();
    this.js = this.nc.jetstream();
    for (const cfg of STREAMS) {
      try {
        await this.jsm.streams.info(cfg.name!);
        await this.jsm.streams.update(cfg.name!, cfg);
      } catch {
        await this.jsm.streams.add(cfg);
      }
    }
    this.log.info({ servers: this.servers }, 'connected to NATS');
  }

  async stop(): Promise<void> {
    for (const c of this.consumers) await c.close();
    await this.nc?.drain();
  }

  isHealthy(): boolean {
    return !!this.nc && !this.nc.isClosed();
  }

  async publish(subject: string, event: EventEnvelope, msgId: string): Promise<void> {
    if (!this.js) throw new Error('Event bus not started');
    await this.js.publish(subject, this.codec.encode(event), { msgID: msgId });
  }

  async subscribe(sub: Subscription): Promise<void> {
    if (!this.js || !this.jsm) throw new Error('Event bus not started');
    const config = {
      durable_name: sub.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: sub.subjects,
      max_deliver: 20,
      ack_wait: nanos(30_000),
    };
    try {
      await this.jsm.consumers.info(sub.stream, sub.durable);
      await this.jsm.consumers.update(sub.stream, sub.durable, config);
    } catch {
      await this.jsm.consumers.add(sub.stream, config);
    }
    const consumer = await this.js.consumers.get(sub.stream, sub.durable);
    const messages = await consumer.consume({ max_messages: 50 });
    this.consumers.push(messages);
    void (async () => {
      for await (const m of messages) {
        let event: EventEnvelope | undefined;
        try {
          event = this.codec.decode(m.data);
          await sub.handler(event);
          m.ack();
        } catch (err) {
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(m.info.redeliveryCount, 6));
          this.log.error(
            {
              err,
              durable: sub.durable,
              subject: m.subject,
              eventId: event?.eventId,
              redelivery: m.info.redeliveryCount,
            },
            'event handler failed; will retry',
          );
          m.nak(delay);
        }
      }
    })();
  }
}
