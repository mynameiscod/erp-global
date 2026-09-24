import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EVENTS_STREAM, EVENTS_SUBJECT_PREFIX } from '@erp/contracts';
import { handleOnce, type EventBus } from '@erp/events';
import { EVENT_BUS, MONGO_CONNECTION, ServiceCoreModule } from '@erp/service-kit';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

const CONSUMER = 'audit-service-recorder';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'audit-service' })],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly audit: AuditService,
  ) {}

  /** Every business and security event from every service lands in its tenant's chain. */
  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      durable: CONSUMER,
      stream: EVENTS_STREAM,
      subjects: [`${EVENTS_SUBJECT_PREFIX}>`],
      handler: async (event) => {
        await handleOnce(this.conn, CONSUMER, event, (session) =>
          this.audit.append(event, session),
        );
      },
    });
  }
}
