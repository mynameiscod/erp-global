import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { Internal } from '@erp/auth';
import type { AclEntry } from '@erp/contracts';
import { reportRunParamsSchema, reportSchema } from '@erp/metadata';
import { ZodPipe } from '@erp/service-kit';
import { DocumentDataService } from './document-data';
import { RecordsService } from './records.service';
import { ReportEngine } from './report-engine';

const aclSchema = z
  .array(
    z.object({
      ou: z.string().max(40),
      path: z.string().max(2000),
      p: z.array(z.string().max(120)).max(500),
    }),
  )
  .max(200);

const runSchema = z.object({
  report: reportSchema,
  params: reportRunParamsSchema.default({}),
  acl: aclSchema,
  lang: z.string().max(20).default('en'),
  purpose: z.enum(['view', 'export']).default('view'),
});

const documentSchema = z.object({
  entity: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  ids: z
    .array(z.string().regex(/^[a-f0-9]{24}$/))
    .min(1)
    .max(200),
  acl: aclSchema,
  related: z
    .array(
      z.object({
        entity: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
        field: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      }),
    )
    .max(10)
    .optional(),
});

const samplesSchema = z.object({ prefix: z.string().regex(/^pack:[a-z0-9_.]+:$/) });

/**
 * For reporting-service and document-service. Callers pass the access of the person
 * the report or document is for (from their token, or looked up for a scheduled
 * recipient); every query here is limited to it.
 */
@Controller('internal/outputs')
@Internal()
export class InternalOutputsController {
  constructor(
    private readonly reports: ReportEngine,
    private readonly documents: DocumentDataService,
    private readonly records: RecordsService,
  ) {}

  /** Removes sample records a pack created (pack-service). */
  @Post('samples/remove')
  @HttpCode(200)
  removeSamples(@Body(new ZodPipe(samplesSchema)) body: z.infer<typeof samplesSchema>) {
    return this.records.internalRemoveBySource(body.prefix);
  }

  @Post('reports/run')
  @HttpCode(200)
  run(@Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>) {
    return this.reports.run({ ...body, acl: body.acl as AclEntry[] });
  }

  @Post('documents/data')
  @HttpCode(200)
  data(@Body(new ZodPipe(documentSchema)) body: z.infer<typeof documentSchema>) {
    return this.documents.load({ ...body, acl: body.acl as AclEntry[] });
  }
}
