import {
  BeforeApplicationShutdown,
  Controller,
  DynamicModule,
  Get,
  Global,
  Inject,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationBootstrap,
  ServiceUnavailableException,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import mongoose, { type Connection } from 'mongoose';
import { AUTH_OPTIONS, AuthGuard, Public, type AuthOptions } from '@erp/auth';
import {
  InMemoryEventBus,
  NatsEventBus,
  OutboxRelay,
  OutboxWriter,
  ensureConsumerIndexes,
  outboxModel,
  type EventBus,
} from '@erp/events';
import { getContext, TenantDatabases, type PlacementResolver } from '@erp/tenancy';
import { ContextMiddleware } from './context.middleware';
import { baseEnvSchema, loadEnv, type BaseEnv } from './env';
import { HttpErrorFilter } from './errors';
import { HttpPlacementResolver } from './placement';
import { ServiceClient } from './service-client';
import {
  BODY_LIMIT,
  EVENT_BUS,
  MONGO_CONNECTION,
  PLACEMENT_RESOLVER,
  SERVICE_ENV,
  SERVICE_NAME,
  TENANT_DATABASES,
} from './tokens';

declare global {
  var __erpMemoryBus: InMemoryEventBus | undefined;
}

/** One in-process bus shared by every service in the process (tests, single-process dev). */
export function sharedMemoryBus(): InMemoryEventBus {
  globalThis.__erpMemoryBus ??= new InMemoryEventBus({ autoDrain: true });
  return globalThis.__erpMemoryBus;
}

export interface CoreModuleOptions {
  /** Service name, e.g. `org-service`. Used in logs, events and service tokens. */
  name: string;
  /** tenant-service resolves placement from its own data instead of over HTTP. */
  placementResolver?: Type<PlacementResolver>;
  /** Largest request body, e.g. `20mb` for services that receive files. Default `1mb`. */
  bodyLimit?: string;
}

@Controller()
@ApiExcludeController()
class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly name: string,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: this.name };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.conn.db!.admin().ping();
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    if (!this.bus.isHealthy()) throw new ServiceUnavailableException('Event bus unavailable');
    return { status: 'ready', service: this.name };
  }
}

/** Starts the outbox relay after boot and closes the bus and database on shutdown. */
@Injectable()
class Lifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private relay?: OutboxRelay;

  constructor(
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly log: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await outboxModel(this.conn).init();
    await ensureConsumerIndexes(this.conn);
    this.relay = new OutboxRelay(this.conn, this.bus, {
      info: (o, m) => this.log.info(o, m),
      warn: (o, m) => this.log.warn(o, m),
      error: (o, m) => this.log.error(o, m),
    });
    this.relay.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
    if (!(this.bus instanceof InMemoryEventBus)) await this.bus.stop();
    await this.conn.close();
  }
}

@Global()
@Module({})
export class ServiceCoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('{*path}');
  }

  static forRoot(options: CoreModuleOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: SERVICE_NAME, useValue: options.name },
      { provide: BODY_LIMIT, useValue: options.bodyLimit ?? '1mb' },
      { provide: SERVICE_ENV, useFactory: () => loadEnv(baseEnvSchema) },
      {
        provide: AUTH_OPTIONS,
        useFactory: (env: BaseEnv): AuthOptions => ({
          accessTokenPublicKey: env.JWT_PUBLIC_KEY,
          internalSecret: env.INTERNAL_SECRET,
        }),
        inject: [SERVICE_ENV],
      },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: HttpErrorFilter },
      {
        provide: MONGO_CONNECTION,
        useFactory: async (env: BaseEnv) => {
          mongoose.set('strictQuery', true);
          return mongoose.createConnection(env.MONGO_URI, { dbName: env.MONGO_DB }).asPromise();
        },
        inject: [SERVICE_ENV],
      },
      options.placementResolver
        ? { provide: PLACEMENT_RESOLVER, useClass: options.placementResolver }
        : {
            provide: PLACEMENT_RESOLVER,
            useFactory: (env: BaseEnv) =>
              new HttpPlacementResolver(
                new ServiceClient(
                  'tenant-service',
                  env.TENANT_SERVICE_URL,
                  options.name,
                  env.INTERNAL_SECRET,
                ),
              ),
            inject: [SERVICE_ENV],
          },
      {
        provide: TENANT_DATABASES,
        useFactory: (conn: Connection, env: BaseEnv, resolver: PlacementResolver) =>
          new TenantDatabases(conn, env.MONGO_DB, resolver),
        inject: [MONGO_CONNECTION, SERVICE_ENV, PLACEMENT_RESOLVER],
      },
      {
        provide: EVENT_BUS,
        useFactory: async (env: BaseEnv, log: PinoLogger) => {
          if (env.NATS_URL === 'memory') return sharedMemoryBus();
          const bus = new NatsEventBus(env.NATS_URL, options.name, {
            info: (o, m) => log.info(o, m),
            warn: (o, m) => log.warn(o, m),
            error: (o, m) => log.error(o, m),
          });
          await bus.start();
          return bus;
        },
        inject: [SERVICE_ENV, PinoLogger],
      },
      {
        provide: OutboxWriter,
        useFactory: (conn: Connection) => new OutboxWriter(conn, options.name),
        inject: [MONGO_CONNECTION],
      },
      Lifecycle,
    ];

    return {
      module: ServiceCoreModule,
      imports: [
        LoggerModule.forRootAsync({
          useFactory: () => ({
            pinoHttp: {
              name: options.name,
              level: process.env.LOG_LEVEL ?? 'info',
              genReqId: (_req, res) => String(res.getHeader('x-correlation-id') ?? ''),
              mixin: () => {
                const c = getContext();
                return c
                  ? { correlationId: c.correlationId, tenantId: c.tenantId, actorId: c.actor?.id }
                  : {};
              },
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'req.headers["x-service-token"]',
                  'res.headers["set-cookie"]',
                ],
                remove: true,
              },
              autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
            },
          }),
        }),
      ],
      controllers: [HealthController],
      providers,
      exports: [
        SERVICE_NAME,
        BODY_LIMIT,
        SERVICE_ENV,
        AUTH_OPTIONS,
        MONGO_CONNECTION,
        PLACEMENT_RESOLVER,
        TENANT_DATABASES,
        EVENT_BUS,
        OutboxWriter,
      ],
    };
  }
}
