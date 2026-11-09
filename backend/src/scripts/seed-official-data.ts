/**
 * Loads the official palm data set (seed/official-palm-2026-11.json) into an EMPTY registry as one change set and
 * publishes it at once, without a Checker (ChangeSetsService.publishDirect). For the first load of a new environment.
 *
 * Runs compiled (Nest needs decorator metadata, which tsx does not emit), e.g. in the API container:
 *   node dist/scripts/seed-official-data.js --as jerry.hakim@energi-up.com --reason "Initial load of staging"
 *     [--files <folder with the PDFs>] [--seed seed/official-palm-2026-11.json]
 *
 * Each source PDF is read from --files when it is there, otherwise downloaded from its official address, and must
 * match the SHA-256 recorded in the seed file. Uploads, the change set and the publication are audited under the
 * operator (--as, an active ECR account) with the reason.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { Actor } from '../auth/actor';
import { loadConfig, loadDotEnv } from '../config';
import { DbService } from '../db/db.service';
import { ChangeSetsService } from '../registry/change-sets.service';
import { DirectoryObjectStore } from '../registry/file-handling';
import { OBJECT_STORE, SourceDocumentsService } from '../registry/source-documents.service';
import { loadOfficialSeed } from './official-seed';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function pdf(doc: Json, folder: string | undefined): Promise<Buffer> {
  const local = folder ? join(folder, doc.file) : null;
  let body: Buffer;
  if (local && existsSync(local)) {
    body = readFileSync(local);
  } else {
    const res = await fetch(doc.downloadUrl, { headers: { 'User-Agent': 'ECR-seed/1.0' }, signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`${doc.downloadUrl}: HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  }
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== doc.sha256) {
    throw new Error(`${doc.file}: SHA-256 ${sha} differs from the official copy the seed was checked against (${doc.sha256}).`);
  }
  return body;
}

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  // Only this command runs: no scheduler, publisher, mail or export loops.
  Object.assign(process.env, { SCHEDULER_TICK_MS: '0', PUBLISH_DUE_INTERVAL_MS: '0', EMAIL_OUTBOX_INTERVAL_MS: '0', EXPORT_JOB_INTERVAL_MS: '0', SETTINGS_REFRESH_MS: '0' });
  const { values } = parseArgs({ options: { as: { type: 'string' }, reason: { type: 'string' }, files: { type: 'string' }, seed: { type: 'string' } } });
  if (!values.as || !values.reason) throw new Error('--as <email of an ECR account> and --reason are required');
  const seed: Json = JSON.parse(readFileSync(resolve(values.seed ?? 'seed/official-palm-2026-11.json'), 'utf8'));
  const config = loadConfig();

  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const sets = app.get(ChangeSetsService);
    const documents = app.get(SourceDocumentsService);
    // The PDFs go to the storage folder (on staging: ECR's folder on the Synology NAS); stop now if it is not usable.
    await app.get<DirectoryObjectStore>(OBJECT_STORE).assertWritable();
    console.log(`Storage: ${config.storageDir} (${config.storageKind})`);

    const { rows: [operator] } = await db.query<{ id: string; status: string }>('SELECT id, status FROM ecr.app_user WHERE email = $1', [values.as]);
    if (!operator) throw new Error(`No ECR account for ${values.as}: sign in through DWS Hub once first.`);
    if (operator.status !== 'ACTIVE') throw new Error(`${values.as} is ${operator.status}, not ACTIVE.`);
    const { rows: [{ n }] } = await db.query<{ n: string }>('SELECT count(*) AS n FROM ecr.data_version');
    if (Number(n) > 0) throw new Error(`The registry already has ${n} published data version(s); this command only loads an empty registry.`);

    const actor: Actor = {
      id: operator.id,
      permissions: new Set(),
      sessionId: '00000000-0000-0000-0000-000000000000',
      ip: '127.0.0.1',
      userAgent: `ecr-seed-cli (${seed.version}, os user ${userInfo().username})`,
    };

    const { version, setId, records, findings: tally } = await loadOfficialSeed(sets, documents, actor, seed, values.reason, (d) => pdf(d, values.files), console.log);
    console.log(`Published data version ${version}: change set ${setId}, ${records} records (findings: ${JSON.stringify(tally)}).`);
  } finally {
    await app.close();
  }
}

main().catch((err: Error & { details?: { findings?: { severity: string; message: string }[] } }) => {
  console.error(`Seed failed: ${err.message}`);
  for (const f of (err.details?.findings ?? []).filter((x) => x.severity === 'ERROR').slice(0, 20)) console.error(`  ${f.message}`);
  process.exit(1);
});
