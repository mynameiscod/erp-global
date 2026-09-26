import { Body, Controller, HttpCode, Param, Post, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Internal, RequirePermissions } from '@erp/auth';
import { AppError, ZodPipe } from '@erp/service-kit';
import { requireContext } from '@erp/tenancy';
import { DocumentsService } from './documents.service';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const ID = /^[a-f0-9]{24}$/;
const entityOf = (e: string) => {
  if (!KEY.test(e)) throw AppError.notFound('Entity');
  return e;
};
const idOf = (id: string) => {
  if (!ID.test(id)) throw AppError.notFound('Record');
  return id;
};
const templateKey = z.string().regex(KEY).optional();
const lang = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
  .optional();

const batchSchema = z.object({
  ids: z.array(z.string().regex(ID)).min(1).max(200),
  template: templateKey,
  lang,
});
const emailSchema = z.object({
  template: templateKey,
  lang,
  to: z.array(z.string().email().max(254)).min(1).max(20),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
});
const previewSchema = z.object({
  template: z.unknown(),
  recordId: z.string().regex(ID).optional(),
  lang,
});

function sendPdf(res: Response, pdf: { bytes: Buffer; fileName: string }, download: boolean) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(pdf.bytes.length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
  );
  res.end(pdf.bytes);
}

function viewer() {
  const ctx = requireContext();
  return { acl: ctx.acl ?? [], lang: ctx.lang ?? 'en' };
}

/** Printing needs permission to read the record; nothing more. */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('api/v1/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions('config.manage')
  async preview(
    @Body(new ZodPipe(previewSchema)) body: z.infer<typeof previewSchema>,
    @Res() res: Response,
  ) {
    const v = viewer();
    sendPdf(
      res,
      await this.documents.preview({ ...body, lang: body.lang ?? v.lang, acl: v.acl }),
      false,
    );
  }

  @Get(':entity/:id/pdf')
  @ApiQuery({ name: 'template', required: false })
  @ApiQuery({ name: 'lang', required: false })
  @ApiQuery({ name: 'download', required: false })
  async one(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Query('template') template: string | undefined,
    @Query('lang') qLang: string | undefined,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const v = viewer();
    const pdf = await this.documents.pdf({
      entity: entityOf(entity),
      ids: [idOf(id)],
      template: templateKey.parse(template || undefined),
      lang: lang.parse(qLang || undefined) ?? v.lang,
      acl: v.acl,
    });
    sendPdf(res, pdf, download === '1');
  }

  @Post(':entity/pdf')
  @HttpCode(200)
  async many(
    @Param('entity') entity: string,
    @Body(new ZodPipe(batchSchema)) body: z.infer<typeof batchSchema>,
    @Res() res: Response,
  ) {
    const v = viewer();
    const pdf = await this.documents.pdf({
      entity: entityOf(entity),
      ids: [...new Set(body.ids)],
      template: body.template,
      lang: body.lang ?? v.lang,
      acl: v.acl,
    });
    sendPdf(res, pdf, true);
  }

  @Post(':entity/:id/email')
  @HttpCode(200)
  email(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body(new ZodPipe(emailSchema)) body: z.infer<typeof emailSchema>,
  ) {
    const v = viewer();
    return this.documents.email({
      entity: entityOf(entity),
      ids: [idOf(id)],
      template: body.template,
      lang: body.lang ?? v.lang,
      acl: v.acl,
      to: body.to,
      subject: body.subject,
      message: body.message,
    });
  }
}

const generateSchema = z.object({
  entity: z.string().regex(KEY),
  recordId: z.string().regex(ID),
  template: templateKey,
  lang,
  attachField: z.string().regex(KEY).optional(),
  emailTo: z.array(z.string().email()).max(20).optional(),
  emailFields: z.array(z.string().regex(KEY)).max(10).optional(),
  subject: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
  depth: z.number().int().min(0).max(10).default(0),
});

const tableSchema = z.object({
  title: z.string().max(200),
  subtitle: z.string().max(500).optional(),
  columns: z
    .array(
      z.object({
        label: z.string().max(200),
        align: z.enum(['left', 'right', 'center']).optional(),
      }),
    )
    .min(1)
    .max(60),
  rows: z.array(z.array(z.string().max(2000)).max(60)).max(5000),
  landscape: z.boolean().optional(),
  lang: z.string().max(20).default('en'),
  fileName: z.string().max(150),
});

/** For workflow-service (automations) and reporting-service (PDF exports). */
@Controller('internal/documents')
@Internal()
export class InternalDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('generate')
  @HttpCode(200)
  generate(@Body(new ZodPipe(generateSchema)) body: z.infer<typeof generateSchema>) {
    return this.documents.generate(body);
  }

  @Post('table-pdf')
  @HttpCode(200)
  table(@Body(new ZodPipe(tableSchema)) body: z.infer<typeof tableSchema>) {
    return this.documents.tablePdf(body);
  }
}
