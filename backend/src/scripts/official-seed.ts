/**
 * Loads the official palm data set (seed/official-palm-2026-11.json) as one change set and publishes it without a
 * Checker: the first load of a new environment (scripts/seed-official-data.ts), and the starting registry of tests.
 */
import type { Actor } from '../auth/actor';
import type { ChangeSetsService } from '../registry/change-sets.service';
import type { SourceDocumentsService } from '../registry/source-documents.service';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function loadOfficialSeed(
  sets: ChangeSetsService, documents: SourceDocumentsService, actor: Actor, seed: Json, reason: string,
  pdfFor: (doc: Json) => Promise<Buffer>, log: (line: string) => void = () => {},
): Promise<{ version: number; setId: string; records: number; findings: Record<string, number> }> {
  log(`Source documents (${seed.documents.length}) ...`);
  const docIds: Record<string, string> = {};
  for (const d of seed.documents) {
    const body = await pdfFor(d);
    const saved: Json = await documents.upload(actor, { buffer: body, originalname: d.file, size: body.length },
      { docKind: d.docKind, title: d.title, docNumber: d.docNumber, docDate: d.docDate, officialUrl: d.officialUrl });
    docIds[d.key] = saved.id;
    log(`  ${d.file}  ${d.sha256.slice(0, 12)}  ${saved.reused ? 'already stored' : 'stored'}`);
  }

  const set = await sets.create(actor, {
    title: seed.title.slice(0, 200),
    justification: `${reason}\n\nInitial load (${seed.version}) published directly without a Checker. Sources: `
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

  log(`Products (${seed.products.length}) ...`);
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
  log(`Duty and levy lines (${seed.bkLines.length} + ${seed.peLines.length}) ...`);
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
  const version = await sets.publishDirect(actor, set.id, reason);
  return { version, setId: set.id, records: known.size, findings: tally };
}
