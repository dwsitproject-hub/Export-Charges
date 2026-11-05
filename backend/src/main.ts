import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig, loadDotEnv } from './config';
import { DirectoryObjectStore } from './registry/file-handling';
import { OBJECT_STORE } from './registry/source-documents.service';

async function bootstrap() {
  loadDotEnv(resolve(__dirname, '../../.env'));
  const config = loadConfig();
  const app = await createApp(config);
  // Refuse to start without a usable storage folder (on staging and production: ECR's folder on the Synology NAS).
  await app.get<DirectoryObjectStore>(OBJECT_STORE).assertWritable();
  new Logger('ECR').log(`Storage: ${config.storageDir} (${config.storageKind})`);
  await app.listen(config.port);
  new Logger('ECR').log(`API listening on port ${config.port}`);
}

void bootstrap();
