import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { zip } from '../src/exports/tabular';
import { TEMPLATE_VERSION } from '../src/imports/template';
import { readWorkbook } from '../src/imports/xlsx-reader';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();
const monthStart = `${today.slice(0, 8)}01`;
const nextMonthStart = addDays(addDays(monthStart, 32).slice(0, 8) + '01', 0);

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

type TestCell = string | number | null | { f: string; v?: string };

/** A workbook the way Excel writes it: shared strings, numbers as <v>, optional formula cells. */
function xlsx(sheets: { name: string; rows: TestCell[][] }[], extra: [string, Buffer][] = []): Buffer {
  const strings: string[] = [];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetXml = (rows: TestCell[][]) =>
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
      const ref = `${col(ci)}${ri + 1}`;
      if (c === null) return '';
      if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
      if (typeof c === 'object') return `<c r="${ref}"><f>${esc(c.f)}</f><v>${c.v ?? '0'}</v></c>`;
      strings.push(c);
      return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
    }).join('')}</row>`).join('') + '</sheetData></worksheet>';
  const parts = sheets.map((s) => sheetXml(s.rows));
  const files: [string, Buffer][] = [
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')],
    ['xl/workbook.xml', Buffer.from('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="r"><sheets>' +
      sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="x">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="t" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>')],
    ...parts.map((p, i): [string, Buffer] => [`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(p)]),
    ['xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0"?><sst xmlns="x">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`)],
    ...extra,
  ];
  return zip(files);
}

const about = (version = TEMPLATE_VERSION) => ({ name: 'About', rows: [['ECR import template'], ['Template version', version]] as TestCell[][] });
const PRODUCT_HEADER = ['Row key', 'ECR id', 'Commodity', 'Group', 'Item no.', 'Name (Indonesian)', 'Name (English)', 'HS codes', 'Key spec name',
  'Key spec operator', 'Key spec value', 'Key spec unit', 'Classification regulation', 'Valid from', 'Definition', 'Ex description'];
const LINE_HEADER = ['ECR id', 'Regulation', 'Charge', 'Annex', 'Item no.', 'Uraian', 'Basis', 'Rate %', 'Reference series', 'Band table', 'Band amounts', 'Products', 'Valid from'];
const PRICE_HEADER = ['Series', 'Period from', 'Period to', 'Value', 'Decree', 'Source document'];

/** Entries of a ZIP the API wrote (local headers only). */
function unzipText(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const start = at + 30 + nameLength + buf.readUInt16LE(at + 28);
    out.set(buf.toString('utf8', at + 30, at + 30 + nameLength), inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    at = start + size;
  }
  return out;
}

