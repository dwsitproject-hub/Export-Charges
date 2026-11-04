import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { loadDotEnv } from '../src/config';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
    srv.on('error', fail);
  });
}

/**
 * Uses TEST_DATABASE_URL (the Docker database) when it answers; otherwise starts a throw-away
 * embedded PostgreSQL 18 so the suite also runs on machines without Docker.
 */
export default async function setup(project: TestProject) {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const configured = process.env.TEST_DATABASE_URL;
  if (configured && (await reachable(configured))) {
    project.provide('testDatabaseUrl', configured);
    return;
  }

  // ESM-only package; the API's CommonJS type resolution cannot see its types, so declare what is used.
  const { default: EmbeddedPostgres } = (await import('embedded-postgres' as string)) as {
    default: new (options: Record<string, unknown>) => {
      initialise(): Promise<void>;
      start(): Promise<void>;
      stop(): Promise<void>;
      createDatabase(name: string): Promise<void>;
    };
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'ecr-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'ecr',
    password: 'ecr_test_only',
    port,
    persistent: false,
    // Windows defaults to the WIN1252 code page, which cannot hold "≤" and other characters the migrations use.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('ecr_test');
  console.log(`[tests] embedded PostgreSQL 18 on port ${port}`);
  project.provide('testDatabaseUrl', `postgres://ecr:ecr_test_only@127.0.0.1:${port}/ecr_test`);

  return async () => {
    await pg.stop();
    // Windows may hold the data files briefly after shutdown; retry, and never fail the run over cleanup.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((err) =>
      console.warn(`[tests] could not remove ${dataDir}: ${(err as Error).message}`),
    );
  };
}
