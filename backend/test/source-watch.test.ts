import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBpkDetails, regKeyOf, SourceWatchService } from '../src/source-watch/source-watch.service';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% ${tag} ${randomBytes(8).toString('hex')}\n%%EOF\n`);

const BPK_69 = 'https://peraturan.bpk.go.id/Details/332100/pmk-no-69-tahun-2025';
const JDIH_69 = 'https://jdih.kemenkeu.go.id/dok/pmk-69-tahun-2025';
const PERMEN_PDF = 'https://www.peraturan.go.id/files/permenperin-no-32-tahun-2024.pdf';

/** A BPK regulation page as the site renders it (fields, then the amendment lists). */
const bpkPage = (status: string, amendedBy: string[]) => `
  <div class="row g-4 g-xl-9 ms-2"><div class="col-lg-3 fw-bold">Status</div><div class="col-lg-9">${status}</div></div>
  <div class="row mb-4"><div class="col-12 fw-semibold bg-light-primary p-4"> Diubah dengan : </div></div>
  <div class="row g-4 g-xl-9 mb-8"><div class="col-lg-12"><ol type="a">
    ${amendedBy.map((s) => `<li class="mb-4"><a class="text-danger" href="/Details/9/${s}">${s.replace(/-/g, ' ').toUpperCase()}</a> <span class="text-muted">tentang</span> Perubahan</li>`).join('')}
  </ol></div></div>
  <div class="row mb-4"><div class="col-12 fw-semibold bg-light-primary p-4"> Mencabut : </div></div>
  <div class="row g-4 g-xl-9 mb-8"><div class="col-lg-12"><ol type="a"><li><a href="/Details/1/pmk-no-30-tahun-2025">PMK No. 30 Tahun 2025</a></li></ol></div></div>`;
/** BPK search results; a regulation keeps its BPK id wherever it appears in the list. */
const bpkId = (slug: string) => parseInt(createHash('sha256').update(slug).digest('hex').slice(0, 6), 16);
const bpkSearch = (slugs: string[]) => slugs.map((s) => `<a href="/Details/${bpkId(s)}/${s}"> Peraturan ${s} &#x2022; Berlaku mulai 1 bulan yang lalu </a>`).join('\n');
const kemendag = (slugs: string[]) => slugs.map((s) => `<a href="https://jdih.kemendag.go.id/peraturan/${s}">${s}</a>`).join('\n');
const jdihFiles = (names: string[]) => names.map((n, i) => `<a href="/api/download/0000000${i}-1111-2222-3333-444444444444/${n}">${n}</a>`).join('\n');

