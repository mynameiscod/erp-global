import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, ServiceCoreModule } from '@erp/service-kit';
import { CLIENTS, createClients, type Clients } from './clients';
import { InternalOrgController, OrgController } from './org.controller';
import { OrgService } from './org.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'org-service' })],
  controllers: [OrgController, InternalOrgController],
  providers: [OrgService, { provide: CLIENTS, useFactory: createClients }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // New configuration takes effect at once instead of after the cache expires.
    await this.bus.subscribe({
      durable: 'org-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => this.clients.config.invalidate(event.tenantId),
    });
  }
}
