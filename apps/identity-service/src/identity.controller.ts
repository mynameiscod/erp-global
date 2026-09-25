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
  Put,
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
  adminUpdateUserSchema,
  changePasswordSchema,
  delegationSchema,
  emailSchema,
  inviteUserSchema,
  languageSchema,
  loginSchema,
  mfaCodeSchema,
  mfaLoginSchema,
  mfaMethodSchema,
  mfaResendSchema,
  otpLoginRequestSchema,
  otpVerifySchema,
  phoneRequestSchema,
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
import { AccountService } from './account.service';
import {
  AuthService,
  type ClientMeta,
  type MfaChallengeResult,
  type SessionResult,
} from './auth.service';
import { IDENTITY_ENV, type IdentityEnv } from './config';
import { SsoError, SsoService } from './sso.service';
import { UsersService } from './users.service';

export const REFRESH_COOKIE = 'erp_rt';
const COOKIE_PATH = '/api/v1/identity/auth';

function meta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function refreshCookie(env: IdentityEnv): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
}

const providerSchema = z.enum(['google', 'microsoft']);

@ApiTags('auth')
@Controller('api/v1/identity/auth')
@Public()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
  ) {}

  /** The refresh token only ever travels in an httpOnly cookie; the body gets the access token. */
  private respond(res: Response, result: SessionResult | MfaChallengeResult) {
    if ('mfaRequired' in result) return result;
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookie(this.env));
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
    return this.respond(res, await this.auth.login(body, meta(req)));
  }

  /** Sends a sign-in code to a mobile number (WhatsApp, or email as the fallback). */
  @Post('otp/request')
  @HttpCode(200)
  @ApiZodBody(otpLoginRequestSchema)
  otpRequest(
    @Body(new ZodPipe(otpLoginRequestSchema)) body: z.infer<typeof otpLoginRequestSchema>,
  ) {
    return this.auth.requestLoginOtp(body);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiZodBody(otpVerifySchema)
  async otpVerify(
    @Body(new ZodPipe(otpVerifySchema)) body: z.infer<typeof otpVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.verifyLoginOtp(body.otpToken, body.code, meta(req)));
  }

  @Post('login/mfa/resend')
  @HttpCode(200)
  @ApiZodBody(mfaResendSchema)
  mfaResend(@Body(new ZodPipe(mfaResendSchema)) body: z.infer<typeof mfaResendSchema>) {
    return this.auth.resendMfaCode(body.mfaToken, body.channel);
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

/**
 * Browser redirects to and from Google/Microsoft. Results go back to the web app's
 * /sso/complete page in the URL fragment, which never reaches server logs.
 */
@ApiTags('auth')
@Controller('api/v1/identity/sso')
@Public()
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
  ) {}

  private complete(res: Response, params: Record<string, string>) {
    const url = `${this.env.APP_URL.replace(/\/$/, '')}/sso/complete#${new URLSearchParams(params)}`;
    res.redirect(302, url);
  }

  private fail(res: Response, e: unknown, provider: string) {
    if (!(e instanceof SsoError)) throw e;
    this.complete(res, { error: e.code, provider });
  }

  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Query('company') company: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const p = providerSchema.safeParse(provider);
      if (!p.success) throw new SsoError('unknown_provider');
      res.redirect(302, await this.sso.start(p.data, (company ?? '').trim().toLowerCase()));
    } catch (e) {
      this.fail(res, e, provider);
    }
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const p = providerSchema.safeParse(provider);
      if (!p.success) throw new SsoError('unknown_provider');
      const out = await this.sso.callback(
        p.data,
        {
          code: typeof query.code === 'string' ? query.code : undefined,
          state: typeof query.state === 'string' ? query.state : undefined,
          error: typeof query.error === 'string' ? query.error : undefined,
        },
        meta(req),
      );
      if (out.kind === 'linked') return this.complete(res, { linked: out.provider });
      if (out.kind === 'mfa') {
        const m = out.mfa;
        return this.complete(res, {
          mfaToken: m.mfaToken,
          mfaMethod: m.mfaMethod,
          ...(m.channel && { channel: m.channel }),
          ...(m.sentTo && { sentTo: m.sentTo }),
        });
      }
      res.cookie(REFRESH_COOKIE, out.session.refreshToken, refreshCookie(this.env));
      this.complete(res, { ok: '1' });
    } catch (e) {
      this.fail(res, e, provider);
    }
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('api/v1/identity/me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly account: AccountService,
    private readonly sso: SsoService,
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

  @Get('delegation')
  delegation() {
    return this.users.myDelegation();
  }

  @Put('delegation')
  @ApiZodBody(delegationSchema)
  setDelegation(@Body(new ZodPipe(delegationSchema)) body: z.infer<typeof delegationSchema>) {
    return this.users.setDelegation(body);
  }

  @Delete('delegation')
  clearDelegation() {
    return this.users.clearDelegation();
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

  /** Two-step verification by WhatsApp or email: sends a code, and `mfa/otp/enable` confirms it. */
  @Post('mfa/otp/setup')
  @HttpCode(200)
  @ApiZodBody(mfaMethodSchema)
  otpMfaSetup(@Body(new ZodPipe(mfaMethodSchema)) body: z.infer<typeof mfaMethodSchema>) {
    return this.account.otpMfaSetup(body.method);
  }

  @Post('mfa/otp/enable')
  @HttpCode(200)
  @ApiZodBody(mfaCodeSchema)
  otpMfaEnable(@Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>) {
    return this.account.otpMfaEnable(body.code);
  }

  /** Sends a code for turning off WhatsApp/email two-step verification. */
  @Post('mfa/code')
  @HttpCode(200)
  mfaCode() {
    return this.account.mfaManageCode();
  }

  @Post('phone')
  @HttpCode(200)
  @ApiZodBody(phoneRequestSchema)
  requestPhone(@Body(new ZodPipe(phoneRequestSchema)) body: z.infer<typeof phoneRequestSchema>) {
    return this.account.requestPhone(body.phone);
  }

  @Post('phone/verify')
  @HttpCode(200)
  @ApiZodBody(mfaCodeSchema)
  verifyPhone(@Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>) {
    return this.account.verifyPhone(body.code);
  }

  @Delete('phone')
  removePhone() {
    return this.account.removePhone();
  }

  @Get('linked-accounts')
  linkedAccounts() {
    return this.sso.list();
  }

  @Delete('linked-accounts/:id')
  unlink(@Param('id') id: string) {
    return this.sso.unlink(id);
  }

  /** Returns the Google/Microsoft URL to open; the account is linked when the browser returns. */
  @Post('sso/:provider/link')
  @HttpCode(200)
  link(@Param('provider', new ZodPipe(providerSchema)) provider: z.infer<typeof providerSchema>) {
    return this.sso.startLink(provider);
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

  @Patch(':id')
  @RequirePermissions('identity.user.manage')
  @ApiZodBody(adminUpdateUserSchema)
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(adminUpdateUserSchema)) body: z.infer<typeof adminUpdateUserSchema>,
  ) {
    return this.users.update(id, body);
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

const batchSchema = z.object({ ids: z.array(z.string().max(40)).max(500) });

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

  @Post('batch')
  @HttpCode(200)
  batch(@Body(new ZodPipe(batchSchema)) body: z.infer<typeof batchSchema>) {
    return this.users.internalBatch(body.ids);
  }

  @Get(':id/delegators')
  delegators(@Param('id') id: string) {
    return this.users.internalDelegators(id);
  }

  @Get(':id/delegate')
  delegate(@Param('id') id: string) {
    return this.users.internalDelegate(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.internalGet(id);
  }
}
