import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig, loadDotEnv } from './config';

async function bootstrap() {
  loadDotEnv(resolve(__dirname, '../../.env'));
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  new Logger('ECR').log(`API listening on port ${config.port}`);
}

void bootstrap();
