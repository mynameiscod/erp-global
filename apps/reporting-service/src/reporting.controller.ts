import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import { z } from 'zod';
import { RequirePermissions } from '@erp/auth';
import { EventTypes, hasPermission } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { reportRunParamsSchema } from '@erp/metadata';
import { AppError, MONGO_CONNECTION, ZodPipe } from '@erp/service-kit';
import { ReportCatalog, type ReportEntry } from './catalog';
import { DashboardsService, type DashboardEntry } from './dashboards.service';
import { ExportsService } from './exports.service';
import { scheduleInputSchema, SchedulesService, type ScheduleInput } from './schedules.service';
import { Worker } from './worker';

const REF = /^([a-z][a-z0-9_]{1,39}|my:[a-f0-9]{24})$/;
const refOf = (ref: string) => {
  if (!REF.test(ref)) throw AppError.notFound('Report');
  return ref;
};
const objectId = z.string().regex(/^[a-f0-9]{24}$/);

const runSchema = z.object({ params: reportRunParamsSchema.default({}) });
const exportSchema = z.object({
  format: z.enum(['xlsx', 'csv', 'pdf']),
  params: reportRunParamsSchema.default({}),
});
const previewSchema = z.object({ report: z.unknown(), params: reportRunParamsSchema.default({}) });
const shareSchema = z.object({ roleIds: z.array(objectId).max(50) });
const dataSchema = z.object({
  dateRange: z.object({ from: z.string().date(), to: z.string().date() }).optional(),
  orgUnitId: objectId.optional(),
  refresh: z.boolean().optional(),
});

function reportDto(e: ReportEntry) {
  return {
    ref: e.ref,
    kind: e.kind,
    label: e.label,
    entity: e.entity,
    def: e.def,
    sharedRoleIds: e.sharedRoleIds ?? [],
  };
}

function dashboardDto(e: DashboardEntry) {
  return {
    ref: e.ref,
    kind: e.kind,
    label: e.label,
    home: e.home,
    def: e.def,
    sharedRoleIds: e.sharedRoleIds ?? [],
  };
}

