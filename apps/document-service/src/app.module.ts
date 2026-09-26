import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, ServiceCoreModule } from '@erp/service-kit';
import { CLIENTS, createClients, type Clients } from './clients';
import { DocumentsController, InternalDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PdfEngine } from './pdf-engine';

@Module({
  // Report tables sent for PDF export can be a few megabytes.
  imports: [ServiceCoreModule.forRoot({ name: 'document-service', bodyLimit: '20mb' })],
  controllers: [DocumentsController, InternalDocumentsController],
  providers: [DocumentsService, PdfEngine, { provide: CLIENTS, useFactory: createClients }],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Templates change with the published config.
    await this.bus.subscribe({
      durable: 'document-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => this.clients.config.invalidate(event.tenantId),
    });
  }
}
