import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Internal, RequirePermissions } from '@erp/auth';
import {
  createOrgUnitSchema,
  moveOrgUnitSchema,
  updateOrgUnitSchema,
  type CreateOrgUnitInput,
} from '@erp/contracts';
import { ApiZodBody, ZodPipe } from '@erp/service-kit';
import { OrgService } from './org.service';

@ApiTags('org')
@ApiBearerAuth()
@Controller('api/v1/org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('units')
  @RequirePermissions('org.unit.read')
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  list(@Query('includeInactive') includeInactive?: string) {
    return this.org.list(includeInactive === 'true');
  }

  @Get('unit-types')
  @RequirePermissions('org.unit.read')
  types() {
    return this.org.types();
  }

  @Get('units/:id')
  @RequirePermissions('org.unit.read')
  get(@Param('id') id: string) {
    return this.org.get(id);
  }

  @Post('units')
  @RequirePermissions('org.unit.create')
  @ApiZodBody(createOrgUnitSchema)
  create(@Body(new ZodPipe(createOrgUnitSchema)) body: CreateOrgUnitInput) {
    return this.org.create(body);
  }

  @Patch('units/:id')
  @RequirePermissions('org.unit.update')
  @ApiZodBody(updateOrgUnitSchema)
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(updateOrgUnitSchema)) body: z.infer<typeof updateOrgUnitSchema>,
  ) {
    return this.org.update(id, body);
  }

  @Post('units/:id/move')
  @RequirePermissions('org.unit.move')
  @ApiZodBody(moveOrgUnitSchema)
  move(
    @Param('id') id: string,
    @Body(new ZodPipe(moveOrgUnitSchema)) body: z.infer<typeof moveOrgUnitSchema>,
  ) {
    return this.org.move(id, body.newParentId);
  }

  @Post('units/:id/deactivate')
  @RequirePermissions('org.unit.deactivate')
  deactivate(@Param('id') id: string) {
    return this.org.deactivate(id);
  }
}

const bootstrapSchema = z.object({ name: z.string().trim().min(1).max(120) });

@Controller('internal/org')
@Internal()
export class InternalOrgController {
  constructor(private readonly org: OrgService) {}

  @Post('bootstrap')
  bootstrap(@Body(new ZodPipe(bootstrapSchema)) body: z.infer<typeof bootstrapSchema>) {
    return this.org.bootstrap(body.name);
  }

  @Delete('bootstrap')
  undo() {
    return this.org.undoBootstrap();
  }

  @Get('units/:id')
  get(@Param('id') id: string) {
    return this.org.internalGet(id);
  }
}
