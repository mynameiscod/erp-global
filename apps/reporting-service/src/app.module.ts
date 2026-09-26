import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, MONGO_CONNECTION, ServiceCoreModule } from '@erp/service-kit';
import { ReportCatalog } from './catalog';
import {
  AdjustableClock,
  CLIENTS,
  CLOCK,
  createClients,
  loadReportingEnv,
  REPORTING_ENV,
  type Clients,
  type ReportingEnv,
} from './clients';
import { DashboardsService } from './dashboards.service';
import { Exporter } from './exporter';
import { ExportsService } from './exports.service';
import { exportModel, scheduleModel } from './models';
import { DashboardsController, ReportsController } from './reporting.controller';
import { SchedulesService } from './schedules.service';
import { Worker } from './worker';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'reporting-service' })],
  controllers: [ReportsController, DashboardsController],
  providers: [
    ReportCatalog,
    Exporter,
    ExportsService,
    SchedulesService,
    DashboardsService,
    Worker,
    { provide: REPORTING_ENV, useFactory: loadReportingEnv },
    {
      provide: CLIENTS,
      useFactory: (env: ReportingEnv) => createClients(env),
      inject: [REPORTING_ENV],
    },
    { provide: CLOCK, useFactory: () => new AdjustableClock() },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly worker: Worker,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The work queues are shared by all companies; create their indexes up front.
    await exportModel(this.conn).init();
    await scheduleModel(this.conn).init();
    // Company reports and dashboards change with the published config.
    await this.bus.subscribe({
      durable: 'reporting-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => this.clients.config.invalidate(event.tenantId),
    });
    this.worker.start();
  }
}
