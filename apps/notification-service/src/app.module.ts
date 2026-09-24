import { Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { Schema, type Connection } from 'mongoose';
import {
  NOTIFY_STREAM,
  NotifyTypes,
  type EmailRequestedPayload,
  type EventEnvelope,
} from '@erp/contracts';
import { alreadyProcessed, handleOnce, type EventBus } from '@erp/events';
import { EVENT_BUS, MONGO_CONNECTION, ServiceCoreModule, TENANT_DATABASES } from '@erp/service-kit';
import { tenantPlugin, type ModelDef, type TenantDatabases } from '@erp/tenancy';
import { createMailer, MAILER, type Mailer } from './mailer';
import { render } from './templates';

interface Delivery {
  tenantId: string;
  eventId: string;
  channel: 'email';
  to: string;
  template: string;
  status: 'sent';
  messageId: string;
  createdAt: Date;
}

const deliverySchema = new Schema<Delivery>(
  {
    eventId: { type: String, required: true },
    channel: { type: String, required: true },
    to: { type: String, required: true },
    template: { type: String, required: true },
    status: { type: String, required: true },
    messageId: String,
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'deliveries', versionKey: false },
);
deliverySchema.plugin(tenantPlugin);
deliverySchema.index({ tenantId: 1, createdAt: -1 });
// Keep the delivery log for 90 days. Link contents are never stored.
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

const DeliveryModel: ModelDef<Delivery> = { name: 'Delivery', schema: deliverySchema };
const CONSUMER = 'notification-service-email';

@Injectable()
export class EmailSender {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
  ) {}

  /**
   * At-least-once: a failed send throws and the bus redelivers with back-off.
   * The send happens outside the transaction so a transaction retry cannot send twice.
   */
  async handle(event: EventEnvelope): Promise<void> {
    if (await alreadyProcessed(this.conn, CONSUMER, event.eventId)) return;
    const p = event.payload as EmailRequestedPayload;
    const mail = render(p.template, p.locale, p.vars);
    const { messageId } = await this.mailer.send({ to: p.to, ...mail });
    await handleOnce(this.conn, CONSUMER, event, async (session) => {
      const Deliveries = await this.dbs.model(DeliveryModel);
      await Deliveries.create(
        [
          {
            eventId: event.eventId,
            channel: 'email',
            to: p.to,
            template: p.template,
            status: 'sent',
            messageId,
          },
        ],
        { session },
      );
    });
  }
}

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'notification-service' })],
  providers: [EmailSender, { provide: MAILER, useFactory: createMailer }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly sender: EmailSender,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Create indexes up front; creating a collection inside a transaction is slow and conflict-prone.
    await this.conn.model(DeliveryModel.name, DeliveryModel.schema).init();
    await this.bus.subscribe({
      durable: CONSUMER,
      stream: NOTIFY_STREAM,
      subjects: [NotifyTypes.EmailRequested],
      handler: (event) => this.sender.handle(event),
    });
  }
}