const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('rollback and Excel import', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let checker2: Person;
  let viewer: { agent: Agent; me: Me };
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);

  function upload(officialUrl: string, docKind: string, docNumber: string) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind, title: `Decree ${docNumber}`, officialUrl, docNumber })) req.field(k, v);
    return req.attach('file', pdf(), { filename: 'decree.pdf', contentType: 'application/pdf' });
  }
  const importFile = (p: { agent: Agent; me: Me }, body: Buffer, filename = 'annex.xlsx') =>
    p.agent.post('/api/imports').set('X-CSRF-Token', p.me.csrfToken).attach('file', body, { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  async function newSet(title: string) {
    return (await send(maker, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201)).body.id as string;
  }
  async function item(setId: string, entityType: string, operation: string, after: object, entityId?: string): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation, after, entityId }).expect(200)).body;
    return entityId ?? (set.items[set.items.length - 1].entityId as string);
  }
  /** Submits, reviews with `reviewer` and approves now; returns the version. */
  async function publish(setId: string, reviewer: Person = checker): Promise<number> {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    return approve(setId, reviewer);
  }
  async function approve(setId: string, reviewer: Person): Promise<number> {
    await send(reviewer, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    return (await send(reviewer, 'post', `/api/change-sets/${setId}/approve`).expect(200)).body.versionNo as number;
  }
  const product = (overrides: object = {}) => ({
    groupId: ids.g1, itemNoAsPrinted: '1', nameId: 'Minyak Sawit Mentah', definition: 'CPO', classificationRegulationId: ids.reg, validFrom: '2024-01-01',
    parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code: '1511.10.00' }], ...overrides,
  });
  const current = async (entityId: string) => (await viewer.agent.get(`/api/products/${entityId}`)).body;
  const productNames = async () => (await viewer.agent.get('/api/products').expect(200)).body.map((p: { nameId: string }) => p.nameId).sort();

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    checker2 = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);

    const regDoc = (await upload('https://jdih.kemenkeu.go.id/dok/pmk-38-2024', 'REGULATION', 'PMK 38/2024').expect(201)).body;
    ids.priceDoc = (await upload('https://jdih.kemendag.go.id/peraturan/hr-cpo', 'REF_PRICE_DECREE', 'KEPMENDAG 77/2026').expect(201)).body.id;
    const set = await newSet('Base data');
    ids.reg = await item(set, 'REGULATION', 'CREATE', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE', effectiveOn: '2024-05-24',
      documents: [{ sourceDocumentId: regDoc.id, role: 'MAIN' }],
    });
    ids.palm = await item(set, 'COMMODITY', 'CREATE', { code: 'PALM', nameId: 'Kelapa sawit' });
    ids.g1 = await item(set, 'PRODUCT_GROUP', 'CREATE', { commodityId: ids.palm, code: 'I', label: 'Group I', ordinal: 1 });
    ids.cpo = await item(set, 'PRODUCT', 'CREATE', product());
    ids.cpoSeries = await item(set, 'REF_SERIES', 'CREATE', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    await item(set, 'REF_VALUE', 'CREATE', { seriesId: ids.cpoSeries, periodFrom: monthStart, periodTo: addDays(nextMonthStart, -1), value: '950', sourceDocumentId: ids.priceDoc });
    ids.bands = await item(set, 'BAND_TABLE', 'CREATE', {
      code: 'CPO-3', name: 'CPO', refSeriesId: ids.cpoSeries,
      bands: [{ lowerExclusive: null, upperInclusive: '680' }, { lowerExclusive: '680', upperInclusive: '1000' }, { lowerExclusive: '1000', upperInclusive: null }],
    });
    ids.bk = await item(set, 'SCHEDULE', 'CREATE', { regulationId: ids.reg, chargeType: 'BK', annexLabel: 'Lampiran I', commodityId: ids.palm });
    ids.pe = await item(set, 'SCHEDULE', 'CREATE', { regulationId: ids.reg, chargeType: 'PE', annexLabel: 'Lampiran', commodityId: ids.palm });
    ids.cpoLine = await item(set, 'SCHEDULE_LINE', 'CREATE', {
      scheduleId: ids.bk, uraian: 'Crude Palm Oil', itemNo: '1', productIds: [ids.cpo], validFrom: '2024-05-24', basisType: 'BAND_USD_PER_MT',
      bandTableId: ids.bands, refSeriesId: ids.cpoSeries, bandValues: ['0', '33', '74'],
    });
    await publish(set);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ rollback

  it('rolls back a version through a change set approved by a second Checker (US-30-P2, US-30-N1 AC2)', async () => {
    const set = await newSet('Rename CPO and add olein');
    await item(set, 'PRODUCT', 'UPDATE', product({ nameId: 'Minyak Sawit Mentah (salah)' }), ids.cpo);
    ids.olein = await item(set, 'PRODUCT', 'CREATE', product({ nameId: 'Olein Sawit', itemNoAsPrinted: '2', hsCodes: [{ code: '1511.90.36' }] }));
    const v = await publish(set);
    expect(await productNames()).toEqual(['Minyak Sawit Mentah (salah)', 'Olein Sawit']);

    // Makers cannot roll back; Checkers need a fresh authenticator code.
    await send(maker, 'post', `/api/data-versions/${v}/rollback`, { reason: 'Wrong name' }).expect(403);
    await h.expireStepUp(checker.me.session.id);
    expect((await send(checker, 'post', `/api/data-versions/${v}/rollback`, { reason: 'Wrong name' }).expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    await send(checker, 'post', '/api/auth/step-up', { code: h.nextCode(checker.secret) }).expect(200);
    await send(checker, 'post', `/api/data-versions/${v}/rollback`, {}).expect(400);

    const rollback = (await send(checker, 'post', `/api/data-versions/${v}/rollback`, { reason: 'Wrong name published' }).expect(201)).body;
    expect(rollback).toMatchObject({ kind: 'ROLLBACK', status: 'SUBMITTED', rollbackOfVersion: v, justification: 'Wrong name published' });
    expect(rollback.title).toBe('Rollback of version ' + v + ': Rename CPO and add olein');
    const ops = Object.fromEntries(rollback.items.map((i: { entityId: string; operation: string }) => [i.entityId, i.operation]));
    expect(ops).toEqual({ [ids.cpo]: 'UPDATE', [ids.olein]: 'WITHDRAW' });
    expect(rollback.items.find((i: { entityId: string }) => i.entityId === ids.cpo).changes).toEqual([
      { field: 'nameId', before: 'Minyak Sawit Mentah (salah)', after: 'Minyak Sawit Mentah' },
    ]);
    // The records are locked while the rollback is open.
    const other = await newSet('Concurrent edit');
    expect((await send(maker, 'put', `/api/change-sets/${other}/items`, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: ids.cpo, after: product() }).expect(409)).body.error.code).toBe('ENTITY_LOCKED');
    expect((await send(checker, 'post', `/api/data-versions/${v}/rollback`, { reason: 'Again' }).expect(409)).body.error.code).toBe('ROLLBACK_PENDING');

    // The initiator cannot review it (SoD-1); a second Checker approves.
    expect((await send(checker, 'post', `/api/change-sets/${rollback.id}/start-review`).expect(403)).body.error.code).toBe('SOD_VIOLATION');
    const w = await approve(rollback.id, checker2);
    expect(w).toBe(v + 1);
    expect(await productNames()).toEqual(['Minyak Sawit Mentah']);
    await viewer.agent.get(`/api/products/${ids.olein}`).expect(404);

    // History keeps the erroneous version, marked as rolled back.
    const versions = (await maker.agent.get('/api/data-versions').expect(200)).body;
    expect(versions.find((x: { versionNo: number }) => x.versionNo === v)).toMatchObject({ rolledBackByVersion: w });
    expect(versions.find((x: { versionNo: number }) => x.versionNo === w)).toMatchObject({ kind: 'ROLLBACK', rollbackOfVersion: v });
    const history = (await current(ids.cpo)).history;
    expect(history.find((x: { versionFrom: number }) => x.versionFrom === v)).toMatchObject({ rolledBackByVersion: w, label: '1. Minyak Sawit Mentah (salah)' });
    expect((await maker.agent.get(`/api/change-sets/${set}`).expect(200)).body.rolledBackByVersion).toBe(w);
    expect((await send(checker, 'post', `/api/data-versions/${v}/rollback`, { reason: 'Again' }).expect(409)).body.error.code).toBe('ALREADY_ROLLED_BACK');

    // Undoing the rollback brings the withdrawn record back under its own id.
    const undo = (await send(checker2, 'post', `/api/data-versions/${w}/rollback`, { reason: 'The rename was right after all' }).expect(201)).body;
    expect(Object.fromEntries(undo.items.map((i: { entityId: string; operation: string }) => [i.entityId, i.operation]))).toEqual({ [ids.cpo]: 'UPDATE', [ids.olein]: 'CREATE' });
    await approve(undo.id, checker);
    expect(await productNames()).toEqual(['Minyak Sawit Mentah (salah)', 'Olein Sawit']);
    expect((await current(ids.olein)).history.map((x: { versionFrom: number }) => x.versionFrom).sort((a: number, b: number) => a - b)).toEqual([v, w + 1]);
    await send(maker, 'post', `/api/change-sets/${other}/discard`).expect(200);
  });

  it('refuses a rollback that a later version overtook or that would break references', async () => {
    const a = await newSet('Rename once');
    await item(a, 'PRODUCT', 'UPDATE', product({ nameId: 'CPO A' }), ids.cpo);
    const va = await publish(a);
    const b = await newSet('Rename again');
    await item(b, 'PRODUCT', 'UPDATE', product({ nameId: 'CPO B' }), ids.cpo);
    const vb = await publish(b);
    const conflict = (await send(checker, 'post', `/api/data-versions/${va}/rollback`, { reason: 'Undo A' }).expect(409)).body.error;
    expect(conflict).toMatchObject({ code: 'ROLLBACK_CONFLICT', details: { conflicts: [{ entityId: ids.cpo, entityType: 'PRODUCT', laterVersion: vb }] } });

    // A group created in one version and used by a product in the next cannot be withdrawn alone.
    const g = await newSet('Group II');
    ids.g2 = await item(g, 'PRODUCT_GROUP', 'CREATE', { commodityId: ids.palm, code: 'II', label: 'Group II', ordinal: 2 });
    const vg = await publish(g);
    const p = await newSet('Kernel');
    await item(p, 'PRODUCT', 'CREATE', product({ groupId: ids.g2, nameId: 'Inti Sawit', hsCodes: [{ code: '1207.10.30' }] }));
    await publish(p);
    const invalid = (await send(checker, 'post', `/api/data-versions/${vg}/rollback`, { reason: 'Undo group' }).expect(422)).body.error;
    expect(invalid.code).toBe('ROLLBACK_INVALID');
    expect(invalid.details.findings[0]).toMatchObject({ ruleCode: 'ROLLBACK-REFERENCED', entityId: ids.g2 });
    expect((await maker.agent.get('/api/change-sets?status=SUBMITTED').expect(200)).body.filter((s: { kind: string }) => s.kind === 'ROLLBACK')).toEqual([]);

    // An open rollback can be cancelled by the Checker who started it, which releases its records.
    const rb = (await send(checker, 'post', `/api/data-versions/${vb}/rollback`, { reason: 'Undo B' }).expect(201)).body;
    await send(checker2, 'post', `/api/change-sets/${rb.id}/cancel-rollback`).expect(403);
    expect((await send(checker, 'post', `/api/change-sets/${rb.id}/cancel-rollback`).expect(200)).body.status).toBe('CANCELLED');
    const free = await newSet('Free again');
    await item(free, 'PRODUCT', 'UPDATE', product({ nameId: 'Minyak Sawit Mentah' }), ids.cpo);
    await publish(free);
  });

  // ------------------------------------------------------------------ import

  it('serves the current template with reference lists (L2-3.6 step 1)', async () => {
    const res = await maker.agent.get('/api/imports/template').buffer(true).parse(binary).expect(200);
    const book = readWorkbook(res.body as Buffer);
    expect([...book.keys()]).toEqual(['About', 'Products', 'Lines', 'Prices', 'Lists']);
    expect(book.get('About')!.get(2)!.get('B')!.value).toBe(TEMPLATE_VERSION);
    expect([...book.get('Products')!.get(1)!.values()].map((c) => c.value)).toContain('Name (Indonesian)');
    const lists = [...book.get('Lists')!.values()].map((r) => [...r.values()].map((c) => c.value).join('|'));
    expect(lists).toContain(`Schedule|PMK 38/2024 · BK · Lampiran I||${ids.bk}`);
    await viewer.agent.get('/api/imports/template').expect(403);
  });

  it('imports an annex in one dry run and one change set (US-28-P1)', async () => {
    const file = xlsx([
      about(),
      { name: 'Products', rows: [
        PRODUCT_HEADER,
        ['P-RBD', null, 'PALM', 'I', '3', 'RBD Palm Stearin', 'RBD palm stearin', '1511.90.42', 'ALB', '<=', 0.5, '%', 'PMK 38/2024', '2024-05-24', 'Stearin'],
        ['P-PKO', null, 'palm', 'I', 4, 'Minyak Inti Sawit', null, '15132110; ex 1513.29.11', 'ALB', '<=', 5, '%', 'pmk 38/2024', 45436, 'Kernel oil', 'Crude, for food use'],
        // Changes the published CPO: blank cells keep the published values.
        ['CPO', ids.cpo, null, null, null, null, 'Crude Palm Oil (CPO)', null, null, null, null, null, null, null, null],
      ] },
      { name: 'Lines', rows: [
        LINE_HEADER,
        [null, 'PMK 38/2024', 'BK', 'Lampiran I', '3', 'RBD Palm Stearin', 'BAND_USD_PER_MT', null, 'CPO', 'CPO-3', '0; 20; 50', 'P-RBD', '2024-05-24'],
        [null, 'PMK 38/2024', 'PE', 'lampiran', '4', 'Minyak inti sawit', 'PCT_OF_REF_PRICE', 7.5, 'CPO', null, null, `P-PKO; ${ids.cpo}`, '2024-05-24'],
      ] },
      { name: 'Prices', rows: [PRICE_HEADER, ['CPO', nextMonthStart, addDays(addDays(nextMonthStart, 32).slice(0, 8) + '01', -1), 1012.5, 'Kepmendag 78/2026', 'kepmendag 77/2026']] },
    ]);
    const job = (await importFile(maker, file).expect(201)).body;
    const errors = job.report.filter((e: { severity: string }) => e.severity === 'ERROR');
    expect(errors).toEqual([]);
    expect(job).toMatchObject({ status: 'VALIDATED', rowCount: 6, errorCount: 0, templateVersion: TEMPLATE_VERSION, changeSetId: null });
    expect(await h.auditActions(job.id)).toEqual(['IMPORT_VALIDATED']);

    // The dry run saved nothing.
    expect(await productNames()).not.toContain('RBD Palm Stearin');
    const committed = (await send(maker, 'post', `/api/imports/${job.id}/commit`, { title: 'PMK 38/2024 annex rows', acknowledgeWarnings: true }).expect(200)).body;
    expect(committed).toMatchObject({ status: 'COMMITTED' });
    const set = (await maker.agent.get(`/api/change-sets/${committed.changeSetId}`).expect(200)).body;
    expect(set).toMatchObject({ kind: 'IMPORT', status: 'DRAFT', title: 'PMK 38/2024 annex rows', importJob: { id: job.id, fileName: 'annex.xlsx' } });
    expect(set.items.map((i: { importRow: string; operation: string; entityType: string }) => `${i.importRow} ${i.entityType} ${i.operation}`)).toEqual([
      'Products!2 PRODUCT CREATE', 'Products!3 PRODUCT CREATE', 'Products!4 PRODUCT UPDATE',
      'Lines!2 SCHEDULE_LINE CREATE', 'Lines!3 SCHEDULE_LINE CREATE', 'Prices!2 REF_VALUE CREATE',
    ]);
    const cpoItem = set.items.find((i: { entityId: string }) => i.entityId === ids.cpo);
    expect(cpoItem.changes).toEqual([{ field: 'nameEn', before: null, after: 'Crude Palm Oil (CPO)' }]);
    const pko = set.items.find((i: { after: { nameId: string } }) => i.after.nameId === 'Minyak Inti Sawit');
    expect(pko.after).toMatchObject({ itemNoAsPrinted: '4', validFrom: '2024-05-24', parameters: [{ name: 'ALB', operator: '≤', valueText: '5', isPrimary: true }] });
    expect(pko.after.hsCodes.map((x: { code: string; isEx: boolean }) => `${x.isEx ? 'ex ' : ''}${x.code}`)).toEqual(['1513.21.10', 'ex 1513.29.11']);
    await send(maker, 'post', `/api/imports/${job.id}/commit`, {}).expect(409);

    await send(maker, 'post', `/api/change-sets/${committed.changeSetId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await approve(committed.changeSetId, checker);
    const rbd = (await viewer.agent.get('/api/catalogue?q=stearin').expect(200)).body.rows[0];
    expect(rbd.bk).toMatchObject({ status: 'CHARGED', usdPerMt: '20' });
  });

  it('reports every row problem and saves nothing when the file has errors (US-28-N1)', async () => {
    const file = xlsx([
      about(),
      { name: 'Products', rows: [
        PRODUCT_HEADER,
        ['BAD-1', null, 'PALM', 'I', '9', null, null, '1511.10', null, null, null, null, 'PMK 38/2024', '2024-05-24', null],
        ['BAD-2', null, 'PALM', 'Z', '10', 'Produk', null, '1511.10.00', null, null, null, null, 'PMK 99/2024', 'not a date', null],
        ['BAD-3', null, 'PALM', 'I', '11', '=HYPERLINK("x")', null, '1511.10.00', null, null, null, null, 'PMK 38/2024', '2024-05-24', { f: 'A1&"x"', v: 'y' }],
      ] },
      { name: 'Lines', rows: [
        LINE_HEADER,
        [null, 'PMK 38/2024', 'BK', 'Lampiran I', '12', 'Bad bands', 'BAND_USD_PER_MT', null, 'CPO', 'CPO-3', '0; 20', 'NOPE', '2024-05-24'],
        [null, 'PMK 38/2024', 'BK', 'Lampiran IX', '13', 'Unknown annex', 'ZERO_LISTED', null, null, null, null, null, '2024-05-24'],
      ] },
    ]);
    const job = (await importFile(maker, file).expect(201)).body;
    expect(job.status).toBe('VALIDATED_WITH_ERRORS');
    const at = (sheet: string, row: number) => job.report.filter((e: { sheet: string; row: number }) => e.sheet === sheet && e.row === row)
      .map((e: { column: string; field: string; code: string }) => `${e.column}:${e.field}:${e.code}`);
    expect(at('Products', 2)).toEqual(expect.arrayContaining(['F:Name (Indonesian):INVALID', 'H:HS codes:INVALID']));
    expect(at('Products', 3)).toEqual(expect.arrayContaining(['D:Group:NOT_FOUND', 'M:Classification regulation:NOT_FOUND', 'N:Valid from:DATE']));
    expect(at('Products', 4)).toEqual(expect.arrayContaining(['F:Name (Indonesian):FORMULA_TEXT', 'O:Definition:FORMULA']));
    expect(at('Lines', 2)).toEqual(['L:Products:NOT_FOUND']);
    expect(at('Lines', 3)).toEqual(['D:Annex:NOT_FOUND']);
    expect(job.errorCount).toBe(job.report.filter((e: { severity: string }) => e.severity === 'ERROR').length);
    expect(job.report).toContainEqual(expect.objectContaining({ severity: 'INFO', code: 'CHECKS_PENDING' }));

    expect((await send(maker, 'post', `/api/imports/${job.id}/commit`, {}).expect(422)).body.error.code).toBe('IMPORT_INVALID');
    expect(await productNames()).not.toContain('Produk');

    // The report downloads as a workbook (US-28-N1 AC1), formula text neutralised.
    const report = await maker.agent.get(`/api/imports/${job.id}/report`).buffer(true).parse(binary).expect(200);
    const sheet = unzipText(report.body as Buffer).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('Formula cells are not accepted');
    expect(sheet).toMatch(/<t xml:space="preserve">Products<\/t>/);
    await viewer.agent.get(`/api/imports/${job.id}`).expect(404);
    expect((await checker.agent.get(`/api/imports/${job.id}`).expect(200)).body.id).toBe(job.id);

    // Rules across records run once every row reads: two amounts for a three-band table.
    const bands = xlsx([about(), { name: 'Lines', rows: [
      LINE_HEADER,
      [null, 'PMK 38/2024', 'BK', 'Lampiran I', '14', 'Two bands', 'BAND_USD_PER_MT', null, 'CPO', 'CPO-3', '0; 20', ids.cpo, '2024-05-24'],
    ] }]);
    const bandJob = (await importFile(maker, bands).expect(201)).body;
    expect(bandJob.report.filter((e: { severity: string }) => e.severity === 'ERROR').map((e: { sheet: string; row: number; code: string }) => `${e.sheet}!${e.row} ${e.code}`))
      .toEqual(expect.arrayContaining(['Lines!2 DQ-06']));
  });

  it('refuses unsafe or outdated files before reading rows (US-28-N1 AC2, AC4)', async () => {
    const outdated = (await importFile(maker, xlsx([about('ECR-IMPORT-0'), { name: 'Products', rows: [PRODUCT_HEADER] }])).expect(422)).body.error;
    expect(outdated).toMatchObject({ code: 'TEMPLATE_OUTDATED', details: { templateUrl: '/api/imports/template', found: 'ECR-IMPORT-0' } });
    expect((await importFile(maker, pdf(), 'annex.xlsx').expect(422)).body.error.code).toBe('FILE_REJECTED');
    expect((await importFile(maker, xlsx([about()]), 'annex.csv').expect(422)).body.error.code).toBe('FILE_REJECTED');
    const macro = xlsx([about()], [['xl/vbaProject.bin', randomBytes(64)]]);
    expect((await importFile(maker, macro).expect(422)).body.error.message).toContain('macros');
    const dtd = zip([['xl/workbook.xml', Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><workbook/>')]]);
    expect((await importFile(maker, dtd).expect(422)).body.error.code).toBe('FILE_REJECTED');
    const big = Buffer.concat([xlsx([about()]), Buffer.alloc(10 * 1024 * 1024)]);
    expect((await importFile(maker, big).expect(422)).body.error.code).toBe('FILE_TOO_LARGE');
    await importFile(viewer, xlsx([about()])).expect(403);
    const empty = (await importFile(maker, xlsx([about(), { name: 'Products', rows: [PRODUCT_HEADER] }])).expect(201)).body;
    expect(empty.report).toEqual([expect.objectContaining({ code: 'EMPTY', severity: 'ERROR' })]);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM ecr.audit_event WHERE action = 'IMPORT_REJECTED'`);
    expect(rows[0].n).toBe(6);
  });

  it('flags records that are open in another change set', async () => {
    const open = await newSet('Holding CPO');
    await item(open, 'PRODUCT', 'UPDATE', product({ nameId: 'CPO held' }), ids.cpo);
    const job = (await importFile(maker, xlsx([about(), { name: 'Products', rows: [
      PRODUCT_HEADER, ['CPO', ids.cpo, null, null, null, 'CPO imported', null, null, null, null, null, null, null, null, null],
    ] }])).expect(201)).body;
    expect(job.report.filter((e: { severity: string }) => e.severity === 'ERROR')).toEqual([expect.objectContaining({ sheet: 'Products', row: 2, column: 'B', code: 'ENTITY_LOCKED' })]);
    await send(maker, 'post', `/api/change-sets/${open}/discard`).expect(200);
  });
});
