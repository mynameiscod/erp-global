import { Module } from '@nestjs/common';
import { ServiceCoreModule } from '@erp/service-kit';
import { CLIENTS, createClients } from './clients';
import { ConfigController, InternalConfigController } from './config.controller';
import { ConfigService } from './config.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'config-service' })],
  controllers: [ConfigController, InternalConfigController],
  providers: [ConfigService, { provide: CLIENTS, useFactory: createClients }],
})
export class AppModule {}
