import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { PinoNestLogger } from '@cip/observability';
import { AppModule, type ApiModuleOptions } from './app.module.js';
import { requestContext } from './common/request-context.js';
import { TAURI_ORIGINS } from './config.js';

export const API_PREFIX = 'api/v1';

/** Builds the configured Nest application without listening; shared by main.ts and the tests. */
export async function createApiApp(opts: ApiModuleOptions): Promise<NestExpressApplication> {
  const { config, logger } = opts;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(opts), {
    logger: new PinoNestLogger(logger),
    bodyParser: false,
  });
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '100kb' });
  app.use(requestContext(logger));
  app.enableCors({
    origin: [...config.CORS_ORIGINS, ...TAURI_ORIGINS],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-client', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  return app;
}
