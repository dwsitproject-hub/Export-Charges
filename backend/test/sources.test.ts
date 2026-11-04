import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const pdf = () => Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);

describe('official source documents for every user (PRD F-21, F-31)', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  async function upload(fields: Record<string, string>) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return (await req.attach('file', pdf(), { filename: `${fields.title}.pdf`, contentType: 'application/pdf' }).expect(201)).body.id as string;
  }
  async function item(setId: string, entityType: string, after: object): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation: 'CREATE', after }).expect(200)).body;
    return set.items[set.items.length - 1].entityId as string;
  }

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    ids.regDoc = await upload({ docKind: 'REGULATION', title: 'PMK 68 Tahun 2025', docDate: '2025-10-10', officialUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-68-tahun-2025' });
    ids.decree = await upload({ docKind: 'REF_PRICE_DECREE', title: 'Kepmendag 2064 Tahun 2026', docNumber: '2064 TAHUN 2026', docDate: '2026-10-29',
      officialUrl: 'https://jdih.kemendag.go.id/peraturan/kepmendag-2064-tahun-2026' });
    ids.draft = await upload({ docKind: 'REF_PRICE_DECREE', title: 'Kepmendag not yet entered', officialUrl: 'https://jdih.kemendag.go.id/peraturan/x' });

    const set = (await send(maker, 'post', '/api/change-sets', { title: 'Sources', justification: 'Test data' }).expect(201)).body.id;
    ids.reg = await item(set, 'REGULATION', { regType: 'PMK', number: '68', year: 2025, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan',
      status: 'IN_FORCE', effectiveOn: '2025-10-22', documents: [{ sourceDocumentId: ids.regDoc, role: 'MAIN' }] });
    ids.series = await item(set, 'REF_SERIES', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    await item(set, 'REF_VALUE', { seriesId: ids.series, periodFrom: '2026-11-01', periodTo: '2026-11-30', value: '978.90', sourceDocumentId: ids.decree });
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/approve`).expect(200);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lists the published documents with what each one is used for', async () => {
    const docs = (await viewer.agent.get('/api/source-documents').expect(200)).body as { id: string; regulations: object[]; values: object[] }[];
    expect(docs.map((d) => d.id)).toEqual([ids.decree, ids.regDoc]);
    expect(docs[0]).toMatchObject({ regulations: [], values: [{ id: ids.series, label: 'CPO 2026-11-01 – 2026-11-30' }] });
    expect(docs[1]).toMatchObject({ regulations: [{ id: ids.reg, label: 'PMK 68/2025' }], values: [] });
    // A document no published record cites yet stays with Makers and Checkers (US-20-N2).
    expect((await maker.agent.get('/api/source-documents').expect(200)).body.map((d: { id: string }) => d.id)).toContain(ids.draft);
    await viewer.agent.get(`/api/source-documents/${ids.draft}/file`).expect(404);
  });

  it('opens a decree in the browser, or downloads it on request', async () => {
    const open = await viewer.agent.get(`/api/source-documents/${ids.decree}/file`).expect(200);
    expect(open.headers['content-type']).toBe('application/pdf');
    expect(open.headers['content-disposition']).toBe(`inline; filename*=UTF-8''Kepmendag%202064%20Tahun%202026.pdf`);
    const save = await viewer.agent.get(`/api/source-documents/${ids.decree}/file?download=1`).expect(200);
    expect(save.headers['content-disposition']).toMatch(/^attachment; /);
  });
});
