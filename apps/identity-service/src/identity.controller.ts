import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { Internal, Public, RequirePermissions } from '@erp/auth';
import {
  acceptInviteSchema,
  changePasswordSchema,
  emailSchema,
  inviteUserSchema,
  languageSchema,
  loginSchema,
  mfaCodeSchema,
  mfaLoginSchema,
  paginationSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  passwordSchema,
  timezoneSchema,
  updateProfileSchema,
  type InviteUserInput,
  type LoginInput,
} from '@erp/contracts';
import { ApiZodBody, ZodPipe } from '@erp/service-kit';
import { AuthService, type ClientMeta, type SessionResult } from './auth.service';
import { IDENTITY_ENV, type IdentityEnv } from './config';
import { UsersService } from './users.service';

export const REFRESH_COOKIE = 'erp_rt';
const COOKIE_PATH = '/api/v1/identity/auth';

function meta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

@ApiTags('auth')
@Controller('api/v1/identity/auth')
@Public()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
  ) {}

  private cookie(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    };
  }

  /** The refresh token only ever travels in an httpOnly cookie; the body gets the access token. */
  private respond(res: Response, result: SessionResult) {
    res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookie());
    const { refreshToken: _rt, ...body } = result;
    return body;
  }

  @Post('login')
  @HttpCode(200)
  @ApiZodBody(loginSchema)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, meta(req));
    return 'mfaRequired' in result ? result : this.respond(res, result);
  }

  @Post('login/mfa')
  @HttpCode(200)
  @ApiZodBody(mfaLoginSchema)
  async loginMfa(
    @Body(new ZodPipe(mfaLoginSchema)) body: z.infer<typeof mfaLoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.loginWithMfa(body.mfaToken, body.code, meta(req)));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta(req)));
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @Get('invite')
  invite(@Query('token') token: string) {
    return this.users.inviteDetails(token ?? '');
  }

  @Post('invite/accept')
  @HttpCode(200)
  @ApiZodBody(acceptInviteSchema)
  accept(@Body(new ZodPipe(acceptInviteSchema)) body: z.infer<typeof acceptInviteSchema>) {
    return this.users.acceptInvite(body.token, body.password);
  }

  @Post('password/forgot')
  @HttpCode(202)
  @ApiZodBody(passwordResetRequestSchema)
  async forgot(
    @Body(new ZodPipe(passwordResetRequestSchema)) body: z.infer<typeof passwordResetRequestSchema>,
  ) {
    await this.auth.forgotPassword(body.tenantSlug, body.email);
    return { ok: true };
  }

  @Post('password/reset')
  @HttpCode(200)
  @ApiZodBody(passwordResetConfirmSchema)
  async reset(
    @Body(new ZodPipe(passwordResetConfirmSchema)) body: z.infer<typeof passwordResetConfirmSchema>,
  ) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('api/v1/identity/me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Get()
  me() {
    return this.users.me();
  }

  @Patch()
  @ApiZodBody(updateProfileSchema)
  update(@Body(new ZodPipe(updateProfileSchema)) body: z.infer<typeof updateProfileSchema>) {
    return this.users.updateMe(body);
  }

  @Post('password')
  @HttpCode(200)
  @ApiZodBody(changePasswordSchema)
  async changePassword(
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    await this.auth.changePassword(body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup() {
    return this.auth.mfaSetup();
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @ApiZodBody(mfaCodeSchema)
  mfaEnable(@Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>) {
    return this.auth.mfaEnable(body.code);
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @ApiZodBody(mfaCodeSchema)
  mfaDisable(@Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>) {
    return this.auth.mfaDisable(body.code);
  }
}

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['invited', 'active', 'deactivated']).optional(),
});

@ApiTags('users')
@ApiBearerAuth()
@Controller('api/v1/identity/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('identity.user.read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermissions('identity.user.read')
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post('invite')
  @RequirePermissions('identity.user.invite')
  @ApiZodBody(inviteUserSchema)
  invite(@Body(new ZodPipe(inviteUserSchema)) body: InviteUserInput) {
    return this.users.invite(body);
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  @RequirePermissions('identity.user.invite')
  resend(@Param('id') id: string) {
    return this.users.resendInvite(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('identity.user.manage')
  deactivate(@Param('id') id: string) {
    return this.users.setStatus(id, 'deactivated');
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('identity.user.manage')
  reactivate(@Param('id') id: string) {
    return this.users.setStatus(id, 'active');
  }
}

const bootstrapAdminSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  language: languageSchema,
  timezone: timezoneSchema,
});

@Controller('internal/users')
@Internal()
export class InternalUsersController {
  constructor(private readonly users: UsersService) {}

  @Post('bootstrap-admin')
  bootstrapAdmin(
    @Body(new ZodPipe(bootstrapAdminSchema)) body: z.infer<typeof bootstrapAdminSchema>,
  ) {
    return this.users.bootstrapAdmin(body);
  }

  @Delete('tenant-data')
  deleteTenantData() {
    return this.users.deleteTenantData();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.internalGet(id);
  }
}
