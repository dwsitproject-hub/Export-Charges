import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { selectBand } from '../src/tariffs/charge-engine';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();
/** First day of the month `date` falls in. */
const firstOf = (date: string) => `${date.slice(0, 8)}01`;
const monthStart = firstOf(today);
const nextMonthStart = firstOf(addDays(monthStart, 32));
const monthEnd = addDays(nextMonthStart, -1);
const nextMonthEnd = addDays(firstOf(addDays(nextMonthStart, 32)), -1);
const lastMonthEnd = addDays(monthStart, -1);
const lastMonthStart = firstOf(lastMonthEnd);

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

describe('duty and levy schedules, band tables and reference prices', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put' | 'delete', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);

  function upload(officialUrl = 'https://jdih.kemendag.go.id/peraturan/kepmendag-harga-referensi-cpo', fields: Record<string, string> = {}) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REF_PRICE_DECREE', title: 'Kepmendag harga referensi', officialUrl, ...fields })) req.field(k, v);
    return req.attach('file', pdf(), { filename: 'decree.pdf', contentType: 'application/pdf' });
  }

  async function newSet(title = 'Tariff change') {
    return (await send(maker, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201)).body.id as string;
  }

  /** Saves an item and returns the change set; the item is the last one with that entity id or the newest. */
  async function put(setId: string, item: object, status = 200) {
    return (await send(maker, 'put', `/api/change-sets/${setId}/items`, item).expect(status)).body;
  }

  /** Adds a record and returns its entity id. */
  async function create(setId: string, entityType: string, after: object): Promise<string> {
    const set = await put(setId, { entityType, operation: 'CREATE', after });
    return set.items[set.items.length - 1].entityId as string;
  }

  async function publish(setId: string) {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    const res = await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200);
    expect(res.body.status).toBe('PUBLISHED');
    return res.body;
  }

  async function submitFindings(setId: string, acknowledgeWarnings = false) {
    const res = await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings }).expect(422);
    return res.body.error.details.findings as { ruleCode: string; severity: string; message: string }[];
  }

  const charges = async (productId: string, date = today) =>
    (await viewer.agent.get(`/api/products/${productId}/charges?date=${date}`).expect(200)).body;

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);

    // Regulation, commodity, group and three palm products, then the CPO and FX series with this month's values.
    const regDoc = (await upload('https://jdih.kemenkeu.go.id/dok/pmk-38-2024', { docKind: 'REGULATION', title: 'PMK 38/2024' }).expect(201)).body;
    const base = await newSet('Palm base data');
    ids.reg = await create(base, 'REGULATION', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE',
      effectiveOn: '2024-05-24', documents: [{ sourceDocumentId: regDoc.id, role: 'MAIN' }],
    });
    ids.palm = await create(base, 'COMMODITY', { code: 'PALM', nameId: 'Kelapa sawit' });
    ids.group = await create(base, 'PRODUCT_GROUP', { commodityId: ids.palm, code: 'I', label: 'Group I', ordinal: 1 });
    const product = (name: string, code: string) => ({
      groupId: ids.group, nameId: name, definition: name, classificationRegulationId: ids.reg, validFrom: '2024-01-01',
      parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code }],
    });
    ids.cpo = await create(base, 'PRODUCT', product('Minyak Sawit Mentah (CPO)', '1511.10.00'));
    ids.olein = await create(base, 'PRODUCT', product('RBD Palm Olein', '1511.90.36'));
    ids.kernel = await create(base, 'PRODUCT', product('Inti Sawit', '1207.10.30'));
    await publish(base);

    const decree = (await upload().expect(201)).body;
    ids.decree = decree.id;
    const prices = await newSet('CPO and FX series');
    ids.cpoSeries = await create(prices, 'REF_SERIES', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    ids.fx = await create(prices, 'REF_SERIES', { code: 'FX-USDIDR', name: 'Kurs Menteri Keuangan', kind: 'FX_RATE', unit: 'IDR/USD', cadence: 'WEEKLY' });
    ids.cpoValue = await create(prices, 'REF_VALUE', {
      seriesId: ids.cpoSeries, periodFrom: monthStart, periodTo: monthEnd, value: '950', sourceDocumentId: decree.id, sourceReference: 'Kepmendag 1/2026',
    });
    await publish(prices);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ reference prices

  it('validates reference prices and publishes them with their decree (US-27)', async () => {
    const setId = await newSet('Next month CPO price');
    // US-27-N1 AC3 and period order are checked on save.
    await put(setId, { entityType: 'REF_VALUE', operation: 'CREATE', after: { seriesId: ids.cpoSeries, periodFrom: nextMonthStart, periodTo: nextMonthEnd, value: '0' } }, 400);
    await put(setId, { entityType: 'REF_VALUE', operation: 'CREATE', after: { seriesId: ids.cpoSeries, periodFrom: nextMonthEnd, periodTo: nextMonthStart, value: '900' } }, 400);

    // Overlap with the published month (BR-REF-01) and no decree (BR-SRC-01) block submission.
    await create(setId, 'REF_VALUE', { seriesId: ids.cpoSeries, periodFrom: addDays(monthEnd, -3), periodTo: nextMonthEnd, value: '1300' });
    let findings = await submitFindings(setId);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: 'BR-REF-01', severity: 'ERROR' }),
      expect.objectContaining({ ruleCode: 'BR-SRC-01', severity: 'ERROR' }),
    ]));

    const set = (await h.pool.query(`SELECT id FROM ecr.change_item WHERE change_set_id = $1`, [setId])).rows[0];
    await put(setId, {
      itemId: set.id, entityType: 'REF_VALUE', operation: 'CREATE',
      after: { seriesId: ids.cpoSeries, periodFrom: nextMonthStart, periodTo: nextMonthEnd, value: '1300', sourceDocumentId: ids.decree },
    });
    // Fixed; what remains is the jump of more than 30 % from 950 (BR-REF-02), which needs acknowledgement.
    findings = await submitFindings(setId);
    expect(findings).toEqual([expect.objectContaining({ ruleCode: 'BR-REF-02', severity: 'WARNING', message: expect.stringContaining('36.8 %') })]);
    await publish(setId);

    const series = (await viewer.agent.get('/api/ref-series').expect(200)).body;
    const cpo = series.find((s: { code: string }) => s.code === 'CPO');
    expect(cpo.current).toMatchObject({ value: '950', periodFrom: monthStart, periodTo: monthEnd, sourceDocumentId: ids.decree });
    expect(cpo.latest).toMatchObject({ value: '1300', periodFrom: nextMonthStart });
    const detail = (await viewer.agent.get(`/api/ref-series/${ids.cpoSeries}`).expect(200)).body;
    expect(detail.values.map((v: { value: string }) => v.value)).toEqual(['1300', '950']);
    expect(detail.values[0].sourceDocument).toMatchObject({ publisher: 'JDIH Kementerian Perdagangan' });

    // DQ-07: a gap between periods is flagged.
    const gap = await newSet('Gap');
    await create(gap, 'REF_VALUE', { seriesId: ids.cpoSeries, periodFrom: addDays(nextMonthEnd, 40), periodTo: addDays(nextMonthEnd, 60), value: '1310', sourceDocumentId: ids.decree });
    expect(await submitFindings(gap)).toEqual([expect.objectContaining({ ruleCode: 'DQ-07', severity: 'WARNING' })]);
    await send(maker, 'post', `/api/change-sets/${gap}/discard`).expect(200);

    // BR-REF-01 holds in the database too.
    await h.pool.query(`INSERT INTO ecr.entity_key (entity_id, entity_type) VALUES ('00000000-0000-7000-8000-000000000001', 'REF_VALUE')`);
    await expect(h.pool.query(
      `INSERT INTO ecr.ref_value (entity_id, valid_from, valid_to, version_from, change_set_id, series_entity_id, period_from, period_to, value, source_document_id)
       SELECT '00000000-0000-7000-8000-000000000001', valid_from, valid_to, version_from, change_set_id, series_entity_id, period_from, period_to, value, source_document_id
         FROM ecr.ref_value WHERE entity_id = $1 AND version_to IS NULL`, [ids.cpoValue],
    )).rejects.toThrow(/ref_value_no_overlap/);
  });

  // ------------------------------------------------------------------ band tables

  it('requires band tables to run from 0 to no ceiling without gaps or overlaps (BR-TRF-02)', async () => {
    const setId = await newSet('CPO bands');
    const band = (lowerExclusive: string | null, upperInclusive: string | null) => ({ lowerExclusive, upperInclusive });
    const tableId = await create(setId, 'BAND_TABLE', {
      code: 'CPO-3', name: 'CPO bands', refSeriesId: ids.cpoSeries, bands: [band(null, '680'), band('690', '1000'), band('950', '1100')],
    });
    let findings = await submitFindings(setId);
    const message = findings.find((f) => f.ruleCode === 'BR-TRF-02')!.message;
    expect(message).toContain('gap between 680 and 690');
    expect(message).toContain('bands 2 and 3 overlap');
    expect(message).toContain('instead of having no ceiling');

    // Upper edge below lower edge is refused on save.
    await put(setId, { entityType: 'BAND_TABLE', operation: 'CREATE', after: { code: 'BAD', name: 'Bad', refSeriesId: ids.cpoSeries, bands: [band('700', '600')] } }, 400);

    const set = await put(setId, {
      itemId: (await h.pool.query('SELECT id FROM ecr.change_item WHERE entity_id = $1', [tableId])).rows[0].id, entityType: 'BAND_TABLE', operation: 'CREATE',
      after: { code: 'CPO-3', name: 'CPO bands', refSeriesId: ids.cpoSeries, bands: [band(null, '680'), band('680', '1000'), band('1000', null)] },
    });
    expect(set.items[0].after.bands.map((b: { label: string }) => b.label)).toEqual(['≤ 680', '680–1000', '> 1000']);
    await publish(setId);
    ids.bands = tableId;
  });

  it('selects bands with an exclusive lower and inclusive upper edge (BR-CAL-02)', () => {
    const table = {
      code: 'T', name: 'T', refSeriesId: null, validFrom: null, validTo: null,
      bands: [{ lowerExclusive: null, upperInclusive: '680', label: '' }, { lowerExclusive: '680', upperInclusive: '1000', label: '' }, { lowerExclusive: '1000', upperInclusive: null, label: '' }],
    };
    expect(['0', '680', '680.01', '1000', '1000.0001', '99999'].map((p) => selectBand(table, p))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  // ------------------------------------------------------------------ schedules and charges

  it('computes duty from the CPO price band and levy as a % of it, with impact preview (US-25-P1, US-26-P1)', async () => {
    const setId = await newSet('PMK 38/2024 annexes');
    ids.bk = await create(setId, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'BK', annexLabel: 'Lampiran I', commodityId: ids.palm });
    ids.pe = await create(setId, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'PE', annexLabel: 'Lampiran', commodityId: ids.palm });
    ids.bkLine = await create(setId, 'SCHEDULE_LINE', {
      scheduleId: ids.bk, kelompok: 'I', itemNo: '1', uraian: 'Crude Palm Oil (CPO)', basisType: 'BAND_USD_PER_MT',
      bandTableId: ids.bands, refSeriesId: ids.cpoSeries, bandValues: ['0', '33', '74'], productIds: [ids.cpo], validFrom: '2024-05-24',
    });
    ids.peLine = await create(setId, 'SCHEDULE_LINE', {
      scheduleId: ids.pe, itemNo: '1', uraian: 'Crude Palm Oil', basisType: 'PCT_OF_REF_PRICE', pct: 10, refSeriesId: ids.cpoSeries,
      productIds: [ids.cpo], validFrom: '2024-05-24',
    });
    // BR-CAL-06: listed at zero is different from not listed.
    await create(setId, 'SCHEDULE_LINE', {
      scheduleId: ids.pe, itemNo: '9', uraian: 'RBD Palm Olein', basisType: 'ZERO_LISTED', productIds: [ids.olein], validFrom: '2024-05-24',
    });

    const impact = (await checker.agent.get(`/api/change-sets/${setId}/impact`).expect(200)).body;
    const row = impact.rows.find((r: { productId: string }) => r.productId === ids.cpo);
    expect(row).toMatchObject({
      changed: true,
      bk: { before: { status: 'NOT_LISTED' }, after: { status: 'CHARGED', usdPerMt: '33', band: { ordinal: 2, label: '680–1000' } } },
      pe: { before: { status: 'NOT_LISTED' }, after: { status: 'CHARGED', usdPerMt: '95', rate: '10' } },
    });
    await publish(setId);

    const cpo = await charges(ids.cpo);
    expect(cpo.bk).toMatchObject({
      status: 'CHARGED', usdPerMt: '33', basisType: 'BAND_USD_PER_MT',
      referencePrice: { seriesCode: 'CPO', value: '950', sourceDocumentId: ids.decree },
      line: { regulation: 'PMK 38/2024', annexLabel: 'Lampiran I', kelompok: 'I', uraian: 'Crude Palm Oil (CPO)' },
    });
    expect(cpo.pe).toMatchObject({ status: 'CHARGED', usdPerMt: '95' });
    // Next month the price is 1300, so the top band applies.
    expect((await charges(ids.cpo, nextMonthStart)).bk).toMatchObject({ usdPerMt: '74', band: { ordinal: 3 } });
    // BR-CAL-03: no published price for the date blocks the result instead of guessing.
    expect((await charges(ids.cpo, '2035-01-15')).pe).toMatchObject({ status: 'MISSING_VALUE', usdPerMt: null });

    const olein = await charges(ids.olein);
    expect(olein.bk).toMatchObject({ status: 'NOT_LISTED' });
    expect(olein.pe).toMatchObject({ status: 'LISTED_ZERO', usdPerMt: '0' });

    const schedules = (await viewer.agent.get('/api/schedules').expect(200)).body;
    expect(schedules.map((s: { chargeType: string; lineCount: number }) => `${s.chargeType}:${s.lineCount}`).sort()).toEqual(['BK:1', 'PE:2']);
    const bk = (await viewer.agent.get(`/api/schedules/${ids.bk}`).expect(200)).body;
    expect(bk.lines[0]).toMatchObject({ bandValues: ['0', '33', '74'], bandTable: { code: 'CPO-3' }, products: [{ nameId: 'Minyak Sawit Mentah (CPO)' }] });
  });

  it('blocks invalid duty and levy lines (US-25-N1, US-25-N2, US-26-N1)', async () => {
    const setId = await newSet('Invalid lines');
    const line = (extra: object) => ({
      scheduleId: ids.bk, uraian: 'Test line', basisType: 'BAND_USD_PER_MT', bandTableId: ids.bands, refSeriesId: ids.cpoSeries,
      bandValues: ['0', '10', '20'], productIds: [ids.kernel], validFrom: '2024-05-24', ...extra,
    });
    // On save: negative amounts, % outside (0, 100], missing reference series.
    const negative = await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType: 'SCHEDULE_LINE', operation: 'CREATE', after: line({ bandValues: ['0', '-1', '5'] }) }).expect(400);
    expect(negative.body.error.details.fields).toEqual([expect.objectContaining({ field: 'bandValues[1]', message: 'Must be at least 0.' })]);
    await put(setId, { entityType: 'SCHEDULE_LINE', operation: 'CREATE', after: line({ scheduleId: ids.pe, basisType: 'PCT_OF_REF_PRICE', pct: 101 }) }, 400);
    await put(setId, { entityType: 'SCHEDULE_LINE', operation: 'CREATE', after: line({ scheduleId: ids.pe, basisType: 'PCT_OF_REF_PRICE', pct: 0 }) }, 400);
    await put(setId, { entityType: 'SCHEDULE_LINE', operation: 'CREATE', after: line({ scheduleId: ids.pe, basisType: 'PCT_OF_REF_PRICE', pct: 5, refSeriesId: null }) }, 400);

    // On submit: wrong band count, falling amounts, second BK line for CPO, a BK basis in a levy schedule,
    // a band line priced on the FX series, and a line without products.
    await create(setId, 'SCHEDULE_LINE', line({ bandValues: ['0', '10'] }));
    await create(setId, 'SCHEDULE_LINE', line({ uraian: 'Falling', bandValues: ['30', '20', '10'], productIds: [] }));
    await create(setId, 'SCHEDULE_LINE', line({ uraian: 'CPO again', productIds: [ids.cpo] }));
    await create(setId, 'SCHEDULE_LINE', line({ uraian: 'Wrong basis', scheduleId: ids.pe, productIds: [] }));
    await create(setId, 'SCHEDULE_LINE', line({ uraian: 'FX priced', refSeriesId: ids.fx, productIds: [] }));
    const findings = await submitFindings(setId);
    const has = (rule: string, severity: string, text: string) =>
      expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleCode: rule, severity, message: expect.stringContaining(text) })]));
    has('DQ-06', 'ERROR', '2 amounts for 3 bands');
    has('DQ-06', 'WARNING', 'decrease');
    has('BR-TRF-01', 'ERROR', 'Minyak Sawit Mentah (CPO) already has an active BK line');
    has('BASIS', 'ERROR', 'BAND_USD_PER_MT is not a PE basis');
    has('BR-TRF-04', 'ERROR', 'FX-USDIDR is not a reference-price series');
    has('DQ-08', 'WARNING', 'not linked to any product');
    await send(maker, 'post', `/api/change-sets/${setId}/discard`).expect(200);
  });

  it('previews and publishes a levy rate change and a price change (US-29-P2 AC1)', async () => {
    const setId = await newSet('Levy 3 % and revised CPO price');
    // The published read shapes carry the editable fields; extra display fields are ignored on save.
    const peLine = (await viewer.agent.get(`/api/schedules/${ids.pe}`).expect(200)).body.lines.find((l: { entityId: string }) => l.entityId === ids.peLine);
    await put(setId, { entityType: 'SCHEDULE_LINE', operation: 'UPDATE', entityId: ids.peLine, after: { ...peLine, pct: '3' } });
    const value = (await viewer.agent.get(`/api/ref-series/${ids.cpoSeries}`).expect(200)).body.values.find((v: { entityId: string }) => v.entityId === ids.cpoValue);
    await put(setId, { entityType: 'REF_VALUE', operation: 'UPDATE', entityId: ids.cpoValue, after: { ...value, value: '1100.1' } });

    const set = (await checker.agent.get(`/api/change-sets/${setId}`).expect(200)).body;
    expect(set.items[0].changes).toEqual([{ field: 'pct', before: '10', after: '3' }]);
    expect(set.references[ids.cpoSeries]).toBe('CPO');

    const row = (await checker.agent.get(`/api/change-sets/${setId}/impact`).expect(200)).body.rows.find((r: { productId: string }) => r.productId === ids.cpo);
    // Exact decimals: 3 % × 1100.1 = 33.003 (binary floating point would give 33.00299999999999).
    expect(row.pe).toMatchObject({ before: { usdPerMt: '95' }, after: { usdPerMt: '33.003' } });
    expect(row.bk).toMatchObject({ before: { usdPerMt: '33' }, after: { usdPerMt: '74', band: { label: '> 1000' } } });

    await publish(setId);
    expect((await charges(ids.cpo)).pe.usdPerMt).toBe('33.003');
  });

  it('applies ad-valorem duty to Harga Ekspor, falling back to the previous period (BR-CAL-03, BR-CAL-04)', async () => {
    const setId = await newSet('Kernel ad valorem');
    // A Harga Ekspor series belongs to a product.
    await put(setId, { entityType: 'REF_SERIES', operation: 'CREATE', after: { code: 'HE-KERNEL', name: 'HE inti sawit', kind: 'HARGA_EKSPOR', unit: 'USD/MT', cadence: 'MONTHLY' } }, 400);
    await create(setId, 'SCHEDULE_LINE', {
      scheduleId: ids.bk, kelompok: 'II', itemNo: '3', uraian: 'Inti sawit', basisType: 'AD_VALOREM_PCT', pct: '5', productIds: [ids.kernel], validFrom: '2024-05-24',
    });
    expect(await submitFindings(setId)).toEqual(expect.arrayContaining([expect.objectContaining({ ruleCode: 'BR-CAL-04', message: expect.stringContaining('Inti Sawit has no Harga Ekspor series') })]));

    const heDoc = (await upload('https://jdih.kemenkeu.go.id/dok/kepdirjen-bc-harga-ekspor', { docKind: 'HE_DECISION', title: 'MK/BC Harga Ekspor' }).expect(201)).body;
    const series = await create(setId, 'REF_SERIES', { code: 'HE-KERNEL', name: 'HE inti sawit', kind: 'HARGA_EKSPOR', unit: 'USD/MT', cadence: 'MONTHLY', productId: ids.kernel });
    // Only last month's decision is published so far.
    await create(setId, 'REF_VALUE', { seriesId: series, periodFrom: lastMonthStart, periodTo: lastMonthEnd, value: '800', sourceDocumentId: heDoc.id });
    await publish(setId);

    const kernel = await charges(ids.kernel);
    expect(kernel.bk).toMatchObject({
      status: 'CHARGED', usdPerMt: '40', rate: '5',
      hargaEkspor: { seriesCode: 'HE-KERNEL', value: '800', periodFrom: lastMonthStart, fallback: true },
    });
  });
});
