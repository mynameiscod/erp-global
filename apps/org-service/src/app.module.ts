import { Module } from '@nestjs/common';
import { ServiceCoreModule } from '@erp/service-kit';
import { InternalOrgController, OrgController } from './org.controller';
import { OrgService } from './org.service';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'org-service' })],
  controllers: [OrgController, InternalOrgController],
  providers: [OrgService],
})
export class AppModule {}