describe('daily source watch (PRD FR-SRC-03 / FR-SRC-04)', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let admin: Person;
  let viewer: { agent: Agent; me: Me };
  let permenFile = pdf('permenperin');
  const pages = new Map<string, string | Buffer>();
  let offline = false;

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const runNow = async () => (await send(admin, 'post', '/api/jobs/source-watch/run').expect(200)).body;
  const items = async (p: { agent: Agent }, status = '') =>
    (await p.agent.get(`/api/source-watch${status ? `?status=${status}` : ''}`).expect(200)).body as {
      items: { id: string; kind: string; title: string; url: string; status: string; resolvedBy: string | null }[];
      lastRun: { status: string } | null;
    };

  async function upload(title: string, officialUrl: string, body: Buffer) {
    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REGULATION', title, officialUrl })) req.field(k, v);
    return (await req.attach('file', body, { filename: 'reg.pdf', contentType: 'application/pdf' }).expect(201)).body.id as string;
  }

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    admin = await h.privileged(['SUPER_ADMIN']);
    viewer = await h.signedIn(['VIEWER']);
    h.app.get(SourceWatchService).fetcher = async (url) => {
      if (offline) throw new Error('getaddrinfo ENOTFOUND');
      const page = pages.get(url.replace(/\?.*$/, (q) => (url.includes('Search') || url.includes('keyword') ? q : '')));
      if (page === undefined) return { status: 404, body: Buffer.alloc(0) };
      return { status: 200, body: Buffer.isBuffer(page) ? page : Buffer.from(page) };
    };

    const docPmk = await upload('PMK 69/2025', JDIH_69, pdf('pmk69'));
    const docPermen = await upload('Permenperin 32/2024', PERMEN_PDF, permenFile);
    const set = (await send(maker, 'post', '/api/change-sets', { title: 'Regulations', justification: 'Test data' }).expect(201)).body.id;
    for (const after of [
      { regType: 'PMK', number: '69', year: 2025, titleId: 'Tarif layanan BPDP', issuer: 'Kementerian Keuangan', status: 'IN_FORCE', effectiveOn: '2025-10-22',
        officialUrl: JDIH_69, bpkStatusUrl: BPK_69, documents: [{ sourceDocumentId: docPmk, role: 'MAIN' }] },
      { regType: 'PERMENPERIN', number: '32', year: 2024, titleId: 'Klasifikasi komoditas turunan kelapa sawit', issuer: 'Kementerian Perindustrian',
        status: 'IN_FORCE', effectiveOn: '2024-07-29', officialUrl: PERMEN_PDF, documents: [{ sourceDocumentId: docPermen, role: 'MAIN' }] },
    ]) await send(maker, 'put', `/api/change-sets/${set}/items`, { entityType: 'REGULATION', operation: 'CREATE', after }).expect(200);
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/approve`).expect(200);

    pages.set(BPK_69, bpkPage('Berlaku', ['pmk-no-9-tahun-2026']));
    pages.set('https://peraturan.bpk.go.id/Search?keywords=bea+keluar&tentang=&nomor=&sort=terbaru', bpkSearch(['pmk-no-68-tahun-2025', 'pmk-no-38-tahun-2024']));
    pages.set('https://peraturan.bpk.go.id/Search?keywords=dana+perkebunan&tentang=&nomor=&sort=terbaru', bpkSearch(['pmk-no-69-tahun-2025']));
    pages.set('https://peraturan.bpk.go.id/Search?keywords=kelapa+sawit&tentang=&nomor=&sort=terbaru', bpkSearch(['permenperin-no-32-tahun-2024']));
    pages.set('https://jdih.kemendag.go.id/peraturan?keyword=harga+referensi',
      kemendag(['keputusan-menteri-perdagangan-republik-indonesia-nomor-1900-tahun-2026-tentang-harga-referensi-crude-palm-oil']));
    pages.set(`${JDIH_69}/files`, jdihFiles(['2025pmkeuangan069.pdf']));
    pages.set(PERMEN_PDF, permenFile);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('reads labels and BPK pages', () => {
    expect(regKeyOf('PMK No. 9 Tahun 2026')).toBe('PMK|9|2026');
    expect(regKeyOf('pmk-no-68-tahun-2025')).toBe('PMK|68|2025');
    expect(regKeyOf('permenperin-no-32-tahun-2024')).toBe('PERMENPERIN|32|2024');
    expect(parseBpkDetails(bpkPage('Berlaku', ['pmk-no-9-tahun-2026']))).toEqual({
      status: 'Berlaku',
      relations: [{ relation: 'AMENDED_BY', label: 'PMK NO 9 TAHUN 2026', url: 'https://peraturan.bpk.go.id/Details/9/pmk-no-9-tahun-2026', regKey: 'PMK|9|2026' }],
    });
  });

  it('reports an amendment not yet in ECR, and takes the listings as they are on the first run', async () => {
    const run = await runNow();
    expect(run).toMatchObject({ status: 'OK', details: { regulations: 2, listings: 4, filesChecked: 1, newFindings: 1, unreachable: [] } });
    const { items: list, lastRun } = await items(maker);
    expect(lastRun).toMatchObject({ status: 'OK' });
    expect(list).toEqual([expect.objectContaining({
      kind: 'STATUS_CHANGE', status: 'OPEN', title: 'PMK 69/2025 is amended by PMK NO 9 TAHUN 2026', url: 'https://peraturan.bpk.go.id/Details/9/pmk-no-9-tahun-2026',
    })]);
    const notes = (await maker.agent.get('/api/notifications').expect(200)).body as { kind: string; title: string; link: string }[];
    expect(notes.find((n) => n.kind === 'SOURCE_WATCH')).toMatchObject({ title: '1 new finding on the official sources', link: '/source-watch' });
    await viewer.agent.get('/api/source-watch').expect(403);
  });

  it('reports new documents, new files and a changed official PDF once', async () => {
    pages.set('https://peraturan.bpk.go.id/Search?keywords=bea+keluar&tentang=&nomor=&sort=terbaru',
      bpkSearch(['pmk-no-70-tahun-2026', 'pmk-no-68-tahun-2025', 'pmk-no-38-tahun-2024']));
    // Newly listed but already registered: not reported.
    pages.set('https://peraturan.bpk.go.id/Search?keywords=kelapa+sawit&tentang=&nomor=&sort=terbaru',
      bpkSearch(['pmk-no-69-tahun-2025', 'permenperin-no-32-tahun-2024']));
    pages.set('https://jdih.kemendag.go.id/peraturan?keyword=harga+referensi', kemendag([
      'keputusan-menteri-perdagangan-republik-indonesia-nomor-2064-tahun-2026-tentang-harga-referensi-crude-palm-oil',
      'keputusan-menteri-perdagangan-republik-indonesia-nomor-1900-tahun-2026-tentang-harga-referensi-crude-palm-oil',
      'peraturan-menteri-perdagangan-nomor-26-tahun-2026-tentang-karet-alam',
    ]));
    pages.set(`${JDIH_69}/files`, jdihFiles(['2025pmkeuangan069.pdf', 'Ralat PMK 69.pdf']));
    permenFile = pdf('permenperin corrected');
    pages.set(PERMEN_PDF, permenFile);

    const run = await runNow();
    expect(run).toMatchObject({ status: 'OK', details: { newFindings: 4 } });
    const open = (await items(maker, 'OPEN')).items;
    expect(open.map((i) => `${i.kind} ${i.title}`).sort()).toEqual([
      'FILE_CHANGED The official file of "Permenperin 32/2024" has changed',
      'NEW_DOCUMENT Keputusan menteri perdagangan nomor 2064 tahun 2026 tentang harga referensi crude palm oil',
      'NEW_DOCUMENT Peraturan pmk-no-70-tahun-2026',
      'NEW_FILE PMK 69/2025: new file "Ralat PMK 69.pdf"',
      'STATUS_CHANGE PMK 69/2025 is amended by PMK NO 9 TAHUN 2026',
    ]);
    const { rows: [doc] } = await h.pool.query<{ recheck_mismatch: boolean; sha256: Buffer }>(
      `SELECT recheck_mismatch, sha256 FROM ecr.source_document WHERE official_url = $1`, [PERMEN_PDF]);
    expect(doc.recheck_mismatch).toBe(true);
    expect(doc.sha256.equals(createHash('sha256').update(permenFile).digest())).toBe(false);

    // Nothing changed since: nothing new.
    expect((await runNow()).details.newFindings).toBe(0);
  });

  it('lets a Maker close an item, with a reason to dismiss it', async () => {
    const [item] = (await items(maker, 'OPEN')).items.filter((i) => i.kind === 'NEW_DOCUMENT');
    expect((await send(maker, 'post', `/api/source-watch/${item.id}/resolve`, { status: 'DISMISSED' }).expect(400)).body.error.details.fields)
      .toEqual([{ field: 'note', message: 'Say why it does not need a change.' }]);
    await send(checker, 'post', `/api/source-watch/${item.id}/resolve`, { status: 'DONE' }).expect(403);
    await send(maker, 'post', `/api/source-watch/${item.id}/resolve`, { status: 'DISMISSED', note: 'Not about export charges' }).expect(200);
    expect((await send(maker, 'post', `/api/source-watch/${item.id}/resolve`, { status: 'DONE' }).expect(409)).body.error.code).toBe('ALREADY_RESOLVED');
    expect((await items(checker, 'DISMISSED')).items).toEqual([expect.objectContaining({ id: item.id, status: 'DISMISSED', resolvedBy: expect.any(String) })]);
    const { rows: [audit] } = await h.pool.query(`SELECT reason, after FROM ecr.audit_event WHERE action = 'SOURCE_WATCH_RESOLVED' AND entity_id = $1`, [item.id]);
    expect(audit).toMatchObject({ reason: 'Not about export charges', after: { status: 'DISMISSED' } });
  });

  it('fails the run when no official source can be read', async () => {
    offline = true;
    const run = await runNow();
    offline = false;
    expect(run).toMatchObject({ status: 'FAILED' });
    expect(run.error).toMatch(/^No official source could be read/);
  });
});
