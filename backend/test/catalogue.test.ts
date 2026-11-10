import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();
const firstOf = (date: string) => `${date.slice(0, 8)}01`;
const monthStart = firstOf(today);
const lastMonthEnd = addDays(monthStart, -1);
const lastMonthStart = firstOf(lastMonthEnd);

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

describe('charge calculator and catalogue', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  let other: { agent: Agent; me: Me };
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);

  function upload(officialUrl: string, docKind: string) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind, title: `Decree ${docKind}`, officialUrl })) req.field(k, v);
    return req.attach('file', pdf(), { filename: 'decree.pdf', contentType: 'application/pdf' });
  }

  async function newSet(title: string) {
    return (await send(maker, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201)).body.id as string;
  }

  async function create(setId: string, entityType: string, after: object): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation: 'CREATE', after }).expect(200)).body;
    return set.items[set.items.length - 1].entityId as string;
  }

  async function publish(setId: string, effectiveDate?: string) {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    return (await send(checker, 'post', `/api/change-sets/${setId}/approve`, effectiveDate ? { effectiveDate } : {}).expect(200)).body;
  }

  const preview = (body: object, status = 200) => send(viewer, 'post', '/api/calculations/preview', body).expect(status);
  const catalogue = async (query = '') => (await viewer.agent.get(`/api/catalogue?${query}`).expect(200)).body;
  const names = (rows: { nameId: string }[]) => rows.map((r) => r.nameId);

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    other = await h.signedIn(['VIEWER']);

    const regDoc = (await upload('https://jdih.kemenkeu.go.id/dok/pmk-38-2024', 'REGULATION').expect(201)).body;
    const priceDoc = (await upload('https://jdih.kemendag.go.id/peraturan/hr-cpo', 'REF_PRICE_DECREE').expect(201)).body;
    const fxDoc = (await upload('https://fiskal.kemenkeu.go.id/kurs-pajak', 'FX_DECREE').expect(201)).body;
    const heDoc = (await upload('https://jdih.kemenkeu.go.id/dok/kep-bc-harga-ekspor', 'HE_DECISION').expect(201)).body;

    const set = await newSet('Catalogue fixture');
    ids.reg = await create(set, 'REGULATION', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE',
      effectiveOn: '2024-05-24', documents: [{ sourceDocumentId: regDoc.id, role: 'MAIN' }],
    });
    ids.palm = await create(set, 'COMMODITY', { code: 'PALM', nameId: 'Kelapa sawit' });
    ids.g1 = await create(set, 'PRODUCT_GROUP', { commodityId: ids.palm, code: 'I', label: 'Group I', ordinal: 1 });
    ids.g2 = await create(set, 'PRODUCT_GROUP', { commodityId: ids.palm, code: 'II', label: 'Group II', ordinal: 2 });
    const product = (groupId: string, itemNo: string, nameId: string, code: string, extra: object = {}) => ({
      groupId, itemNoAsPrinted: itemNo, nameId, definition: nameId, classificationRegulationId: ids.reg, validFrom: '2024-01-01',
      parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code }], ...extra,
    });
    ids.cpo = await create(set, 'PRODUCT', product(ids.g1, '1', 'Minyak Sawit Mentah', '1511.10.00', { nameEn: 'Crude Palm Oil (CPO)' }));
    ids.olein = await create(set, 'PRODUCT', product(ids.g1, '2', 'Olein Sawit', '1511.90.36', { synonyms: ['RBD olein'] }));
    ids.pfad = await create(set, 'PRODUCT', product(ids.g1, '3', 'Palm Fatty Acid Distillate', '1511.90.36', { synonyms: ['PFAD'] }));
    ids.glycerine = await create(set, 'PRODUCT', product(ids.g2, '1', 'Gliserín Kasar', '1520.00.10', { nameEn: 'Crude glycerine' }));
    ids.kernel = await create(set, 'PRODUCT', product(ids.g2, '2', 'Inti Sawit', '1207.10.30'));
    ids.meal = await create(set, 'PRODUCT', product(ids.g2, '3', 'Bungkil Inti Sawit', '2306.60.90'));

    ids.cpoSeries = await create(set, 'REF_SERIES', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    ids.cpoValue = await create(set, 'REF_VALUE', { seriesId: ids.cpoSeries, periodFrom: monthStart, periodTo: addDays(today, 60), value: '950', sourceDocumentId: priceDoc.id });
    ids.fx = await create(set, 'REF_SERIES', { code: 'FX-USDIDR', name: 'Kurs Menteri Keuangan', kind: 'FX_RATE', unit: 'IDR/USD', cadence: 'WEEKLY' });
    await create(set, 'REF_VALUE', { seriesId: ids.fx, periodFrom: addDays(today, -3), periodTo: addDays(today, 3), value: '16250.5', sourceDocumentId: fxDoc.id });
    const heKernel = await create(set, 'REF_SERIES', { code: 'HE-KERNEL', name: 'HE inti', kind: 'HARGA_EKSPOR', unit: 'USD/MT', cadence: 'MONTHLY', productId: ids.kernel });
    await create(set, 'REF_VALUE', { seriesId: heKernel, periodFrom: lastMonthStart, periodTo: lastMonthEnd, value: '800', sourceDocumentId: heDoc.id });
    await create(set, 'REF_SERIES', { code: 'HE-MEAL', name: 'HE bungkil', kind: 'HARGA_EKSPOR', unit: 'USD/MT', cadence: 'MONTHLY', productId: ids.meal });

    const band = (lowerExclusive: string | null, upperInclusive: string | null) => ({ lowerExclusive, upperInclusive });
    ids.bands = await create(set, 'BAND_TABLE', { code: 'CPO-3', name: 'CPO', refSeriesId: ids.cpoSeries, bands: [band(null, '680'), band('680', '1000'), band('1000', null)] });
    const bk = await create(set, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'BK', annexLabel: 'Lampiran I', commodityId: ids.palm });
    const pe = await create(set, 'SCHEDULE', { regulationId: ids.reg, chargeType: 'PE', annexLabel: 'Lampiran', commodityId: ids.palm });
    const line = (scheduleId: string, uraian: string, productIds: string[], extra: object) =>
      create(set, 'SCHEDULE_LINE', { scheduleId, uraian, productIds, validFrom: '2024-05-24', ...extra });
    await line(bk, 'Crude Palm Oil', [ids.cpo], { basisType: 'BAND_USD_PER_MT', bandTableId: ids.bands, refSeriesId: ids.cpoSeries, bandValues: ['0', '33', '74'] });
    ids.cpoPe = await line(pe, 'Crude Palm Oil', [ids.cpo], { basisType: 'PCT_OF_REF_PRICE', pct: '10', refSeriesId: ids.cpoSeries });
    await line(pe, 'Olein', [ids.olein], { basisType: 'ZERO_LISTED' });
    await line(pe, 'Asam lemak sawit distilat', [ids.pfad], { basisType: 'PCT_OF_REF_PRICE', pct: '5', refSeriesId: ids.cpoSeries });
    await line(bk, 'Inti sawit', [ids.kernel], { basisType: 'AD_VALOREM_PCT', pct: '5' });
    await line(bk, 'Bungkil', [ids.meal], { basisType: 'AD_VALOREM_PCT', pct: '3' });
    ids.v1 = String((await publish(set)).versionNo);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ calculator

  it('calculates duty and levy for a shipment in USD and IDR (US-44-P1, US-44-P3)', async () => {
    const res = (await preview({ lines: [{ productId: ids.cpo, quantityMt: '2.5' }, { productId: ids.olein, quantityMt: 10 }, { productId: ids.glycerine, quantityMt: 1 }] })).body;
    expect(res).toMatchObject({ status: 'COMPLETE', isSimulation: false, pebDate: today, paymentDate: today, versionNo: Number(ids.v1) });
    const [cpo, olein, glycerine] = res.lines;
    expect(cpo.bk).toMatchObject({ status: 'CHARGED', usdPerMt: '33', totalUsd: '82.5', band: { ordinal: 2 }, referencePrice: { value: '950' } });
    expect(cpo.pe).toMatchObject({ status: 'CHARGED', usdPerMt: '95', totalUsd: '237.5' });
    expect(cpo).toMatchObject({ totalUsd: '320', totalIdr: '5200160', fx: { seriesCode: 'FX-USDIDR', value: '16250.5' } });
    // US-44-N2 AC2: not listed is different from listed at 0.
    expect(olein.bk.status).toBe('NOT_LISTED');
    expect(olein.pe).toMatchObject({ status: 'LISTED_ZERO', totalUsd: '0' });
    expect(glycerine.bk.status).toBe('NOT_LISTED');
    expect(res.totals).toEqual({ bkUsd: '82.5', peUsd: '237.5', usd: '320', idr: '5200160' });
    // BR-CAL-07: olein shares its HS code with PFAD, which is charged differently.
    expect(olein.warnings).toEqual([expect.stringContaining('Palm Fatty Acid Distillate (not subject to BK, PE USD 47.5/MT (5 % of CPO))')]);
    expect(res.disclaimer).toContain('Indicative');

    // BR-CAL-05: no intermediate rounding; only the IDR grand total is rounded, half up, to whole rupiah.
    const small = (await preview({ lines: [{ productId: ids.cpo, quantityMt: '0.008' }] })).body;
    expect(small.lines[0]).toMatchObject({ totalUsd: '1.024', totalIdr: '16640.512' });
    expect(small.totals.idr).toBe('16641');
  });

  it('rejects invalid inputs and never shows a total built on missing values (US-44-N1, US-44-N2)', async () => {
    for (const quantityMt of [0, -1, 'abc', 1000001, '1.2345']) {
      const res = await preview({ lines: [{ productId: ids.cpo, quantityMt }] }, 400);
      expect(res.body.error.details.fields[0].field).toBe('lines[0].quantityMt');
    }
    await preview({ lines: Array.from({ length: 51 }, () => ({ productId: ids.cpo, quantityMt: 1 })) }, 400);
    await preview({ lines: [{ productId: '00000000-0000-7000-8000-000000000000', quantityMt: 1 }] }, 400);
    await preview({ lines: [{ productId: ids.cpo, quantityMt: 1 }], pebDate: today, paymentDate: addDays(today, -31) }, 400);

    // No KMK rate for the payment date: USD is known, IDR is not.
    const noFx = (await preview({ lines: [{ productId: ids.cpo, quantityMt: 1 }], paymentDate: addDays(today, 20) })).body;
    expect(noFx).toMatchObject({ status: 'INCOMPLETE', totals: { usd: '128', idr: null } });
    expect(noFx.missing).toEqual([`KMK USD/IDR rate for ${addDays(today, 20)} not yet published.`]);

    // No reference price for the PEB date: no total at all, and the missing value is named.
    const noPrice = (await preview({ lines: [{ productId: ids.cpo, quantityMt: 1 }], pebDate: '2035-01-15' })).body;
    expect(noPrice).toMatchObject({ status: 'INCOMPLETE', totals: { usd: null, idr: null } });
    expect(noPrice.missing).toEqual(expect.arrayContaining(['Value for CPO on 2035-01-15 not yet published.']));
  });

  it('runs what-if prices as labelled simulations and ignores unusable overrides (US-44-P2)', async () => {
    const sim = (await preview({ lines: [{ productId: ids.cpo, quantityMt: 1 }], refPriceOverride: '1100' })).body;
    expect(sim).toMatchObject({ isSimulation: true, refPriceOverride: '1100', totals: { usd: '184' } });
    expect(sim.lines[0].bk).toMatchObject({ usdPerMt: '74', referencePrice: { value: '1100', sourceReference: 'What-if (simulation)' } });

    const ignored = (await preview({ lines: [{ productId: ids.cpo, quantityMt: 1 }], refPriceOverride: '-5' })).body;
    expect(ignored).toMatchObject({ isSimulation: false, totals: { usd: '128' } });
    expect(ignored.notices).toContain('The what-if reference price was not a positive number and was ignored.');
  });

  it('uses the previous Harga Ekspor with a label when the new decision is missing (BR-CAL-03)', async () => {
    const res = (await preview({ lines: [{ productId: ids.kernel, quantityMt: 2 }, { productId: ids.meal, quantityMt: 1 }] })).body;
    expect(res.lines[0].bk).toMatchObject({ usdPerMt: '40', totalUsd: '80', hargaEkspor: { value: '800', fallback: true } });
    expect(res.lines[0].warnings).toEqual([expect.stringContaining('BR-CAL-03')]);
    // No Harga Ekspor at all for the meal: named, no total.
    expect(res.lines[1].bk).toMatchObject({ status: 'MISSING_VALUE', totalUsd: null });
    expect(res).toMatchObject({ status: 'INCOMPLETE', totals: { usd: null } });
  });

  it('saves calculations that replay identically after the data changes (NFR-AUD-01)', async () => {
    const saved = (await send(viewer, 'post', '/api/calculations', { lines: [{ productId: ids.cpo, quantityMt: '3' }] }).expect(201)).body;
    expect(saved).toMatchObject({ status: 'COMPLETE', totals: { usd: '384' }, versionNo: Number(ids.v1) });
    expect(await h.auditActions(saved.id)).toEqual(['CALCULATION_SAVED']);

    // The levy rate changes in a new data version.
    const set = await newSet('Levy 7.5 %');
    const line = (await viewer.agent.get(`/api/schedules`).expect(200)).body.find((s: { chargeType: string }) => s.chargeType === 'PE');
    const peLine = (await viewer.agent.get(`/api/schedules/${line.entityId}`).expect(200)).body.lines.find((l: { entityId: string }) => l.entityId === ids.cpoPe);
    await send(maker, 'put', `/api/change-sets/${set}/items`, { entityType: 'SCHEDULE_LINE', operation: 'UPDATE', entityId: ids.cpoPe, after: { ...peLine, pct: '7.5' } }).expect(200);
    const v2 = (await publish(set)).versionNo;

    expect((await preview({ lines: [{ productId: ids.cpo, quantityMt: '3' }] })).body).toMatchObject({ versionNo: v2, totals: { usd: '312.75' } });
    // US-45-P1: the earlier version can still be asked for.
    expect((await preview({ lines: [{ productId: ids.cpo, quantityMt: '3' }], versionNo: Number(ids.v1) })).body.totals.usd).toBe('384');

    const verify = (await viewer.agent.get(`/api/calculations/${saved.id}/verify`).expect(200)).body;
    expect(verify).toMatchObject({ match: true, inputsIntact: true, versionNo: Number(ids.v1) });
    expect((await viewer.agent.get(`/api/calculations/${saved.id}`).expect(200)).body.totals.usd).toBe('384');
    expect((await viewer.agent.get('/api/calculations').expect(200)).body[0]).toMatchObject({ id: saved.id, products: 'Minyak Sawit Mentah' });

    // Only the author sees it; it never changes.
    await other.agent.get(`/api/calculations/${saved.id}`).expect(404);
    await expect(h.pool.query(`UPDATE ecr.calculation SET total_usd = 1 WHERE id = $1`, [saved.id])).rejects.toThrow(/evidence/);
    // Tampering with the stored result is detected by the replay check.
    await h.pool.query('ALTER TABLE ecr.calculation DISABLE TRIGGER calculation_immutable_trg');
    await h.pool.query(`UPDATE ecr.calculation SET result_hash = sha256('x') WHERE id = $1`, [saved.id]);
    await h.pool.query('ALTER TABLE ecr.calculation ENABLE TRIGGER calculation_immutable_trg');
    expect((await viewer.agent.get(`/api/calculations/${saved.id}/verify`).expect(200)).body.match).toBe(false);
  });

  // ------------------------------------------------------------------ catalogue

  it('lists every product once with tiles that add up (US-40-P1, US-46-P1)', async () => {
    const c = await catalogue();
    expect(names(c.rows)).toEqual(['Minyak Sawit Mentah', 'Olein Sawit', 'Palm Fatty Acid Distillate', 'Gliserín Kasar', 'Inti Sawit', 'Bungkil Inti Sawit']);
    const category = Object.fromEntries(c.rows.map((r: { nameId: string; category: string }) => [r.nameId, r.category]));
    expect(category).toEqual({
      'Minyak Sawit Mentah': 'BOTH', 'Olein Sawit': 'LISTED_ZERO', 'Palm Fatty Acid Distillate': 'PE_ONLY',
      'Gliserín Kasar': 'NOT_LISTED', 'Inti Sawit': 'BK_ONLY', 'Bungkil Inti Sawit': 'BK_ONLY',
    });
    expect(c.kpis).toEqual({ shown: 6, BOTH: 1, BK_ONLY: 2, PE_ONLY: 1, LISTED_ZERO: 1, NOT_LISTED: 1, sharedHs: 2 });
    expect(c.referencePrices.find((p: { code: string }) => p.code === 'CPO')).toMatchObject({ value: { value: '950' }, bands: [{ table: 'CPO-3', ordinal: 2, label: '680–1000' }] });
    // US-40-N1: no misleading number without Harga Ekspor.
    expect(c.rows.find((r: { nameId: string }) => r.nameId === 'Bungkil Inti Sawit')).toMatchObject({ totalUsdPerMt: null, totalNote: 'n/a – needs Harga Ekspor' });

    // US-46-N1: the category tiles sum to the products shown for every filter combination.
    const combos = ['', 'q=sawit', 'sharedHs=true', `group=${ids.g2}`, 'category=BK_ONLY,PE_ONLY', `regulation=${ids.reg}&q=palm`, 'q=zzz'];
    for (const combo of combos) {
      const k = (await catalogue(combo)).kpis;
      expect(k.BOTH + k.BK_ONLY + k.PE_ONLY + k.LISTED_ZERO + k.NOT_LISTED).toBe(k.shown);
    }
  });

  it('searches names, synonyms, uraian and HS codes in any format (US-41)', async () => {
    for (const q of ['gliserin', 'GLYCERINE', '15200010', '1520.00.10', '1520 00 10']) {
      expect(names((await catalogue(`q=${encodeURIComponent(q)}`)).rows)).toEqual(['Gliserín Kasar']);
    }
    expect(names((await catalogue('q=RBD')).rows)).toEqual(['Olein Sawit']);
    expect(names((await catalogue('q=distilat')).rows)).toEqual(['Palm Fatty Acid Distillate']); // schedule uraian
    expect(names((await catalogue('q=1511.90')).rows)).toEqual(['Olein Sawit', 'Palm Fatty Acid Distillate']);

    // US-41-N1: literal text, long input shortened, suggestions for typos.
    expect((await catalogue(`q=${encodeURIComponent('<script>alert(1)</script> OR 1=1')}`)).rows).toEqual([]);
    const long = await catalogue(`q=${'a'.repeat(250)}`);
    expect(long.notices).toContain('The search was shortened to 200 characters.');
    expect((await catalogue('q=glicerine')).suggestion).toBe('glycerine');
    // A phrase with a short misspelt word: each word is corrected (one letter off for short words).
    expect((await catalogue(`q=${encodeURIComponent('crude palm oyl')}`)).suggestion).toBe('crude palm oil');
  });

  it('filters with counts and sorts amounts without mixing units (US-42)', async () => {
    const bkOnly = await catalogue('category=BK_ONLY');
    expect(names(bkOnly.rows)).toEqual(['Inti Sawit', 'Bungkil Inti Sawit']);
    // A facet's counts ignore its own selection.
    expect(bkOnly.facets.category.find((f: { id: string }) => f.id === 'BOTH').count).toBe(1);
    expect(names((await catalogue('sharedHs=true')).rows)).toEqual(['Olein Sawit', 'Palm Fatty Acid Distillate']);
    expect((await catalogue(`group=${ids.g2}&category=NOT_LISTED`)).total).toBe(1);

    // Known USD/MT values sort numerically; rows without a computable amount come after, in both directions.
    expect(names((await catalogue('sort=bk')).rows)).toEqual([
      'Olein Sawit', 'Palm Fatty Acid Distillate', 'Gliserín Kasar', 'Minyak Sawit Mentah', 'Inti Sawit', 'Bungkil Inti Sawit',
    ]);
    expect(names((await catalogue('sort=bk&dir=desc')).rows).slice(0, 2)).toEqual(['Inti Sawit', 'Minyak Sawit Mentah']);
    expect(names((await catalogue('sort=bk&dir=desc')).rows).at(-1)).toBe('Bungkil Inti Sawit');

    const page2 = await catalogue('pageSize=2&page=2');
    expect(page2).toMatchObject({ total: 6, page: 2 });
    expect(names(page2.rows)).toEqual(['Palm Fatty Acid Distillate', 'Gliserín Kasar']);
  });

  it('shows past versions and applies scheduled changes for future dates (US-45)', async () => {
    const cpo = (c: { rows: { nameId: string; pe: { usdPerMt: string } }[] }) => c.rows.find((r) => r.nameId === 'Minyak Sawit Mentah')!.pe.usdPerMt;
    const changeLevy = async (title: string, pct: string, effectiveDate?: string) => {
      const set = await newSet(title);
      const pe = (await viewer.agent.get('/api/schedules').expect(200)).body.find((s: { chargeType: string }) => s.chargeType === 'PE');
      const peLine = (await viewer.agent.get(`/api/schedules/${pe.entityId}`).expect(200)).body.lines.find((l: { entityId: string }) => l.entityId === ids.cpoPe);
      await send(maker, 'put', `/api/change-sets/${set}/items`, { entityType: 'SCHEDULE_LINE', operation: 'UPDATE', entityId: ids.cpoPe, after: { ...peLine, pct } }).expect(200);
      return publish(set, effectiveDate);
    };
    const v2 = (await changeLevy('Levy 7.5 % was v2; now 6 %', '6')).versionNo - 1;

    // Each data version shows exactly what was current in it, including one whose record was replaced later.
    expect(cpo(await catalogue())).toBe('57');
    expect(cpo(await catalogue(`version=${v2}`))).toBe('71.25');
    expect(cpo(await catalogue(`version=${ids.v1}`))).toBe('95');
    expect((await catalogue(`version=${ids.v1}`)).notices[0]).toContain(`Showing data version ${ids.v1}`);

    expect((await changeLevy('Levy 5 % from next week', '5', addDays(today, 7))).status).toBe('SCHEDULED');
    const future = await catalogue(`date=${addDays(today, 10)}`);
    expect(future.scheduledApplied).toEqual([expect.objectContaining({ title: 'Levy 5 % from next week' })]);
    expect(cpo(future)).toBe('47.5');
    expect(cpo(await catalogue(`date=${addDays(today, 3)}`))).toBe('57');
    // A calculation that relies on unpublished scheduled data cannot be saved.
    await send(viewer, 'post', '/api/calculations', { lines: [{ productId: ids.cpo, quantityMt: 1 }], pebDate: addDays(today, 10) }).expect(422);
    expect((await catalogue('date=2020-01-01')).notices).toContain(`No reference prices loaded before ${monthStart}.`);
  });
});
