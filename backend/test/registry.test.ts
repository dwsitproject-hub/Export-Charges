import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wibToday, addDays } from '../src/common/fields';
import { ChangeSetsService } from '../src/registry/change-sets.service';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const JDIH = 'https://jdih.kemenkeu.go.id/dok/pmk-69-tahun-2025';

/** A small, unique, real-looking PDF (unique so the SHA-256 de-duplication does not merge test files). */
function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj <<>> endobj\n% ${randomBytes(16).toString('hex')}\ntrailer <<>>\n%%EOF\n`);
}

describe('regulation register, product master and maker-checker change sets', () => {
  let h: Harness;
  let maker: Person;
  let maker2: Person;
  let checker: Person;
  let checker2: Person;
  let makerChecker: Person;
  let viewer: { agent: Agent; me: Me };
  let seq = 0;

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put' | 'delete', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);

  function upload(p: Person, fields: Record<string, string> = {}, file: Buffer = pdf()) {
    const req = p.agent.post('/api/source-documents').set('X-CSRF-Token', p.me.csrfToken);
    const all = { docKind: 'REGULATION', title: 'Salinan resmi', officialUrl: JDIH, ...fields };
    for (const [k, v] of Object.entries(all)) req.field(k, v);
    return req.attach('file', file, { filename: 'document.pdf', contentType: 'application/pdf' });
  }

  async function newSet(p: Person, title = 'Test change set'): Promise<string> {
    const res = await send(p, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201);
    return res.body.id as string;
  }

  function put(p: Person, setId: string, item: object) {
    return send(p, 'put', `/api/change-sets/${setId}/items`, item);
  }

  /** Next regulation number, so tests never collide on BR-REG-01. */
  function regulation(docId: string, extra: object = {}) {
    seq += 1;
    return {
      regType: 'PMK', number: String(100 + seq), year: 2025, titleId: `Peraturan uji ${seq}`, issuer: 'Kementerian Keuangan',
      status: 'IN_FORCE', promulgatedOn: '2025-10-01', effectiveOn: '2025-10-01', officialUrl: JDIH,
      documents: [{ sourceDocumentId: docId, role: 'MAIN' }],
      ...extra,
    };
  }

  /** Submit (acknowledging warnings), take into review by `by`, approve; returns the final change set. */
  async function publish(setId: string, by: Person = checker, effectiveDate?: string) {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(by, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    return (await send(by, 'post', `/api/change-sets/${setId}/approve`, effectiveDate ? { effectiveDate } : {}).expect(200)).body;
  }

  /** A published regulation, commodity and group, ready for product tests. */
  async function baseData() {
    const doc = (await upload(maker).expect(201)).body;
    const setId = await newSet(maker, 'Palm classification');
    const reg = (await put(maker, setId, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id) }).expect(200)).body.items[0];
    const code = `PALM${++seq}`;
    const com = (await put(maker, setId, { entityType: 'COMMODITY', operation: 'CREATE', after: { code, nameId: 'Kelapa sawit', nameEn: 'Palm oil' } }).expect(200))
      .body.items[1];
    const grp = (await put(maker, setId, {
      entityType: 'PRODUCT_GROUP', operation: 'CREATE', after: { commodityId: com.entityId, code: 'I', label: 'Group I', ordinal: 1 },
    }).expect(200)).body.items[2];
    await publish(setId);
    return { regulationId: reg.entityId as string, commodityId: com.entityId as string, groupId: grp.entityId as string };
  }

  function product(base: { regulationId: string; groupId: string }, extra: object = {}) {
    return {
      groupId: base.groupId, itemNoAsPrinted: '1', nameId: 'Minyak Sawit Mentah', nameEn: 'Crude Palm Oil (CPO)',
      definition: 'Minyak nabati hasil ekstraksi daging buah kelapa sawit', classificationRegulationId: base.regulationId,
      validFrom: '2025-10-01', parameters: [{ name: 'ALB', operator: '≤', valueText: '5', valueMax: 5, unit: '%', isPrimary: true }],
      hsCodes: [{ code: '1511.10.00' }],
      ...extra,
    };
  }

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    maker2 = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    checker2 = await h.privileged(['CHECKER']);
    makerChecker = await h.privileged(['MAKER', 'CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ happy path

  it('registers a regulation with its official PDF and publishes it through maker-checker (US-20-P1, US-21-P1, US-29-P2)', async () => {
    const file = pdf();
    const doc = (await upload(maker, { docNumber: '69 TAHUN 2025', docDate: '2025-10-01' }, file).expect(201)).body;
    expect(doc).toMatchObject({ isSecondary: false, publisherDomain: 'jdih.kemenkeu.go.id', scanResult: 'NOT_SCANNED', reused: false });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);

    const setId = await newSet(maker, 'PMK levy amendment');
    const saved = await put(maker, setId, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id, { number: '69', titleEn: 'Export levy' }) })
      .expect(200);
    const regId = saved.body.items[0].entityId as string;
    expect(saved.body.items[0]).toMatchObject({ operation: 'CREATE', label: 'PMK 69/2025' });

    // US-20-N2: drafts are invisible to Viewers, through every read.
    expect((await viewer.agent.get('/api/regulations').expect(200)).body).toEqual([]);
    await viewer.agent.get(`/api/regulations/${regId}`).expect(404);
    await viewer.agent.get(`/api/source-documents/${doc.id}`).expect(404);
    await viewer.agent.get('/api/change-sets').expect(403);

    const submitted = (await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(200)).body;
    expect(submitted.status).toBe('SUBMITTED');
    expect((await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200)).body.status).toBe('IN_REVIEW');
    const approved = (await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200)).body;
    expect(approved).toMatchObject({ status: 'PUBLISHED', reviewedBy: { id: checker.me.user.id } });
    expect(approved.versionNo).toBeGreaterThan(0);

    const list = (await viewer.agent.get('/api/regulations').expect(200)).body;
    expect(list.map((r: { label: string }) => r.label)).toContain('PMK 69/2025');
    const detail = (await viewer.agent.get(`/api/regulations/${regId}`).expect(200)).body;
    expect(detail.documents[0]).toMatchObject({ sha256: doc.sha256, role: 'MAIN', publisherName: 'JDIH Kementerian Keuangan' });
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({ versionFrom: approved.versionNo, versionTo: null, approvedBy: expect.any(String) });

    const download = await viewer.agent.get(`/api/source-documents/${doc.id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(download.body as Buffer, file)).toBe(0);

    expect(await h.auditActions(setId)).toEqual(expect.arrayContaining([
      'CHANGESET_CREATED', 'CHANGE_ITEM_SAVED', 'CHANGESET_SUBMITTED', 'CHANGESET_REVIEW_STARTED', 'CHANGESET_APPROVED', 'CHANGESET_PUBLISHED',
    ]));
  });

  // ------------------------------------------------------------------ source documents

  it('rejects unsafe, oversized or unofficial source files (US-21-N1, US-31-N1 AC2)', async () => {
    const notPdf = await upload(maker, {}, Buffer.from('<html>not a pdf</html>')).expect(422);
    expect(notPdf.body.error.code).toBe('FILE_REJECTED');

    const news = 'https://news.ddtc.co.id/berita/pungutan-ekspor-cpo';
    expect((await upload(maker, { officialUrl: news }).expect(422)).body.error.code).toBe('SOURCE_NOT_OFFICIAL');
    expect((await upload(maker, { officialUrl: '' }).expect(422)).body.error.code).toBe('SOURCE_NOT_OFFICIAL');
    const secondary = (await upload(maker, { officialUrl: news, isSecondary: 'true', docKind: 'OTHER' }).expect(201)).body;
    expect(secondary).toMatchObject({ isSecondary: true });

    const same = pdf();
    const first = (await upload(maker, {}, same).expect(201)).body;
    const again = (await upload(maker, {}, same).expect(201)).body;
    expect(again).toMatchObject({ id: first.id, reused: true });

    const huge = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(25 * 1024 * 1024)]);
    expect((await upload(maker, {}, huge).expect(413)).body.error.code).toBe('FILE_TOO_LARGE');

    // Viewers read published documents only and cannot upload.
    await viewer.agent.post('/api/source-documents').set('X-CSRF-Token', viewer.me.csrfToken).field('title', 'x').expect(403);
    expect(await h.auditActions(maker.me.user.id)).toContain('SOURCE_DOCUMENT_REJECTED');

    // Evidence is immutable in the database too.
    await expect(h.pool.query(`UPDATE ecr.source_document SET title = 'changed' WHERE id = $1`, [first.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query('DELETE FROM ecr.source_document WHERE id = $1', [first.id])).rejects.toThrow(/cannot be deleted/);
  });

  // ------------------------------------------------------------------ regulation rules

  it('blocks inconsistent regulation records (US-20-N1, BR-SRC-01)', async () => {
    const doc = (await upload(maker).expect(201)).body;
    const setA = await newSet(maker);
    const a = (await put(maker, setA, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id) }).expect(200)).body.items[0];
    await publish(setA);

    const setB = await newSet(maker);
    // AC1: (type, number, year) already registered.
    const dup = await put(maker, setB, { entityType: 'REGULATION', operation: 'CREATE', after: { ...regulation(doc.id), number: a.after.number } }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'REGULATION_EXISTS', details: { entityId: a.entityId } });
    // AC2: end before effective is blocked; a non-official page is refused.
    const dates = await put(maker, setB, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id, { endsOn: '2025-01-01' }) }).expect(400);
    expect(dates.body.error.details.fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'endsOn' })]));
    await put(maker, setB, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id, { officialUrl: 'https://example.com/pmk' }) }).expect(400);

    // AC3: B amends A while A is changed to amend B → circular chain, blocked on submit.
    const b = (await put(maker, setB, {
      entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id, { relations: [{ relation: 'AMENDS', regulationId: a.entityId }] }),
    }).expect(200)).body.items[0];
    await put(maker, setB, {
      entityType: 'REGULATION', operation: 'UPDATE', entityId: a.entityId, after: { ...a.after, relations: [{ relation: 'AMENDS', regulationId: b.entityId }] },
    }).expect(200);
    // BR-SRC-01: a regulation without an official document cannot be submitted.
    await put(maker, setB, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id, { documents: [] }) }).expect(200);
    const refused = await send(maker, 'post', `/api/change-sets/${setB}/submit`, { acknowledgeWarnings: true }).expect(422);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    const rules = refused.body.error.details.findings.filter((f: { severity: string }) => f.severity === 'ERROR').map((f: { ruleCode: string }) => f.ruleCode);
    expect(rules).toEqual(expect.arrayContaining(['BR-REG-02', 'BR-SRC-01']));
    // Findings stay with the set for the Maker to work through.
    expect((await maker.agent.get(`/api/change-sets/${setB}`).expect(200)).body).toMatchObject({ status: 'DRAFT', findings: expect.any(Array) });
  });

  // ------------------------------------------------------------------ product master

  it('validates products and HS codes, and computes shared tariff posts (US-23, US-24)', async () => {
    const base = await baseData();
    const setId = await newSet(maker, 'CPO products');

    // US-24-P1 AC1: spaces or dots are normalised; US-24-N1: free text, unknown codes and duplicates are refused.
    const saved = await put(maker, setId, { entityType: 'PRODUCT', operation: 'CREATE', after: product(base, { hsCodes: [{ code: '1511 10 00' }] }) }).expect(200);
    const cpo = saved.body.items[0];
    expect(cpo.after.hsCodes).toEqual([expect.objectContaining({ code: '1511.10.00', isEx: false })]);
    const bad = await put(maker, setId, {
      entityType: 'PRODUCT', operation: 'CREATE',
      after: product(base, { hsCodes: [{ code: 'ex 4407 (all subheadings)' }, { code: '9999.99.99' }, { code: '15111000' }, { code: '1511.10.00' }, { code: '1511.90.36', isEx: true }] }),
    }).expect(400);
    const messages = bad.body.error.details.fields.map((f: { message: string }) => f.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Enter explicit 8-digit HS codes.', '9999.99.99 is not in the current BTKI version.', 'This HS code is already listed.',
      'An ex-code needs the qualifying description.',
    ]));

    // US-23-N1 AC1: missing classification, validity and HS code block submission with the list.
    const incomplete = (await put(maker, setId, {
      entityType: 'PRODUCT', operation: 'CREATE',
      after: { groupId: base.groupId, nameId: 'Produk belum lengkap', hsCodes: [] },
    }).expect(200)).body.items[1];
    let refused = await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(422);
    expect(refused.body.error.details.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: 'DQ-01', severity: 'ERROR', message: expect.stringContaining('classification regulation, validity start, HS code') }),
    ]));
    await send(maker, 'delete', `/api/change-sets/${setId}/items/${incomplete.id}`).expect(200);

    // US-23-N1 AC2: a product without definition is a warning that must be acknowledged.
    await put(maker, setId, {
      entityType: 'PRODUCT', operation: 'CREATE',
      after: product(base, { itemNoAsPrinted: '1', nameId: 'Minyak Daging Buah Kelapa Sawit (PMO)', definition: null }),
    }).expect(200);
    refused = await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(422);
    expect(refused.body.error.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    const findings = refused.body.error.details.findings as { ruleCode: string; severity: string }[];
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: 'DQ-05', severity: 'WARNING' }),
      expect.objectContaining({ ruleCode: 'DQ-04', severity: 'INFO' }), // US-23-P2: duplicate item no. allowed, flagged
      expect.objectContaining({ ruleCode: 'BR-PRD-04', severity: 'INFO' }),
    ]));
    await publish(setId);

    const detail = (await viewer.agent.get(`/api/products/${cpo.entityId}`).expect(200)).body;
    expect(detail.hsCodes[0].sharedWith).toEqual([expect.objectContaining({ nameId: 'Minyak Daging Buah Kelapa Sawit (PMO)' })]);
    expect(detail.classificationRegulation.label).toMatch(/^PMK \d+\/2025$/);
    const list = (await viewer.agent.get('/api/products?q=15111000').expect(200)).body;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: cpo.entityId, sharedHs: true, keySpec: 'ALB ≤ 5 %' })]));
    expect((await viewer.agent.get('/api/hs-codes?q=1511.90').expect(200)).body.length).toBeGreaterThan(3);
  });

  it('allows one open edit per record and only the owner edits a set (US-23-N2)', async () => {
    const base = await baseData();
    const setId = await newSet(maker);
    const p = (await put(maker, setId, { entityType: 'PRODUCT', operation: 'CREATE', after: product(base) }).expect(200)).body.items[0];
    await publish(setId);

    const mine = await newSet(maker, 'Rename CPO');
    await put(maker, mine, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: { ...p.after, nameEn: 'CPO' } }).expect(200);
    const theirs = await newSet(maker2, 'Also rename CPO');
    const locked = await put(maker2, theirs, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: p.after }).expect(409);
    expect(locked.body.error).toMatchObject({ code: 'ENTITY_LOCKED', details: { changeSetId: mine } });
    expect(locked.body.error.message).toContain('Rename CPO');

    // Only the owner edits, submits or discards.
    expect((await put(maker2, mine, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: p.after }).expect(403)).body.error.code).toBe('NOT_OWNER');
    await send(maker2, 'post', `/api/change-sets/${mine}/submit`).expect(403);

    // Discarding releases the record; nothing is deleted.
    expect((await send(maker, 'post', `/api/change-sets/${mine}/discard`).expect(200)).body.status).toBe('CANCELLED');
    await put(maker2, theirs, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: p.after }).expect(200);
    await send(maker2, 'post', `/api/change-sets/${theirs}/discard`).expect(200);
  });

  // ------------------------------------------------------------------ four-eyes

  it('enforces four-eyes review and step-up for Checker decisions (US-29-N1, SoD-1)', async () => {
    const doc = (await upload(makerChecker).expect(201)).body;
    const own = await newSet(makerChecker);
    await put(makerChecker, own, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id) }).expect(200);
    await send(makerChecker, 'post', `/api/change-sets/${own}/submit`).expect(200);

    const sod = await send(makerChecker, 'post', `/api/change-sets/${own}/start-review`).expect(403);
    expect(sod.body.error.code).toBe('SOD_VIOLATION');
    expect(await h.auditActions(own)).toContain('SOD_DENIED');
    await send(maker, 'post', `/api/change-sets/${own}/start-review`).expect(403); // Makers lack changeset.approve

    await send(checker2, 'post', `/api/change-sets/${own}/start-review`).expect(200);
    await h.expireStepUp(checker2.me.session.id);
    const stepUp = await send(checker2, 'post', `/api/change-sets/${own}/approve`).expect(403);
    expect(stepUp.body.error.code).toBe('STEP_UP_REQUIRED');
    // The creator still cannot approve once another Checker started the review.
    expect((await send(makerChecker, 'post', `/api/change-sets/${own}/approve`).expect(403)).body.error.code).toBe('SOD_VIOLATION');

    await send(checker2, 'post', '/api/auth/step-up', { code: h.nextCode(checker2.secret) }).expect(200);
    expect((await send(checker2, 'post', `/api/change-sets/${own}/approve`).expect(200)).body.status).toBe('PUBLISHED');
  });

  it('rejects with a comment, then the Maker reworks and resubmits (US-29-N2)', async () => {
    const doc = (await upload(maker).expect(201)).body;
    const setId = await newSet(maker);
    const item = (await put(maker, setId, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id) }).expect(200)).body.items[0];
    await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(200);
    // Withdraw before review, then resubmit (US-29-P1 AC2).
    expect((await send(maker, 'post', `/api/change-sets/${setId}/withdraw`).expect(200)).body.status).toBe('DRAFT');
    await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);

    await send(checker, 'post', `/api/change-sets/${setId}/reject`, { comment: '' }).expect(400);
    const rejected = (await send(checker, 'post', `/api/change-sets/${setId}/reject`, {
      comment: 'Title does not match the gazette', itemComments: { [item.id]: 'Use the title as printed' },
    }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionComment: 'Title does not match the gazette' });
    expect(rejected.items[0].itemComment).toBe('Use the title as printed');

    const reworked = (await put(maker, setId, { entityType: 'REGULATION', operation: 'CREATE', itemId: item.id, after: { ...item.after, titleId: 'Judul sesuai salinan' } })
      .expect(200)).body;
    expect(reworked).toMatchObject({ status: 'DRAFT', items: [expect.objectContaining({ entityId: item.entityId, itemComment: null })] });
    expect((await send(maker, 'post', `/api/change-sets/${setId}/submit`).expect(200)).body.status).toBe('SUBMITTED');
  });

  // ------------------------------------------------------------------ scheduling

  it('schedules future-dated changes, can cancel them, and publishes them when due (US-29-P2 AC2, US-29-N3)', async () => {
    const doc = (await upload(maker).expect(201)).body;
    const setId = await newSet(maker);
    const item = (await put(maker, setId, { entityType: 'REGULATION', operation: 'CREATE', after: regulation(doc.id) }).expect(200)).body.items[0];
    const future = addDays(wibToday(), 10);

    expect((await publish(setId, checker, future)).status).toBe('SCHEDULED');
    await viewer.agent.get(`/api/regulations/${item.entityId}`).expect(404);

    await send(checker, 'post', `/api/change-sets/${setId}/cancel-schedule`, {}).expect(400);
    expect((await send(checker, 'post', `/api/change-sets/${setId}/cancel-schedule`, { reason: 'Regulation postponed' }).expect(200)).body.status).toBe('DRAFT');

    expect((await publish(setId, checker2, future)).status).toBe('SCHEDULED');
    const scheduler = h.app.get(ChangeSetsService);
    expect((await scheduler.publishDue(new Date())).published).not.toContain(setId);
    const run = await scheduler.publishDue(new Date(Date.now() + 11 * 86_400_000));
    expect(run.published).toContain(setId);
    expect((await maker.agent.get(`/api/change-sets/${setId}`).expect(200)).body.status).toBe('PUBLISHED');
    await viewer.agent.get(`/api/regulations/${item.entityId}`).expect(200);
  });

  it('leaves a scheduled set unpublished when it no longer validates at its effective date', async () => {
    const doc = (await upload(maker).expect(201)).body;
    const after = regulation(doc.id);
    const scheduled = await newSet(maker);
    await put(maker, scheduled, { entityType: 'REGULATION', operation: 'CREATE', after }).expect(200);
    await publish(scheduled, checker, addDays(wibToday(), 5));

    // Another set registers the same regulation first.
    const other = await newSet(maker);
    await put(maker, other, { entityType: 'REGULATION', operation: 'CREATE', after }).expect(200);
    await publish(other);

    const run = await h.app.get(ChangeSetsService).publishDue(new Date(Date.now() + 6 * 86_400_000));
    expect(run.failed).toContain(scheduled);
    expect((await maker.agent.get(`/api/change-sets/${scheduled}`).expect(200)).body.status).toBe('SCHEDULED');
    expect(await h.auditActions(scheduled)).toContain('CHANGESET_PUBLISH_FAILED');
  });

  // ------------------------------------------------------------------ history and integrity

  it('keeps every published version and refuses to change history (US-30-P1, US-30-N1)', async () => {
    const base = await baseData();
    const setId = await newSet(maker);
    const p = (await put(maker, setId, { entityType: 'PRODUCT', operation: 'CREATE', after: product(base) }).expect(200)).body.items[0];
    await publish(setId);

    const edit = await newSet(maker);
    const updated = (await put(maker, edit, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: { ...p.after, nameEn: 'CPO (renamed)' } })
      .expect(200)).body;
    expect(updated.items[0].changes).toEqual([{ field: 'nameEn', before: 'Crude Palm Oil (CPO)', after: 'CPO (renamed)' }]);
    await publish(edit, checker2);

    const detail = (await viewer.agent.get(`/api/products/${p.entityId}`).expect(200)).body;
    expect(detail.nameEn).toBe('CPO (renamed)');
    expect(detail.history.map((v: { label: string; versionTo: number | null }) => v.versionTo === null)).toEqual([true, false]);
    expect(detail.history[0].approvedBy).toBeTruthy();

    const { rows } = await h.pool.query<{ id: string }>('SELECT id FROM ecr.product WHERE entity_id = $1 AND version_to IS NOT NULL', [p.entityId]);
    await expect(h.pool.query(`UPDATE ecr.product SET name_id = 'tampered' WHERE id = $1`, [rows[0].id])).rejects.toThrow(/history/);
    await expect(h.pool.query('DELETE FROM ecr.product WHERE id = $1', [rows[0].id])).rejects.toThrow(/history/);
    await expect(h.pool.query('DELETE FROM ecr.product_parameter WHERE product_row_id = $1', [rows[0].id])).rejects.toThrow(/history/);
  });

  it('blocks approval of a stale change set (US-29-N4)', async () => {
    const base = await baseData();
    const setId = await newSet(maker);
    const p = (await put(maker, setId, { entityType: 'PRODUCT', operation: 'CREATE', after: product(base) }).expect(200)).body.items[0];
    await publish(setId);

    const edit = await newSet(maker);
    await put(maker, edit, { entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entityId, after: { ...p.after, nameEn: 'Edited' } }).expect(200);
    await send(maker, 'post', `/api/change-sets/${edit}/submit`).expect(200);
    await send(checker, 'post', `/api/change-sets/${edit}/start-review`).expect(200);

    // Simulate another publication of the same record (the per-record lock normally prevents this).
    const { rows: [v] } = await h.pool.query<{ v: number }>('SELECT max(version_no) + 1 AS v FROM ecr.data_version');
    const { rows: [cs] } = await h.pool.query<{ id: string }>(
      `INSERT INTO ecr.change_set (title, justification, created_by, status) VALUES ('Concurrent', 'test', $1, 'PUBLISHED') RETURNING id`,
      [maker2.me.user.id],
    );
    await h.pool.query(`INSERT INTO ecr.data_version (version_no, change_set_id, bulletin) VALUES ($1, $2, '{}')`, [v.v, cs.id]);
    await h.pool.query('UPDATE ecr.product SET version_to = $2 WHERE entity_id = $1 AND version_to IS NULL', [p.entityId, v.v]);

    const stale = await send(checker, 'post', `/api/change-sets/${edit}/approve`).expect(409);
    expect(stale.body.error.code).toBe('STALE_CHANGE_SET');
    expect((await checker.agent.get(`/api/change-sets/${edit}`).expect(200)).body.status).toBe('IN_REVIEW');
  });

  it('refuses to end a group that still has products (US-22-N1)', async () => {
    const base = await baseData();
    const setId = await newSet(maker);
    await put(maker, setId, { entityType: 'PRODUCT', operation: 'CREATE', after: product(base) }).expect(200);
    await publish(setId);

    const end = await newSet(maker);
    await put(maker, end, { entityType: 'PRODUCT_GROUP', operation: 'END_DATE', entityId: base.groupId, validTo: '2026-12-31' }).expect(200);
    const refused = await send(maker, 'post', `/api/change-sets/${end}/submit`).expect(422);
    expect(refused.body.error.details.findings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleCode: 'US-22-N1', severity: 'ERROR' })]));
  });
});
