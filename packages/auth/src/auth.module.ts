import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AUTH_OPTIONS, AuthGuard, type AuthOptions } from './auth.guard';

@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthOptions): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [AUTH_OPTIONS],
    };
  }
}
