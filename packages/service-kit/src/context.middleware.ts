import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '@erp/tenancy';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Opens the request context. The tenant is left empty here: only the auth
 * guard sets it, and only from a verified token.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(CORRELATION_HEADER, correlationId);
    // First language of Accept-Language, e.g. "hi-IN,hi;q=0.9" gives "hi".
    const lang = /^([a-z]{2,3})/i
      .exec(String(req.headers['accept-language'] ?? ''))?.[1]
      ?.toLowerCase();
    runWithContext({ correlationId, lang }, () => next());
  }
}
