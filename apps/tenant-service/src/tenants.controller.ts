import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Internal, Public, RequirePermissions } from '@erp/auth';
import {
  paginationSchema,
  platformCreateTenantSchema,
  signupSchema,
  slugSchema,
  tenantSettingsSchema,
  tenantStatusSchema,
  type PlatformCreateTenantInput,
  type SignupInput,
  type TenantSettingsInput,
} from '@erp/contracts';
import { ApiZodBody, ZodPipe } from '@erp/service-kit';
import { LocalPlacementResolver } from './placement.resolver';
import { TenantsService } from './tenants.service';

@ApiTags('tenants')
@Controller('api/v1/tenants')
export class PublicTenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Public()
  @Post('signup')
  @ApiZodBody(signupSchema)
  signup(@Body(new ZodPipe(signupSchema)) body: SignupInput) {
    return this.tenants.signup(body);
  }

  @Public()
  @Get('slug-available/:slug')
  async slugAvailable(@Param('slug') slug: string) {
    const parsed = slugSchema.safeParse(slug);
    if (!parsed.success) return { slug, available: false, reason: parsed.error.issues[0]?.message };
    return { slug: parsed.data, available: await this.tenants.isSlugAvailable(parsed.data) };
  }

  @Public()
  @Get('lookup/:slug')
  lookup(@Param('slug') slug: string) {
    return this.tenants.publicLookup(slug.toLowerCase());
  }

  @ApiBearerAuth()
  @Get('current')
  current() {
    return this.tenants.current();
  }

  @ApiBearerAuth()
  @Patch('current/settings')
  @RequirePermissions('tenant.settings.update')
  @ApiZodBody(tenantSettingsSchema)
  updateSettings(@Body(new ZodPipe(tenantSettingsSchema)) body: TenantSettingsInput) {
    return this.tenants.updateSettings(body);
  }
}

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['provisioning', 'active', 'suspended', 'failed']).optional(),
});

@ApiTags('platform')
@ApiBearerAuth()
@Controller('api/v1/platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @RequirePermissions('platform.tenant.read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.tenants.list(query);
  }

  @Post()
  @RequirePermissions('platform.tenant.manage')
  @ApiZodBody(platformCreateTenantSchema)
  create(@Body(new ZodPipe(platformCreateTenantSchema)) body: PlatformCreateTenantInput) {
    const { placement, ...input } = body;
    return this.tenants.signup(input, placement);
  }

  @Get(':id')
  @RequirePermissions('platform.tenant.read')
  get(@Param('id') id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id/status')
  @RequirePermissions('platform.tenant.manage')
  @ApiZodBody(tenantStatusSchema)
  setStatus(
    @Param('id') id: string,
    @Body(new ZodPipe(tenantStatusSchema)) body: z.infer<typeof tenantStatusSchema>,
  ) {
    return this.tenants.setStatus(id, body.status);
  }
}

@Controller('internal/tenants')
@Internal()
export class InternalTenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly placement: LocalPlacementResolver,
  ) {}

  @Get('by-slug/:slug')
  bySlug(@Param('slug') slug: string) {
    return this.tenants.bySlug(slug.toLowerCase());
  }

  @Get(':id/placement')
  getPlacement(@Param('id') id: string) {
    return this.placement.resolve(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tenants.internalGet(id);
  }
}
