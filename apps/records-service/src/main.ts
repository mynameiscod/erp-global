import 'reflect-metadata';
import { runService } from '@erp/service-kit';
import { AppModule } from './app.module';

process.env.PORT ??= '3009';
process.env.MONGO_DB ??= 'erp_records';

void runService(AppModule);
