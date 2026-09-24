import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { verifyAccessToken } from '@erp/auth';
import { ErrorCodes, type ErrorBody } from '@erp/contracts';
import { PUBLIC_ROUTES, routes, SENSITIVE_ROUTES, type GatewayEnv } from './config';

const CORRELATION = 'x-correlation-id';
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Headers a client must never be able to set: they carry trust between our services. */
const STRIPPED_HEADERS = ['x-service-token', 'x-tenant-id', 'x-user-id', 'x-actor'];

function error(res: Response, status: number, code: string, message: string): void {
  const body: ErrorBody = {
    error: { code, message },
    correlationId: String(res.getHeader(CORRELATION) ?? ''),
  };
  res.status(status).json(body);
}

/** Full path without the query. `req.path` is relative to the mount point inside `app.use('/api')`. */
function fullPath(req: Request): string {
  return req.originalUrl.split('?')[0];
}

function isPublic(req: Request): boolean {
  const path = fullPath(req);
  return PUBLIC_ROUTES.some(
    (r) => (r.method === '*' || r.method === req.method) && r.pattern.test(path),
  );
}

export interface GatewayDeps {
  rateLimitStore?: () => Store;
}

export function createGateway(env: GatewayEnv, deps: GatewayDeps = {}): express.Express {
  const log = pino({ name: 'api-gateway', level: env.LOG_LEVEL });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use((req, res, next) => {
    const incoming = req.header(CORRELATION);
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.headers[CORRELATION] = id;
    res.setHeader(CORRELATION, id);
    for (const h of STRIPPED_HEADERS) delete req.headers[h];
    next();
  });
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req: IncomingMessage) => String(req.headers[CORRELATION]),
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders: [CORRELATION],
    }),
  );

  const limiter = (limit: number, prefix: string) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: deps.rateLimitStore?.(),
      keyGenerator: (req) => `${prefix}:${req.ip}`,
      handler: (_req, res) =>
        error(res, 429, ErrorCodes.RateLimited, 'Too many requests. Please slow down.'),
    });
  const sensitive = limiter(env.AUTH_RATE_LIMIT_PER_MINUTE, 'auth');
  const general = limiter(env.RATE_LIMIT_PER_MINUTE, 'all');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api-gateway' });
  });

  app.get('/ready', async (_req, res) => {
    const results = await Promise.all(
      routes(env).map(async (r) => {
        try {
          const up = await fetch(`${r.target}/health`, { signal: AbortSignal.timeout(2000) });
          return [r.service, up.ok] as const;
        } catch {
          return [r.service, false] as const;
        }
      }),
    );
    const services = Object.fromEntries(results);
    const ready = results.every(([, ok]) => ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', services });
  });

  app.use('/api', general);
  app.use((req, res, next) =>
    SENSITIVE_ROUTES.some((r) => r.test(fullPath(req))) ? sensitive(req, res, next) : next(),
  );

  // Authenticate at the edge so unauthenticated traffic never reaches the services.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS' || isPublic(req)) return next();
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return error(res, 401, ErrorCodes.Unauthenticated, 'Login required');
    }
    try {
      verifyAccessToken(token, env.JWT_PUBLIC_KEY);
    } catch {
      return error(res, 401, ErrorCodes.Unauthenticated, 'Session expired or invalid');
    }
    next();
  });

  for (const route of routes(env)) {
    app.use(
      createProxyMiddleware<Request, Response>({
        target: route.target,
        changeOrigin: true,
        xfwd: true,
        proxyTimeout: 30_000,
        pathFilter: route.prefixes,
        on: {
          error: (err, _req, res) => {
            log.error({ err, service: route.service }, 'upstream error');
            const r = res as Response;
            if (!r.headersSent)
              error(r, 502, ErrorCodes.Upstream, `${route.service} is unavailable`);
          },
        },
      }),
    );
  }

  // Anything else, including /internal/*, does not exist from the outside.
  app.use((_req, res) => error(res, 404, ErrorCodes.NotFound, 'Not found'));
  return app;
}
