import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ErrorCodes, type ErrorBody } from '@erp/contracts';
import { getContext, TenantContextMissingError, TenantIsolationError } from '@erp/tenancy';

/** A deliberate, user-facing error with a stable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(what: string): AppError {
    return new AppError(404, ErrorCodes.NotFound, `${what} not found`);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, ErrorCodes.Conflict, message, details);
  }
  static forbidden(message = 'You do not have access to this'): AppError {
    return new AppError(403, ErrorCodes.Forbidden, message);
  }
  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, ErrorCodes.ValidationFailed, message, details);
  }
}

/** Error returned by another service; 4xx responses keep their status and code. */
export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly body: ErrorBody | undefined,
  ) {
    super(body?.error?.message ?? `${service} responded ${status}`);
    this.name = 'UpstreamError';
  }
}

const STATUS_CODES: Record<number, string> = {
  400: ErrorCodes.ValidationFailed,
  401: ErrorCodes.Unauthenticated,
  403: ErrorCodes.Forbidden,
  404: ErrorCodes.NotFound,
  409: ErrorCodes.Conflict,
  429: ErrorCodes.RateLimited,
};

/** One error shape for every service: `{ error: { code, message, details }, correlationId }`. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);
    body.correlationId = getContext()?.correlationId;
    if (status >= 500) this.log.error(exception);
    if (exception instanceof TenantIsolationError)
      this.log.error(exception, 'TENANT ISOLATION VIOLATION');
    res.status(status).json(body);
  }

  private map(e: unknown): { status: number; body: ErrorBody } {
    const body = (code: string, message: string, details?: unknown): ErrorBody => ({
      error: details === undefined ? { code, message } : { code, message, details },
    });
    if (e instanceof AppError)
      return { status: e.status, body: body(e.code, e.message, e.details) };
    if (e instanceof ZodError) {
      return {
        status: 400,
        body: body(
          ErrorCodes.ValidationFailed,
          'Validation failed',
          e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      };
    }
    if (e instanceof UpstreamError) {
      if (e.status >= 400 && e.status < 500 && e.body?.error)
        return { status: e.status, body: e.body };
      return { status: 502, body: body(ErrorCodes.Upstream, `${e.service} is unavailable`) };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const resp = e.getResponse();
      const message =
        typeof resp === 'string'
          ? resp
          : ((resp as { message?: string | string[] }).message ?? e.message);
      return {
        status,
        body: body(
          STATUS_CODES[status] ?? (status >= 500 ? ErrorCodes.Internal : 'ERROR'),
          [message].flat().join('; '),
        ),
      };
    }
    if (e instanceof TenantIsolationError)
      return { status: 403, body: body(ErrorCodes.Forbidden, 'Access denied') };
    if (e instanceof TenantContextMissingError) {
      return { status: 500, body: body(ErrorCodes.TenantMissing, 'Tenant context missing') };
    }
    if ((e as { code?: number })?.code === 11000) {
      return { status: 409, body: body(ErrorCodes.Conflict, 'Already exists') };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: body(ErrorCodes.Internal, 'Something went wrong'),
    };
  }
}
