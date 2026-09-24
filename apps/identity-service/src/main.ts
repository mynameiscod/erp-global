import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { runService } from '@erp/service-kit';
import { AppModule } from './app.module';

process.env.PORT ??= '3001';
process.env.MONGO_DB ??= 'erp_identity';

void runService(AppModule, {
  configure: (app) => {
    app.use(cookieParser());
    // Behind Nginx and the gateway: trust that many proxy hops for the client IP.
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  },
});
