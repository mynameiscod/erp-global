import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
  lookup(@Param('entity') entity: string, @Query('q') q?: string) {
    return this.records.lookup(entityOf(entity), q?.slice(0, 100));
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
