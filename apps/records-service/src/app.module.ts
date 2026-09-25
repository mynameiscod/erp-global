import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EventTypes, EVENTS_STREAM, subjectFor, type OrgUnitMovedPayload } from '@erp/contracts';
import { handleOnce, type EventBus } from '@erp/events';
import { EVENT_BUS, MONGO_CONNECTION, ServiceCoreModule } from '@erp/service-kit';
import { CLIENTS, createClients, type Clients } from './clients';
import { InternalRecordsController, RecordsController } from './records.controller';
import { RecordsService } from './records.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'records-service' })],
  controllers: [RecordsController, InternalRecordsController],
  providers: [RecordsService, { provide: CLIENTS, useFactory: createClients }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly records: RecordsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      durable: 'records-service-org-moves',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.OrgUnitMoved)],
      handler: (event) =>
        handleOnce(this.conn, 'records-service-org-moves', event, async (session) => {
          const { oldPath, newPath } = event.payload as OrgUnitMovedPayload;
          await this.records.applyOrgMove(oldPath, newPath, session);
        }).then(() => undefined),
    });
    // New configuration takes effect at once instead of after the cache expires.
    await this.bus.subscribe({
      durable: 'records-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => this.clients.config.invalidate(event.tenantId),
    });
  }
}
