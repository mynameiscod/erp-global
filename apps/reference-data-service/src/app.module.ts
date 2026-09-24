import { Module } from '@nestjs/common';
import { ServiceCoreModule } from '@erp/service-kit';
import { ReferenceController } from './reference.controller';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'reference-data-service' })],
  controllers: [ReferenceController],
})
export class AppModule {}
