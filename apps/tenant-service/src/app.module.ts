import { Inject, Module, OnModuleInit } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { MONGO_CONNECTION, ServiceCoreModule } from '@erp/service-kit';
import { CLIENTS, createClients } from './clients';
import { DbProvisioner } from './db-provisioner';
import { LocalPlacementResolver } from './placement.resolver';
import { tenantModel } from './tenant.model';
import {
  InternalTenantsController,
  PlatformTenantsController,
  PublicTenantsController,
} from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [
    ServiceCoreModule.forRoot({
      name: 'tenant-service',
      placementResolver: LocalPlacementResolver,
    }),
  ],
  controllers: [PublicTenantsController, PlatformTenantsController, InternalTenantsController],
  providers: [
    TenantsService,
    LocalPlacementResolver,
    DbProvisioner,
    { provide: CLIENTS, useFactory: createClients },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(@Inject(MONGO_CONNECTION) private readonly conn: Connection) {}

  async onModuleInit(): Promise<void> {
    await tenantModel(this.conn).init();
  }
}
