import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, ServiceCoreModule } from '@erp/service-kit';
import { runAsTenant } from '@erp/tenancy';
import { CLIENTS, createClients, loadPackEnv } from './clients';
import { PacksController } from './packs.controller';
import { PacksService } from './packs.service';

const SYSTEM = { type: 'system' as const, id: 'pack-service' };

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'pack-service' })],
  controllers: [PacksController],
  providers: [PacksService, { provide: CLIENTS, useFactory: () => createClients(loadPackEnv()) }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly packs: PacksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Pack roles are created once the pack is live.
    await this.bus.subscribe({
      durable: 'pack-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: (event) => runAsTenant(event.tenantId, SYSTEM, () => this.packs.syncRoles()),
    });
  }
}
