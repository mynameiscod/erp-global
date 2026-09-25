import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Internal, RequirePermissions } from '@erp/auth';
import {
  createAssignmentSchema,
  createRoleSchema,
  objectIdSchema,
  updateRoleSchema,
  type CreateAssignmentInput,
  type CreateRoleInput,
} from '@erp/contracts';
import { ApiZodBody, ZodPipe } from '@erp/service-kit';
import { AccessService } from './access.service';

@ApiTags('access')
@ApiBearerAuth()
@Controller('api/v1/access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('permissions')
  @RequirePermissions('access.role.read')
  permissions() {
    return this.access.permissionCatalog();
  }

  @Get('roles')
  @RequirePermissions('access.role.read')
  roles() {
    return this.access.listRoles();
  }

  @Post('roles')
  @RequirePermissions('access.role.manage')
  @ApiZodBody(createRoleSchema)
  createRole(@Body(new ZodPipe(createRoleSchema)) body: CreateRoleInput) {
    return this.access.createRole(body);
  }

  @Patch('roles/:id')
  @RequirePermissions('access.role.manage')
  @ApiZodBody(updateRoleSchema)
  updateRole(
    @Param('id') id: string,
    @Body(new ZodPipe(updateRoleSchema)) body: Partial<CreateRoleInput>,
  ) {
    return this.access.updateRole(id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions('access.role.manage')
  deleteRole(@Param('id') id: string) {
    return this.access.deleteRole(id);
  }

  @Get('assignments')
  @RequirePermissions('access.assignment.read')
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'orgUnitId', required: false })
  assignments(@Query('userId') userId?: string, @Query('orgUnitId') orgUnitId?: string) {
    return this.access.listAssignments({ userId, orgUnitId });
  }

  @Post('assignments')
  @RequirePermissions('access.assignment.manage')
  @ApiZodBody(createAssignmentSchema)
  assign(@Body(new ZodPipe(createAssignmentSchema)) body: CreateAssignmentInput) {
    return this.access.createAssignment(body);
  }

  @Delete('assignments/:id')
  @RequirePermissions('access.assignment.manage')
  unassign(@Param('id') id: string) {
    return this.access.removeAssignment(id);
  }
}

const bootstrapSchema = z.object({
  adminUserId: objectIdSchema,
  rootOrgUnitId: objectIdSchema,
  rootPath: z.string().regex(/^\/[a-f0-9]{24}\/$/),
});

@Controller('internal/access')
@Internal()
export class InternalAccessController {
  constructor(private readonly access: AccessService) {}

  @Post('bootstrap')
  bootstrap(@Body(new ZodPipe(bootstrapSchema)) body: z.infer<typeof bootstrapSchema>) {
    return this.access.bootstrap(body);
  }

  @Delete('bootstrap')
  undo() {
    return this.access.undoBootstrap();
  }

  @Get('users/:userId/acl')
  acl(@Param('userId') userId: string) {
    return this.access.aclFor(userId);
  }

  @Post('assignments')
  assign(@Body(new ZodPipe(createAssignmentSchema)) body: CreateAssignmentInput) {
    return this.access.systemAssign(body);
  }
}
