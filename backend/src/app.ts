import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/api-error';
import { networkGuard, requestBasics } from './common/http';
import type { AppConfig } from './config';

export async function createApp(config: AppConfig, logger: LogLevel[] | false = ['error', 'warn', 'log']) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { logger });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestBasics);
  app.use(networkGuard(() => config.allowedNetworks));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
