import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, ServiceCoreModule } from '@erp/service-kit';
import { runAsTenant } from '@erp/tenancy';
import { AutomationService } from './automation.service';
import {
  AdjustableClock,
  CLIENTS,
  CLOCK,
  createClients,
  loadWorkflowEnv,
  WORKFLOW_ENV,
  type Clients,
  type WorkflowEnv,
} from './clients';
import { Directory } from './directory';
import { JobStore } from './jobs';
import { Scheduler } from './scheduler';
import { InternalWorkflowController, WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

const SYSTEM = { type: 'system' as const, id: 'workflow-service' };

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'workflow-service' })],
  controllers: [WorkflowController, InternalWorkflowController],
  providers: [
    WorkflowService,
    AutomationService,
    Directory,
    JobStore,
    Scheduler,
    { provide: WORKFLOW_ENV, useFactory: loadWorkflowEnv },
    {
      provide: CLIENTS,
      useFactory: (env: WorkflowEnv) => createClients(env),
      inject: [WORKFLOW_ENV],
    },
    { provide: CLOCK, useFactory: () => new AdjustableClock() },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly automations: AutomationService,
    private readonly scheduler: Scheduler,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Record changes trigger automations. Each run is recorded once per event, so a
    // redelivered event does nothing twice.
    await this.bus.subscribe({
      durable: 'workflow-service-records',
      stream: EVENTS_STREAM,
      subjects: [
        subjectFor(EventTypes.RecordCreated),
        subjectFor(EventTypes.RecordUpdated),
        subjectFor(EventTypes.RecordDeleted),
        subjectFor(EventTypes.RecordStatusChanged),
      ],
      handler: (event) =>
        runAsTenant(event.tenantId, SYSTEM, () => this.automations.onRecordEvent(event)),
    });
    // New configuration: fresh cache, and schedules follow the published automations.
    await this.bus.subscribe({
      durable: 'workflow-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => {
        this.clients.config.invalidate(event.tenantId);
        await runAsTenant(event.tenantId, SYSTEM, () => this.automations.syncSchedules());
      },
    });
    this.scheduler.start();
  }
}
