import 'reflect-metadata';
import { runService } from '@erp/service-kit';
import { AppModule } from './app.module';

process.env.PORT ??= '3002';
process.env.MONGO_DB ??= 'erp_tenant';
process.env.TENANT_SERVICE_URL ??= 'self';

void runService(AppModule);
