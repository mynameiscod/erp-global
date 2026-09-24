import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Internal, RequirePermissions } from '@erp/auth';
import { AppError, ZodPipe } from '@erp/service-kit';
import { ConfigService, KINDS, type Kind } from './config.service';

const scopeOf = (scope?: string) => {
  if (!scope || scope === 'company') return 'company';
  if (!/^[a-f0-9]{24}$/.test(scope))
    throw AppError.badRequest('scope must be "company" or an org unit id');
  return scope;
};

const kindOf = (kind: string): Kind => {
  if (!(kind in KINDS)) throw AppError.notFound('Configuration type');
  return kind as Kind;
};

const noteSchema = z.object({ note: z.string().trim().max(500).optional() });

@ApiTags('config')
@ApiBearerAuth()
@Controller('api/v1/config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  /** What the current user's screens are built from. Any signed-in user may read it. */
  @Get('effective')
  @ApiQuery({ name: 'orgUnitId', required: false })
  @ApiQuery({ name: 'source', required: false, enum: ['published', 'draft'] })
  effective(@Query('orgUnitId') orgUnitId?: string, @Query('source') source?: string) {
    return this.config.effectiveForUnit(
      orgUnitId || undefined,
      source === 'draft' ? 'draft' : 'published',
    );
  }

  @Get('draft')
  @RequirePermissions('config.read')
  draft() {
    return this.config.getDraft();
  }

  @Get('draft/validate')
  @RequirePermissions('config.read')
  validate() {
    return this.config.validateDraft();
  }

  @Put('draft/settings')
  @RequirePermissions('config.manage')
  settings(@Body() body: unknown) {
    return this.config.putSettings(body);
  }

  @Post('draft/discard')
  @HttpCode(200)
  @RequirePermissions('config.manage')
  discard() {
    return this.config.discardDraft();
  }

  @Delete('draft/overrides/:orgUnitId')
  @RequirePermissions('config.manage')
  removeOverride(@Param('orgUnitId') orgUnitId: string) {
    return this.config.removeOverride(scopeOf(orgUnitId));
  }

  @Put('draft/:kind/:key')
  @RequirePermissions('config.manage')
  @ApiQuery({
    name: 'scope',
    required: false,
    description: '"company" (default) or an org unit id',
  })
  put(
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.config.putItem(kindOf(kind), key, body, scopeOf(scope));
  }

  @Delete('draft/:kind/:key')
  @RequirePermissions('config.manage')
  @ApiQuery({ name: 'scope', required: false })
  remove(@Param('kind') kind: string, @Param('key') key: string, @Query('scope') scope?: string) {
    return this.config.deleteItem(kindOf(kind), key, scopeOf(scope));
  }

  @Post('publish')
  @RequirePermissions('config.publish')
  publish(@Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>) {
    return this.config.publish(body.note);
  }

  @Get('versions')
  @RequirePermissions('config.read')
  versions() {
    return this.config.listVersions();
  }

  @Get('versions/:version')
  @RequirePermissions('config.read')
  version(@Param('version', ParseIntPipe) version: number) {
    return this.config.getVersion(version);
  }

  @Post('versions/:version/rollback')
  @RequirePermissions('config.publish')
  rollback(
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodPipe(noteSchema)) body: z.infer<typeof noteSchema>,
  ) {
    return this.config.rollback(version, body.note);
  }
}

const nextNumberSchema = z.object({
  series: z.string().min(1).max(40),
  orgUnitId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  orgPath: z
    .string()
    .regex(/^(\/[a-f0-9]{24})+\/$/)
    .optional(),
  orgCode: z.string().max(40).nullish(),
  date: z.string().datetime().optional(),
});

@Controller('internal/config')
@Internal()
export class InternalConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get('effective')
  effective(@Query('orgPath') orgPath?: string) {
    return this.config.effective(orgPath || undefined);
  }

  @Get('version')
  async version() {
    return { version: await this.config.currentVersion() };
  }

  @Get('entities')
  entities() {
    return this.config.publishedEntities();
  }

  @Post('numbering/next')
  @HttpCode(200)
  next(@Body(new ZodPipe(nextNumberSchema)) body: z.infer<typeof nextNumberSchema>) {
    return this.config.nextNumber({ ...body, orgCode: body.orgCode ?? undefined });
  }
}
