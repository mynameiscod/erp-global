import 'reflect-metadata';
import { runService } from '@erp/service-kit';
import { AppModule } from './app.module';

process.env.PORT ??= '3012';
process.env.MONGO_DB ??= 'erp_document';

void runService(AppModule);
