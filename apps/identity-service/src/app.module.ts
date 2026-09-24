import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ServiceCoreModule } from '@erp/service-kit';
import { AuthService } from './auth.service';
import { CLIENTS, createClients, IDENTITY_ENV, loadIdentityEnv, type IdentityEnv } from './config';
import {
  AuthController,
  InternalUsersController,
  MeController,
  UsersController,
} from './identity.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'identity-service' })],
  controllers: [AuthController, MeController, UsersController, InternalUsersController],
  providers: [
    AuthService,
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
  constructor(private readonly users: UsersService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.users.seedPlatformAdmin();
  }
}
