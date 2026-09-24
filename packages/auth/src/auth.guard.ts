import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { hasPermission, type PermissionKey } from '@erp/contracts';
import { requireContext } from '@erp/tenancy';
import { IS_INTERNAL, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { verifyAccessToken, verifyServiceToken } from './tokens';

export interface AuthOptions {
  /** RS256 public key (PEM) for user access tokens. */
  accessTokenPublicKey: string;
  /** Shared secret for service tokens. */
  internalSecret: string;
}

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Global guard. Every route is authenticated unless marked `@Public()`.
 * It fills the request context with tenant, actor and permissions; the tenant
 * always comes from a verified token, never from the request body or headers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = requireContext();

    if (this.reflector.getAllAndOverride<boolean>(IS_INTERNAL, targets)) {
      const token = req.header(SERVICE_TOKEN_HEADER);
      if (!token) throw new UnauthorizedException('Service token required');
      let claims;
      try {
        claims = verifyServiceToken(token, this.options.internalSecret);
      } catch {
        throw new UnauthorizedException('Invalid service token');
      }
      ctx.tenantId = claims.tid;
      ctx.actor = claims.act
        ? { type: 'user', id: claims.act }
        : { type: 'service', id: claims.sub };
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token)
      throw new UnauthorizedException('Login required');
    let claims;
    try {
      claims = verifyAccessToken(token, this.options.accessTokenPublicKey);
    } catch {
      throw new UnauthorizedException('Session expired or invalid');
    }
    ctx.tenantId = claims.tid;
    ctx.actor = { type: 'user', id: claims.sub };
    ctx.sessionId = claims.sid;
    ctx.acl = claims.acl;
    ctx.plat = claims.plat;

    const required =
      this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !hasPermission(claims, p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
