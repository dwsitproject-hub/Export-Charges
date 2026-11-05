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

    console.log(`Source documents (${seed.documents.length}) ...`);
    const docIds: Record<string, string> = {};
    for (const d of seed.documents) {
      const body = await pdf(d, values.files);
      const saved: Json = await documents.upload(actor, { buffer: body, originalname: d.file, size: body.length },
        { docKind: d.docKind, title: d.title, docNumber: d.docNumber, docDate: d.docDate, officialUrl: d.officialUrl });
      docIds[d.key] = saved.id;
      console.log(`  ${d.file}  ${d.sha256.slice(0, 12)}  ${saved.reused ? 'already stored' : 'stored'}`);
    }

    const set = await sets.create(actor, {
      title: seed.title.slice(0, 200),
      justification: `${values.reason}\n\nInitial load (${seed.version}) published directly without a Checker. Sources: `
        + seed.documents.map((d: Json) => `${d.title} (${d.officialUrl}, SHA-256 ${d.sha256})`).join('; '),
    });
    let known = new Set<string>(set.items.map((i: Json) => i.id));
    const add = async (entityType: string, after: Json): Promise<string> => {
      const updated = await sets.saveItem(actor, set.id, { entityType, operation: 'CREATE', after });
      const created = updated.items.find((i: Json) => !known.has(i.id));
      known = new Set(updated.items.map((i: Json) => i.id));
      return created!.entityId;
    };

    const commodityId = await add('COMMODITY', seed.commodity);
    const groupIds: Record<string, string> = {};
    for (const g of seed.groups) groupIds[g.code] = await add('PRODUCT_GROUP', { commodityId, ...g, validFrom: null, validTo: null });

    const regIds: Record<string, string> = {};
    for (const r of seed.regulations) {
      regIds[r.key] = await add('REGULATION', {
        regType: r.regType, number: r.number, year: r.year, titleId: r.titleId, titleEn: r.titleEn, issuer: r.issuer, status: 'IN_FORCE',
        promulgatedOn: r.promulgatedOn, effectiveOn: r.effectiveOn, endsOn: null, officialUrl: r.officialUrl, bpkStatusUrl: r.bpkStatusUrl,
        relations: r.relations.map(([relation, target]: [string, string]) => ({ relation, regulationId: regIds[target] })),
        documents: [{ sourceDocumentId: docIds[r.doc], role: 'MAIN' }],
      });
    }

    const seriesIds: Record<string, string> = {};
    for (const s of seed.series) {
      seriesIds[s.key] = await add('REF_SERIES', { code: s.code, name: s.name, kind: s.kind, unit: s.unit, cadence: s.cadence, productId: null });
    }
    const bt = seed.bandTable;
    const bandTableId = await add('BAND_TABLE', { code: bt.code, name: bt.name, refSeriesId: seriesIds[bt.series], bands: bt.bands, validFrom: null, validTo: null });

    console.log(`Products (${seed.products.length}) ...`);
    const productIds: Record<string, string> = {};
    for (const p of seed.products) {
      productIds[p.key] = await add('PRODUCT', { ...p.data, groupId: groupIds[p.group], classificationRegulationId: regIds[p.classification] });
    }

    const scheduleIds: Record<string, string> = {};
    for (const s of seed.schedules) {
      scheduleIds[s.key] = await add('SCHEDULE', {
        regulationId: regIds[s.regulation], chargeType: s.chargeType, annexLabel: s.annexLabel, commodityId, validFrom: s.validFrom, validTo: null,
      });
    }
    const linked = (field: 'bk' | 'pe', no: number) => seed.products.filter((p: Json) => p[field] === no).map((p: Json) => productIds[p.key]);
    console.log(`Duty and levy lines (${seed.bkLines.length} + ${seed.peLines.length}) ...`);
    for (const l of seed.bkLines) {
      await add('SCHEDULE_LINE', {
        scheduleId: scheduleIds.BK, kelompok: l.kelompok, itemNo: String(l.no), uraian: l.uraian, basisType: 'BAND_USD_PER_MT', pct: null, usdPerMt: null,
        bandTableId, refSeriesId: seriesIds.CPO, bandValues: l.amounts.map(String), productIds: linked('bk', l.no), validFrom: '2025-10-22', validTo: null,
      });
    }
    for (const l of seed.peLines) {
      await add('SCHEDULE_LINE', {
        scheduleId: scheduleIds.PE, kelompok: l.kelompok, itemNo: String(l.no), uraian: l.uraian, basisType: l.basis,
        pct: l.basis === 'PCT_OF_REF_PRICE' ? String(l.value) : null, usdPerMt: l.basis === 'FIXED_USD_PER_MT' ? String(l.value) : null,
        bandTableId: null, refSeriesId: l.basis === 'PCT_OF_REF_PRICE' ? seriesIds.CPO : null, bandValues: [], productIds: linked('pe', l.no),
        validFrom: '2026-03-01', validTo: null,
      });
    }
    for (const v of seed.values) {
      await add('REF_VALUE', {
        seriesId: seriesIds[v.series], periodFrom: v.periodFrom, periodTo: v.periodTo, value: v.value, sourceDocumentId: docIds[v.doc],
        sourceReference: v.sourceReference,
      });
    }

    const submitted = await sets.submit(actor, set.id, { acknowledgeWarnings: true });
    const tally = (submitted.findings as Json[]).reduce((t, f) => ({ ...t, [f.severity]: (t[f.severity] ?? 0) + 1 }), {} as Record<string, number>);
    const version = await sets.publishDirect(actor, set.id, values.reason);
    console.log(`Published data version ${version}: change set ${set.id}, ${known.size} records (findings: ${JSON.stringify(tally)}).`);
  } finally {
    await app.close();
  }
}

main().catch((err: Error & { details?: { findings?: { severity: string; message: string }[] } }) => {
  console.error(`Seed failed: ${err.message}`);
  for (const f of (err.details?.findings ?? []).filter((x) => x.severity === 'ERROR').slice(0, 20)) console.error(`  ${f.message}`);
  process.exit(1);
});
