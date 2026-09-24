import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EventTypes, EVENTS_STREAM, subjectFor, type OrgUnitMovedPayload } from '@erp/contracts';
import { handleOnce, type EventBus } from '@erp/events';
import { EVENT_BUS, MONGO_CONNECTION, ServiceCoreModule } from '@erp/service-kit';
import { AccessController, InternalAccessController } from './access.controller';
import { AccessService } from './access.service';
import { CLIENTS, createClients } from './clients';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'access-service' })],
  controllers: [AccessController, InternalAccessController],
  providers: [AccessService, { provide: CLIENTS, useFactory: createClients }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly access: AccessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      durable: 'access-service-org-moves',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.OrgUnitMoved)],
      handler: (event) =>
        handleOnce(this.conn, 'access-service-org-moves', event, async (session) => {
          const { oldPath, newPath } = event.payload as OrgUnitMovedPayload;
          await this.access.applyOrgMove(oldPath, newPath, session);
        }).then(() => undefined),
    });
  }
}
