import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Internal } from '@erp/auth';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { paginationSchema } from '@erp/contracts';
import { AppError, ZodPipe } from '@erp/service-kit';
import { RecordsService } from './records.service';

const ENTITY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const entityOf = (key: string) => {
  if (!ENTITY_RE.test(key)) throw AppError.notFound('Entity');
  return key;
};

const listQuery = paginationSchema.extend({
  sort: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}:(asc|desc)$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
  filter: z
    .string()
    .max(2000)
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      try {
        const parsed = JSON.parse(v) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error();
        // Only plain values: operators such as $where must never reach the database.
        for (const value of Object.values(parsed)) {
          if (value !== null && typeof value === 'object') throw new Error();
        }
        return parsed as Record<string, string | number | boolean | null>;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'filter must be a JSON object of field values' });
        return z.NEVER;
      }
    }),
  orgUnitId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  status: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .optional(),
});

const writeSchema = z.object({
  orgUnitId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullish(),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Data of custom entities. Permissions are per entity (`records.<entity>.<action>`)
 * and are checked in the service, together with the org-unit scope.
 */
@ApiTags('records')
@ApiBearerAuth()
@Controller('api/v1/records/:entity')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  @ApiQuery({ name: 'sort', required: false, description: 'field:asc or field:desc' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'filter', required: false, description: 'JSON object of field values' })
  @ApiQuery({ name: 'orgUnitId', required: false })
  list(
    @Param('entity') entity: string,
    @Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>,
  ) {
    return this.records.list(entityOf(entity), query);
  }

  @Get('lookup')
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'ids', required: false, description: 'Comma-separated record ids' })
  lookup(@Param('entity') entity: string, @Query('q') q?: string, @Query('ids') ids?: string) {
    const list = ids
      ?.split(',')
      .filter((id) => /^[a-f0-9]{24}$/.test(id))
      .slice(0, 100);
    return this.records.lookup(entityOf(entity), q?.slice(0, 100), list?.length ? list : undefined);
  }

  @Get(':id')
  get(@Param('entity') entity: string, @Param('id') id: string) {
    return this.records.get(entityOf(entity), id);
  }

  @Post()
  create(
    @Param('entity') entity: string,
    @Body(new ZodPipe(writeSchema)) body: z.infer<typeof writeSchema>,
  ) {
    return this.records.create(entityOf(entity), body);
  }

  @Patch(':id')
  update(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body(new ZodPipe(writeSchema.partial({ data: true })))
    body: Partial<z.infer<typeof writeSchema>>,
  ) {
    return this.records.update(entityOf(entity), id, {
      orgUnitId: body.orgUnitId,
      data: body.data ?? {},
    });
  }

  @Delete(':id')
  remove(@Param('entity') entity: string, @Param('id') id: string) {
    return this.records.remove(entityOf(entity), id);
  }
}

const depth = z.number().int().min(0).max(10).default(1);
const systemWriteSchema = writeSchema.extend({
  depth,
  sourceKey: z.string().max(200).optional(),
});
const systemUpdateSchema = z.object({ data: z.record(z.string(), z.unknown()), depth });
const statusSchema = z.object({
  from: z.string().max(40).nullable(),
  to: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  action: z.string().max(40).nullable(),
  depth: z.number().int().min(0).max(10).default(0),
});
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
  includeDeleted: z.enum(['0', '1']).optional(),
});

/** For workflow-service: automations and workflow state changes. */
@Controller('internal/records/:entity')
@Internal()
export class InternalRecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  list(
    @Param('entity') entity: string,
    @Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>,
  ) {
    return this.records.internalList(entityOf(entity), q.page, q.pageSize);
  }

  @Get(':id')
  get(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>,
  ) {
    return this.records.internalGet(entityOf(entity), id, q.includeDeleted === '1');
  }

  @Post()
  create(
    @Param('entity') entity: string,
    @Body(new ZodPipe(systemWriteSchema)) body: z.infer<typeof systemWriteSchema>,
  ) {
    return this.records.create(
      entityOf(entity),
      { orgUnitId: body.orgUnitId, data: body.data },
      { depth: body.depth, sourceKey: body.sourceKey },
    );
  }

  @Patch(':id')
  update(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body(new ZodPipe(systemUpdateSchema)) body: z.infer<typeof systemUpdateSchema>,
  ) {
    return this.records.update(entityOf(entity), id, { data: body.data }, { depth: body.depth });
  }

  @Post(':id/status')
  @HttpCode(200)
  status(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.records.setStatus(entityOf(entity), id, body);
  }
}
