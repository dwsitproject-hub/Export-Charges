import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { APP_CONFIG, AppConfig } from '../src/config';
import { safeText } from '../src/exports/tabular';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();
const monthStart = `${today.slice(0, 8)}01`;

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

/** Entries of a ZIP file (local headers only; enough for the files the API writes). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLength);
    const start = at + 30 + nameLength + extra;
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    at = start + size;
  }
  return out;
}

const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('exports and evidence packs', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  let other: { agent: Agent; me: Me };
  let auditor: Person;
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const download = (p: { agent: Agent }, path: string) => p.agent.get(path).buffer(true).parse(binary);

  function upload(officialUrl: string, docKind: string, title: string) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind, title, officialUrl })) req.field(k, v);
    return req.attach('file', pdf(), { filename: 'decree.pdf', contentType: 'application/pdf' });
  }

  async function create(setId: string, entityType: string, after: object): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation: 'CREATE', after }).expect(200)).body;
    return set.items[set.items.length - 1].entityId as string;
  }

  const save = async (body: object) => (await send(viewer, 'post', '/api/calculations', body).expect(201)).body.id as string;

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    auditor = await h.privileged(['AUDITOR']);
    viewer = await h.signedIn(['VIEWER']);
    other = await h.signedIn(['VIEWER']);

    const regDoc = (await upload('https://jdih.kemenkeu.go.id/dok/pmk-38-2024', 'REGULATION', 'PMK 38/2024 Bea Keluar').expect(201)).body;
    const priceDoc = (await upload('https://jdih.kemendag.go.id/peraturan/hr-cpo', 'REF_PRICE_DECREE', 'Kepmendag harga referensi CPO').expect(201)).body;
    const fxDoc = (await upload('https://fiskal.kemenkeu.go.id/kurs-pajak', 'FX_DECREE', 'KMK kurs').expect(201)).body;
    ids.regDocSha = regDoc.sha256;

    const set = (await send(maker, 'post', '/api/change-sets', { title: 'Export fixture', justification: 'Test data' }).expect(201)).body.id;
    ids.reg = await create(set, 'REGULATION', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE',
      effectiveOn: '2024-05-24', documents: [{ sourceDocumentId: regDoc.id, role: 'MAIN' }],
    });
    const palm = await create(set, 'COMMODITY', { code: 'PALM', nameId: 'Kelapa sawit' });
    const group = await create(set, 'PRODUCT_GROUP', { commodityId: palm, code: 'I', label: 'Group I', ordinal: 1 });
    const product = (itemNo: string, nameId: string, code: string, extra: object = {}) => ({
      groupId: group, itemNoAsPrinted: itemNo, nameId, definition: nameId, classificationRegulationId: ids.reg, validFrom: '2024-01-01',
      parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code }], ...extra,
    });
    ids.cpo = await create(set, 'PRODUCT', product('1', 'Minyak Sawit Mentah', '1511.10.00', { nameEn: 'Crude Palm Oil (CPO)' }));
    ids.olein = await create(set, 'PRODUCT', product('2', '=HYPERLINK("http://evil")', '1511.90.36'));
    ids.glycerine = await create(set, 'PRODUCT', product('3', 'Gliserín Kasar', '1520.00.10'));
    ids.cpoSeries = await create(set, 'REF_SERIES', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    await create(set, 'REF_VALUE', { seriesId: ids.cpoSeries, periodFrom: monthStart, periodTo: addDays(today, 60), value: '950', sourceDocumentId: priceDoc.id, sourceReference: 'Kepmendag 1234/2026' });
    const fx = await create(set, 'REF_SERIES', { code: 'FX-USDIDR', name: 'Kurs Menteri Keuangan', kind: 'FX_RATE', unit: 'IDR/USD', cadence: 'WEEKLY' });
    await create(set, 'REF_VALUE', { seriesId: fx, periodFrom: addDays(today, -3), periodTo: addDays(today, 3), value: '16250.5', sourceDocumentId: fxDoc.id });
    const bands = await create(set, 'BAND_TABLE', {
      code: 'CPO-3', name: 'CPO', refSeriesId: ids.cpoSeries,
      bands: [{ lowerExclusive: null, upperInclusive: '680' }, { lowerExclusive: '680', upperInclusive: '1000' }, { lowerExclusive: '1000', upperInclusive: null }],
    });
    const bk = await create(set, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'BK', annexLabel: 'Lampiran I', commodityId: palm });
    const pe = await create(set, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'PE', annexLabel: 'Lampiran', commodityId: palm });
    await create(set, 'SCHEDULE_LINE', { scheduleId: bk, uraian: 'Crude Palm Oil', itemNo: '1', productIds: [ids.cpo], validFrom: '2024-05-24', basisType: 'BAND_USD_PER_MT', bandTableId: bands, refSeriesId: ids.cpoSeries, bandValues: ['0', '33', '74'] });
    await create(set, 'SCHEDULE_LINE', { scheduleId: pe, uraian: 'Crude Palm Oil', productIds: [ids.cpo], validFrom: '2024-05-24', basisType: 'PCT_OF_REF_PRICE', pct: '10', refSeriesId: ids.cpoSeries });
    await create(set, 'SCHEDULE_LINE', { scheduleId: pe, uraian: 'Olein', productIds: [ids.olein], validFrom: '2024-05-24', basisType: 'ZERO_LISTED' });
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    ids.version = String((await send(checker, 'post', `/api/change-sets/${set}/approve`).expect(200)).body.versionNo);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ CSV / XLSX

  it('exports the filtered catalogue to CSV with the as-of date, version, user and disclaimer (US-47-P1)', async () => {
    const res = await download(viewer, `/api/exports/catalogue?format=csv&date=${today}`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="ecr-catalogue-${today}-v${ids.version}.csv"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = body.toString('utf8').slice(1);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('ECR — export duty (BK) and levy (PE) catalogue');
    expect(text).toContain(`As-of date (PEB date),${today}\r\n`);
    expect(text).toContain(`Data version,"${ids.version}, published`);
    expect(text).toContain(`Harga referensi CPO,CPO 950 USD/MT (${monthStart} – ${addDays(today, 60)}); band 2 (680–1000) of CPO-3\r\n`);
    expect(text).toContain(`<${viewer.me.user.email}>`);
    expect(text).toContain('Disclaimer,Indicative calculation');
    const headerAt = lines.findIndex((l) => l.startsWith('Commodity,Group,Item no.,Product,'));
    const rows = lines.slice(headerAt + 1).filter(Boolean);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Minyak Sawit Mentah');
    expect(rows[0]).toContain(',Charged,33,USD/MT by price band,Band 2 (680–1000),');
    expect(rows[0]).toContain('PMK 38/2024, Lampiran I, no. 1');
    expect(rows[0]).toContain(',128,No,PMK 38/2024');
    // US-47-N1 AC2: a cell that would start a formula is neutralised.
    expect(rows[1]).toContain(`,"'=HYPERLINK(""http://evil"")",`);
    expect(rows[2]).toContain('Gliserín Kasar');

    const filtered = (await download(viewer, `/api/exports/catalogue?format=csv&date=${today}&category=BOTH&q=minyak`).expect(200)).body.toString('utf8');
    expect(filtered).toContain('Search and filters,"search ""minyak""; category Duty and levy"');
    expect(filtered).toContain('Rows,1\r\n');
    expect(await h.auditActions(viewer.me.user.id)).toContain('EXPORT_DOWNLOADED');
  });

  it('exports the catalogue to XLSX with numbers as numbers and a filter row', async () => {
    const res = await download(viewer, `/api/exports/catalogue?format=xlsx&date=${today}&sort=total&dir=desc`).expect(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const files = unzip(res.body as Buffer);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">Minyak Sawit Mentah</t>');
    expect(sheet).toMatch(/<c r="J\d+"><v>33<\/v><\/c>/);
    expect(sheet).toContain('<t xml:space="preserve">\'=HYPERLINK(&quot;http://evil&quot;)</t>');
    expect(sheet).toMatch(/<autoFilter ref="A\d+:W\d+"\/>/);
    expect(sheet).toContain('state="frozen"');
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Catalogue"');
  });

  it('refuses exports without the permission or with an unknown format (US-47-N1 AC1)', async () => {
    const nobody = await h.signedIn([]);
    await nobody.agent.get('/api/exports/catalogue?format=csv').expect(403);
    await viewer.agent.get('/api/exports/catalogue?format=pdf').expect(400);
    await viewer.agent.get('/api/exports/catalogue').expect(400);
    expect(safeText('+62 21')).toBe("'+62 21");
    expect(safeText('-5')).toBe("'-5");
    expect(safeText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(safeText('Olein')).toBe('Olein');
  });

  it('exports a saved calculation with totals; only its author can (US-47-P1, US-44-P3)', async () => {
    const id = await save({ lines: [{ productId: ids.cpo, quantityMt: '2.5' }, { productId: ids.olein, quantityMt: '10' }] });
    const csv = (await download(viewer, `/api/exports/calculations/${id}?format=csv`).expect(200)).body.toString('utf8');
    expect(csv).toContain(`Calculation,${id}\r\n`);
    expect(csv).toContain('Total USD,320\r\n');
    expect(csv).toContain('Total IDR,"5,200,160"\r\n');
    expect(csv).toMatch(/\r\n1,Minyak Sawit Mentah,1511\.10\.00,2\.5,Charged,USD\/MT by price band,Band 2 \(680–1000\),33,82\.5,/);
    expect(csv).toMatch(/\r\nTotal,,,,,,,,82\.5,,,,,,,237\.5,,,320,,,5200160,IDR rounded/);
    expect(csv).toContain('Evidence pack,none');
    await other.agent.get(`/api/exports/calculations/${id}?format=csv`).expect(404);

    const sim = await save({ lines: [{ productId: ids.cpo, quantityMt: 1 }], refPriceOverride: '1100' });
    const simCsv = (await download(viewer, `/api/exports/calculations/${sim}?format=xlsx`).expect(200)).body;
    expect(unzip(simCsv).get('xl/worksheets/sheet1.xml')).toContain('SIMULATION (what-if reference price), not official evidence');
  });

  // ------------------------------------------------------------------ evidence

  it('generates one PDF/A evidence pack per calculation with its hashes (FR-EXP-02)', async () => {
    const id = await save({ lines: [{ productId: ids.cpo, quantityMt: '2.5' }, { productId: ids.glycerine, quantityMt: '1' }] });
    const created = await send(viewer, 'post', `/api/calculations/${id}/evidence`).expect(201);
    const pack = created.body;
    expect(pack).toMatchObject({ created: true, calculationId: id, pdfaProfile: 'PDF/A-2b' });
    expect(pack.evidenceId).toMatch(/^EV-[0-9a-f-]{36}$/);
    expect(pack.verifyUrl).toBe(`http://ecr.test/verify/${pack.evidenceId}`);
    expect(pack.retainUntil >= addDays(today, 3650)).toBe(true);

    // Asking again returns the same pack.
    const again = await send(viewer, 'post', `/api/calculations/${id}/evidence`).expect(200);
    expect(again.body).toMatchObject({ created: false, evidenceId: pack.evidenceId });

    const file = await download(viewer, `/api/evidence/${pack.evidenceId}/file`).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const body = file.body as Buffer;
    expect(createHash('sha256').update(body).digest('hex')).toBe(pack.pdfSha256);
    const raw = body.toString('latin1');
    expect(raw.startsWith('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')).toBe(true);
    expect(raw).toContain('<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
    expect(raw).toContain(`<dc:identifier>${pack.evidenceId}</dc:identifier>`);
    expect(raw).toContain(`Content SHA-256 ${pack.contentSha256}`);
    expect(raw).toContain('/S /GTS_PDFA1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+DejaVuSans /);
    expect(raw).toContain('/FontFile2');
    expect(raw).toMatch(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
    expect(raw).not.toContain('/Encrypt');
    expect(raw).not.toContain('/JavaScript');

    const { rows: [row] } = await h.pool.query('SELECT payload FROM ecr.evidence_pack WHERE evidence_id = $1', [pack.evidenceId]);
    expect(row.payload.calculation).toMatchObject({ id, versionNo: Number(ids.version), status: 'COMPLETE' });
    expect(row.payload.totals).toEqual({ bkUsd: '82.5', peUsd: '237.5', usd: '320', idr: '5200160' });
    expect(row.payload.lines[1]).toMatchObject({ product: 'Gliserín Kasar', hsCodes: ['1520.00.10'], bk: { status: 'NOT_LISTED' } });
    expect(row.payload.referenceValues.map((v: { seriesCode: string }) => v.seriesCode)).toEqual(['CPO', 'FX-USDIDR']);
    expect(row.payload.legalReferences).toEqual([
      expect.objectContaining({ chargeType: 'BK', regulation: 'PMK 38/2024', annex: 'Lampiran I', itemNo: '1' }),
      expect.objectContaining({ chargeType: 'PE', regulation: 'PMK 38/2024' }),
    ]);
    expect(row.payload.sources.map((s: { sha256: string }) => s.sha256)).toContain(ids.regDocSha);
    expect(row.payload.sources).toHaveLength(3);

    // The calculation now points at its pack.
    expect((await viewer.agent.get(`/api/calculations/${id}`).expect(200)).body.evidenceId).toBe(pack.evidenceId);
    expect((await viewer.agent.get('/api/calculations').expect(200)).body.find((c: { id: string }) => c.id === id).evidenceId).toBe(pack.evidenceId);
    const { rows: audit } = await h.pool.query(`SELECT action FROM ecr.audit_event WHERE entity_type = 'EVIDENCE_PACK' AND entity_id = $1`, [pack.evidenceId]);
    expect(audit.map((a) => a.action)).toEqual(['EVIDENCE_CREATED']);
    ids.evidence = pack.evidenceId;
    ids.evidenceCalc = id;
  });

  it('lets any signed-in user verify a pack, but only its author and auditors download it', async () => {
    const check = (await other.agent.get(`/api/evidence/${ids.evidence}/verify`).expect(200)).body;
    expect(check).toMatchObject({
      evidenceId: ids.evidence, valid: true, checks: { pdfIntact: true, payloadIntact: true, replayMatch: true },
      versionNo: Number(ids.version), pebDate: today, totals: { usd: '320', idr: '5200160' }, canDownload: false,
    });
    expect(check.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    // Lower-case IDs from a pasted URL work too.
    await other.agent.get(`/api/evidence/${ids.evidence.toLowerCase()}/verify`).expect(200);
    await other.agent.get(`/api/evidence/${ids.evidence}/file`).expect(404);
    await other.agent.get(`/api/evidence/${ids.evidence}`).expect(404);
    await other.agent.get('/api/evidence/EV-not-an-id/verify').expect(404);
    await download(auditor, `/api/evidence/${ids.evidence}/file`).expect(200);
    expect((await auditor.agent.get(`/api/evidence/${ids.evidence}/verify`).expect(200)).body.canDownload).toBe(true);
  });

  it('refuses evidence for simulations, incomplete results and other people\'s calculations (BR-CAL-12)', async () => {
    const sim = await save({ lines: [{ productId: ids.cpo, quantityMt: 1 }], refPriceOverride: '1100' });
    expect((await send(viewer, 'post', `/api/calculations/${sim}/evidence`).expect(422)).body.error.code).toBe('SIMULATION_NOT_EVIDENCE');
    const incomplete = await save({ lines: [{ productId: ids.cpo, quantityMt: 1 }], paymentDate: addDays(today, 20) });
    expect((await send(viewer, 'post', `/api/calculations/${incomplete}/evidence`).expect(422)).body.error.code).toBe('CALCULATION_INCOMPLETE');
    await send(other, 'post', `/api/calculations/${ids.evidenceCalc}/evidence`).expect(404);
    const nobody = await h.signedIn([]);
    await send(nobody, 'post', `/api/calculations/${ids.evidenceCalc}/evidence`).expect(403);
  });

  it('detects a tampered file or a calculation that no longer replays, and keeps packs immutable', async () => {
    await expect(h.pool.query(`UPDATE ecr.evidence_pack SET byte_size = 1 WHERE evidence_id = $1`, [ids.evidence])).rejects.toThrow(/evidence/);
    await expect(h.pool.query(`DELETE FROM ecr.evidence_pack WHERE evidence_id = $1`, [ids.evidence])).rejects.toThrow(/evidence/);

    const { storageDir } = h.app.get<AppConfig>(APP_CONFIG);
    const { rows: [pack] } = await h.pool.query('SELECT object_key FROM ecr.evidence_pack WHERE evidence_id = $1', [ids.evidence]);
    const path = join(storageDir, pack.object_key);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('% changed\n')]));
    expect((await viewer.agent.get(`/api/evidence/${ids.evidence}/verify`).expect(200)).body).toMatchObject({ valid: false, checks: { pdfIntact: false, replayMatch: true } });
    expect((await viewer.agent.get(`/api/evidence/${ids.evidence}/file`).expect(409)).body.error.code).toBe('EVIDENCE_INTEGRITY');
    await writeFile(path, original);
    expect((await viewer.agent.get(`/api/evidence/${ids.evidence}/verify`).expect(200)).body.valid).toBe(true);

    // A stored result that no longer matches its replay cannot become evidence.
    const id = await save({ lines: [{ productId: ids.cpo, quantityMt: '4' }] });
    await h.pool.query('ALTER TABLE ecr.calculation DISABLE TRIGGER calculation_immutable_trg');
    await h.pool.query(`UPDATE ecr.calculation SET result_hash = sha256('tampered') WHERE id = $1`, [id]);
    await h.pool.query('ALTER TABLE ecr.calculation ENABLE TRIGGER calculation_immutable_trg');
    expect((await send(viewer, 'post', `/api/calculations/${id}/evidence`).expect(409)).body.error.code).toBe('REPLAY_MISMATCH');
    expect(await h.auditActions(id)).toContain('EVIDENCE_REPLAY_MISMATCH');
  });

  it('prints a changed disclaimer on new results, while saved calculations still replay (F-52)', async () => {
    const before = await save({ lines: [{ productId: ids.cpo, quantityMt: '3' }] });
    const admin = await h.privileged(['SUPER_ADMIN']);
    const wording = 'Changed wording: indicative only; Customs and BPDP assess the official amounts.';
    await send(admin, 'put', '/api/admin/config', { values: { disclaimer: wording }, reason: 'Legal review' }).expect(200);

    const after = await save({ lines: [{ productId: ids.cpo, quantityMt: '3' }] });
    expect((await viewer.agent.get(`/api/calculations/${after}`).expect(200)).body.disclaimer).toBe(wording);
    expect((await viewer.agent.get(`/api/calculations/${before}`).expect(200)).body.disclaimer).toMatch(/^Indicative calculation/);
    expect((await viewer.agent.get(`/api/calculations/${before}/verify`).expect(200)).body.match).toBe(true);
    expect((await viewer.agent.get(`/api/calculations/${after}/verify`).expect(200)).body.match).toBe(true);
    const pack = (await send(viewer, 'post', `/api/calculations/${before}/evidence`).expect(201)).body;
    expect((await viewer.agent.get(`/api/evidence/${pack.evidenceId}/verify`).expect(200)).body.valid).toBe(true);
    const csv = (await download(viewer, `/api/exports/catalogue?format=csv&date=${today}`).expect(200)).body.toString('utf8');
    expect(csv).toContain(`Disclaimer,${wording.includes(',') ? `"${wording}"` : wording}`);

    await send(admin, 'put', '/api/admin/config', { values: { disclaimer: null }, reason: 'Back to the default' }).expect(200);
    expect((await viewer.agent.get(`/api/calculations/${await save({ lines: [{ productId: ids.cpo, quantityMt: '1' }] })}`).expect(200)).body.disclaimer)
      .toMatch(/^Indicative calculation/);
  });
});
