import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '@erp/auth';
import { paginationSchema } from '@erp/contracts';
import { ZodPipe } from '@erp/service-kit';
import { AuditService } from './audit.service';

const listQuery = paginationSchema.extend({
  type: z.string().max(100).optional(),
  actorId: z.string().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('api/v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('events')
  @RequirePermissions('audit.event.read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.audit.list(query);
  }

  @Get('verify')
  @RequirePermissions('audit.chain.verify')
  verify() {
    return this.audit.verify();
  }
}
