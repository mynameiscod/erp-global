import 'reflect-metadata';
import { runService } from '@erp/service-kit';
import { AppModule } from './app.module';

process.env.PORT ??= '3003';
process.env.MONGO_DB ??= 'erp_org';

void runService(AppModule);
