/**
 * Corrects the "as printed" item numbers and annex pages of the palm products in a registry that was loaded from an
 * earlier copy of seed/official-palm-2026-11.json (scripts/official-corrections.ts). ECR drafts one change set and
 * submits it; a Checker approves it in ECR (Rate updates). Nothing is published by this command.
 *
 * Runs compiled, in the API container:
 *   node dist/scripts/correct-official-products.js --as <email of the person running it> [--dry-run] [--seed <file>]
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadConfig, loadDotEnv } from '../config';
import { DbService } from '../db/db.service';
import { ChangeSetsService } from '../registry/change-sets.service';
import { draftProductCorrections, findProductCorrections, type ProductCorrection } from './official-corrections';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const show = (c: ProductCorrection) => {
  const parts = [];
  if (c.itemNo.from !== c.itemNo.to) parts.push(`no. ${c.itemNo.from ?? '–'} → ${c.itemNo.to ?? '–'}`);
  if (c.annexPage.from !== c.annexPage.to) parts.push(`page ${c.annexPage.from ?? '–'} → ${c.annexPage.to ?? '–'}`);
  return `  Group ${c.group.padEnd(3)} ${c.nameId.slice(0, 60).padEnd(60)} ${parts.join(', ')}`;
};

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  // Only this command runs: no scheduler, publisher, mail or export loops.
  Object.assign(process.env, { SCHEDULER_TICK_MS: '0', PUBLISH_DUE_INTERVAL_MS: '0', EMAIL_OUTBOX_INTERVAL_MS: '0', EXPORT_JOB_INTERVAL_MS: '0', SETTINGS_REFRESH_MS: '0' });
  const { values } = parseArgs({ options: { as: { type: 'string' }, seed: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  if (!values.as) throw new Error('--as <email of an ECR account> is required');
  const seed: Json = JSON.parse(readFileSync(resolve(values.seed ?? 'seed/official-palm-2026-11.json'), 'utf8'));

  const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadConfig()), { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const { rows: [operator] } = await db.query<{ status: string; full_name: string }>('SELECT status, full_name FROM ecr.app_user WHERE email = $1', [values.as]);
    if (!operator) throw new Error(`No ECR account for ${values.as}.`);
    if (operator.status !== 'ACTIVE') throw new Error(`${values.as} is ${operator.status}, not ACTIVE.`);

    if (values['dry-run']) {
      const { corrections, unmatched } = await findProductCorrections(db.pool, seed);
      for (const c of corrections) console.log(show(c));
      for (const u of unmatched) console.log(`  not found, left alone: ${u}`);
      console.log(`${corrections.length} product(s) would be corrected. Nothing was changed (--dry-run).`);
      return;
    }

    const r = await draftProductCorrections(app.get(ChangeSetsService), db.pool, seed, `${operator.full_name} (${values.as})`);
    for (const c of r.corrections) console.log(show(c));
    for (const u of r.unmatched) console.log(`  not found, left alone: ${u}`);
    if (!r.setId) {
      console.log('Every product already has the item number and annex page of the seed; nothing to correct.');
    } else if (r.notSubmitted) {
      console.log(`Drafted change set ${r.setId} with ${r.corrections.length} correction(s), but it could not be submitted: ${r.notSubmitted}`);
      process.exitCode = 1;
    } else {
      console.log(`Change set ${r.setId} with ${r.corrections.length} correction(s) is waiting for a Checker: ${loadConfig().publicBaseUrl}/change-sets/${r.setId}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: Error) => {
  console.error(`Correction failed: ${err.message}`);
  process.exit(1);
});
