import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventTypes, EVENTS_STREAM, subjectFor } from '@erp/contracts';
import type { EventBus } from '@erp/events';
import { EVENT_BUS, ServiceCoreModule } from '@erp/service-kit';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import {
  CLIENTS,
  createClients,
  IDENTITY_ENV,
  loadIdentityEnv,
  type Clients,
  type IdentityEnv,
} from './config';
import {
  AuthController,
  InternalUsersController,
  MeController,
  SsoController,
  UsersController,
} from './identity.controller';
import { OtpService } from './otp.service';
import { SsoService } from './sso.service';
import { UsersService } from './users.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'identity-service' })],
  controllers: [
    AuthController,
    SsoController,
    MeController,
    UsersController,
    InternalUsersController,
  ],
  providers: [
    AuthService,
    OtpService,
    AccountService,
    SsoService,
    UsersService,
    { provide: IDENTITY_ENV, useFactory: loadIdentityEnv },
    {
      provide: CLIENTS,
      useFactory: (env: IdentityEnv) => createClients(env),
      inject: [IDENTITY_ENV],
    },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    private readonly users: UsersService,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(CLIENTS) private readonly clients: Clients,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.users.seedPlatformAdmin();
    // New configuration takes effect at once instead of after the cache expires.
    await this.bus.subscribe({
      durable: 'identity-service-config',
      stream: EVENTS_STREAM,
      subjects: [subjectFor(EventTypes.ConfigPublished), subjectFor(EventTypes.ConfigRolledBack)],
      handler: async (event) => this.clients.config.invalidate(event.tenantId),
    });
  }
}