/**
 * Reports: company reports come from the configuration, personal ones are kept here.
 * Every run uses the viewer's own access; records-service applies it to each query.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('api/v1/reports')
export class ReportsController {
  constructor(
    private readonly catalog: ReportCatalog,
    private readonly exports: ExportsService,
    private readonly schedules: SchedulesService,
    private readonly worker: Worker,
    private readonly outbox: OutboxWriter,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
  ) {}

  @Get()
  async list() {
    return (await this.catalog.list(await this.catalog.viewer())).map(reportDto);
  }

  /** Runs a definition that is not saved yet (the report builder). */
  @Post('preview')
  @HttpCode(200)
  async preview(@Body(new ZodPipe(previewSchema)) body: z.infer<typeof previewSchema>) {
    const v = await this.catalog.viewer();
    const claims = { acl: v.acl };
    if (!hasPermission(claims, 'reports.personal') && !hasPermission(claims, 'config.manage'))
      throw AppError.forbidden('Missing permission: reports.personal');
    const def = await this.catalog.checkDefinition(v, body.report);
    return this.catalog.run(v, def, body.params);
  }

  // ---- exports ----

  @Get('exports')
  async exportList() {
    return this.exports.list(await this.catalog.viewer());
  }

  @Get('exports/:id')
  async exportGet(@Param('id') id: string) {
    return this.exports.get(await this.catalog.viewer(), id);
  }

  // ---- schedules ----

  @Get('schedules')
  async scheduleList() {
    return this.schedules.list(await this.catalog.viewer());
  }

  @Post('schedules')
  async scheduleCreate(@Body(new ZodPipe(scheduleInputSchema)) body: ScheduleInput) {
    return this.schedules.create(await this.catalog.viewer(), body);
  }

  @Put('schedules/:id')
  async scheduleUpdate(
    @Param('id') id: string,
    @Body(new ZodPipe(scheduleInputSchema)) body: ScheduleInput,
  ) {
    return this.schedules.update(await this.catalog.viewer(), id, body);
  }

  @Delete('schedules/:id')
  async scheduleDelete(@Param('id') id: string) {
    return this.schedules.remove(await this.catalog.viewer(), id);
  }

  // ---- personal reports ----

  @Post('my')
  @RequirePermissions('reports.personal')
  async create(@Body() body: unknown) {
    return reportDto(await this.catalog.create(await this.catalog.viewer(), body));
  }

  @Put('my/:id')
  @RequirePermissions('reports.personal')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return reportDto(await this.catalog.update(await this.catalog.viewer(), id, body));
  }

  @Delete('my/:id')
  async remove(@Param('id') id: string) {
    return this.catalog.remove(await this.catalog.viewer(), id);
  }

  @Put('my/:id/share')
  async share(
    @Param('id') id: string,
    @Body(new ZodPipe(shareSchema)) body: z.infer<typeof shareSchema>,
  ) {
    const entry = await this.catalog.share(await this.catalog.viewer(), id, body.roleIds);
    await this.conn.transaction((session) =>
      this.outbox.record(
        EventTypes.ReportShared,
        { ref: entry.ref, kind: 'report', roleIds: body.roleIds },
        { session },
      ),
    );
    return reportDto(entry);
  }

  // ---- one report ----

  @Get(':ref')
  async get(@Param('ref') ref: string) {
    return reportDto(await this.catalog.get(await this.catalog.viewer(), refOf(ref)));
  }

  @Post(':ref/run')
  @HttpCode(200)
  async run(
    @Param('ref') ref: string,
    @Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>,
  ) {
    const v = await this.catalog.viewer();
    const entry = await this.catalog.get(v, refOf(ref));
    return this.catalog.run(v, entry.def, body.params);
  }

  /** Exports run in the background; the requester is notified when the file is ready. */
  @Post(':ref/export')
  async export(
    @Param('ref') ref: string,
    @Body(new ZodPipe(exportSchema)) body: z.infer<typeof exportSchema>,
  ) {
    const job = await this.exports.request(
      await this.catalog.viewer(),
      refOf(ref),
      body.format,
      body.params,
    );
    this.worker.kick();
    return job;
  }
}

@ApiTags('dashboards')
@ApiBearerAuth()
@Controller('api/v1/dashboards')
export class DashboardsController {
  constructor(
    private readonly catalog: ReportCatalog,
    private readonly dashboards: DashboardsService,
    private readonly outbox: OutboxWriter,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
  ) {}

  @Get()
  async list() {
    return (await this.dashboards.list(await this.catalog.viewer())).map(dashboardDto);
  }

  @Post('my')
  async create(@Body() body: unknown) {
    return dashboardDto(await this.dashboards.create(await this.catalog.viewer(), body));
  }

  @Put('my/:id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return dashboardDto(await this.dashboards.update(await this.catalog.viewer(), id, body));
  }

  @Delete('my/:id')
  async remove(@Param('id') id: string) {
    return this.dashboards.remove(await this.catalog.viewer(), id);
  }

  @Put('my/:id/share')
  async share(
    @Param('id') id: string,
    @Body(new ZodPipe(shareSchema)) body: z.infer<typeof shareSchema>,
  ) {
    const entry = await this.dashboards.share(await this.catalog.viewer(), id, body.roleIds);
    await this.conn.transaction((session) =>
      this.outbox.record(
        EventTypes.ReportShared,
        { ref: entry.ref, kind: 'dashboard', roleIds: body.roleIds },
        { session },
      ),
    );
    return dashboardDto(entry);
  }

  @Get(':ref')
  async get(@Param('ref') ref: string) {
    return dashboardDto(await this.dashboards.get(await this.catalog.viewer(), refOf(ref)));
  }

  @Post(':ref/data')
  @HttpCode(200)
  async data(
    @Param('ref') ref: string,
    @Body(new ZodPipe(dataSchema)) body: z.infer<typeof dataSchema>,
  ) {
    const { refresh, ...filters } = body;
    return this.dashboards.data(await this.catalog.viewer(), refOf(ref), filters, refresh);
  }
}
