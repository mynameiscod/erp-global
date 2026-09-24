import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { BaseEnv } from './env';
import { SERVICE_ENV, SERVICE_NAME } from './tokens';

export interface AppSetup {
  /** Extra Express setup, e.g. cookie parsing in identity-service. */
  configure?: (app: NestExpressApplication) => void;
}

export async function createServiceApp(
  module: Type,
  setup: AppSetup = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();
  setup.configure?.(app);

  const env = app.get<BaseEnv>(SERVICE_ENV);
  if (env.ENABLE_DOCS) {
    const name = app.get<string>(SERVICE_NAME);
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle(`global-erp ${name}`).setVersion('1').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }
  return app;
}

/** Entry point for a service's `main.ts`. */
export async function runService(module: Type, setup: AppSetup = {}): Promise<void> {
  const app = await createServiceApp(module, setup);
  const env = app.get<BaseEnv>(SERVICE_ENV);
  await app.listen(env.PORT, '0.0.0.0');
}
