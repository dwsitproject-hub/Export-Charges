import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_UPDATE_USER_ID, AutoUpdateService } from '../src/auto-update/auto-update.service';
import { RegulationDraftService } from '../src/auto-update/regulation-drafts';
import { effectiveDate, parseBpkRegulation, parsePalmDutyTable, parsePalmLevyTable, parseRegulationText } from '../src/auto-update/regulation-text';
import { ChangeSetsService } from '../src/registry/change-sets.service';
import { SourceDocumentsService } from '../src/registry/source-documents.service';
import { loadOfficialSeed } from '../src/scripts/official-seed';
import { Agent, Harness, Me, Person, startHarness } from './harness';

/** Text of the real PMK 68/2025 and PMK 9/2026 as pdf.js reads it from the official PDFs. */
const PMK_68 = readFileSync(join(__dirname, 'fixtures', 'pmk-68-2025.txt'), 'utf8');
const PMK_9 = readFileSync(join(__dirname, 'fixtures', 'pmk-9-2026.txt'), 'utf8');
const SEED = JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'official-palm-2026-11.json'), 'utf8'));

/** A peraturan.bpk.go.id Details page, as the site renders the fields ECR reads. */
const bpkPage = (fields: Record<string, string>, pdfPath: string) => Object.entries(fields)
  .map(([k, v]) => `<div class="row g-4"><div class="col-lg-3 fw-bold">${k}</div><div class="col-lg-9">${v}</div></div>`).join('\n')
  + `\n<a href="${pdfPath}" class="btn">Download</a>`;
const bpkFields = (number: number, title: string, promulgated: string) => ({
  'Judul': `Peraturan Menteri Keuangan Nomor ${number} Tahun 2026 tentang ${title}`, 'T.E.U.': 'Indonesia, Kementerian Keuangan',
  'Nomor': String(number), 'Bentuk Singkat': 'PMK', 'Tahun': '2026', 'Tanggal Penetapan': promulgated, 'Tanggal Pengundangan': promulgated,
  'Tanggal Berlaku': promulgated, 'Status': 'Berlaku',
});

describe('reading regulations: the real PMK 68/2025 and PMK 9/2026 against the data entered by hand', () => {
  it('reads the 17 CPO price bands and all 26 export duty lines of PMK 68/2025 Lampiran C', () => {
    const t = parsePalmDutyTable(PMK_68)!;
    expect(t.annexLabel).toBe('Lampiran C');
    expect(t.bands).toEqual(SEED.bandTable.bands);
    expect(t.lines.map((l) => ({ kelompok: l.kelompok, no: l.no, hs: l.hs.join('; '), amounts: l.amounts })))
      .toEqual(SEED.bkLines.map((l: { kelompok: string; no: number; hs: string; amounts: number[] }) => ({ kelompok: l.kelompok, no: l.no, hs: l.hs, amounts: l.amounts })));
    expect(t.lines[1].uraian).toBe('Biji Sawit, dan Kernel Kelapa Sawit; Buah Sawit');
    expect(t.lines[25].uraian).toBe('Biodiesel dari Minyak Sawit dengan Kandungan Metil Ester lebih dari 96,5%-volume');
  });

  it('reads all 34 levy lines of PMK 9/2026 Lampiran A, carrying merged rate cells down', () => {
    const t = parsePalmLevyTable(PMK_9)!;
    expect(t.annexLabel).toBe('Lampiran A');
    expect(t.lines.map((l) => ({ kelompok: l.kelompok, no: l.no, basis: l.basis, value: l.value === null ? null : Number(l.value) })))
      .toEqual(SEED.peLines.map((l: { kelompok: string; no: number; basis: string; value: number | null }) => ({ kelompok: l.kelompok, no: l.no, basis: l.basis, value: l.value })));
    expect(t.lines[5].uraian).toBe(SEED.peLines[5].uraian);
  });

  it('reads what a PMK amends and when it starts', () => {
    expect(parseRegulationText(PMK_68)).toEqual({
      regType: 'PMK', number: '68', year: 2025, amends: [{ regType: 'PMK', number: '38', year: 2024 }], revokes: [], effective: { daysAfterPromulgation: 7 },
    });
    const pmk9 = parseRegulationText(PMK_9)!;
    expect(pmk9.amends).toEqual([{ regType: 'PMK', number: '69', year: 2025 }]);
    expect(effectiveDate(pmk9, '2026-02-27')).toBe('2026-03-01');
    expect(effectiveDate(parseRegulationText(PMK_68)!, '2025-10-15')).toBe('2025-10-22');
  });

  it('reads a BPK regulation page', () => {
    expect(parseBpkRegulation(bpkPage(bpkFields(9, 'Perubahan atas PMK 69', '27 Februari 2026'), '/Download/409314/2026pmkeuangan008.pdf'))).toMatchObject({
      regType: 'PMK', number: '9', year: 2026, issuer: 'Kementerian Keuangan', promulgatedOn: '2026-02-27', status: 'Berlaku',
      pdfUrl: 'https://peraturan.bpk.go.id/Download/409314/2026pmkeuangan008.pdf',
    });
  });
});

describe('semi-automatic regulations: ECR drafts, a Checker approves', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let admin: Person;
  let viewer: { agent: Agent; me: Me };
  const pages = new Map<string, string | Buffer>();
  const texts = new Map<string, string>();

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const runNow = async () => (await send(admin, 'post', '/api/jobs/auto-update/run').expect(200)).body;
  const notices = async (userId: string, kind: string) =>
    (await h.pool.query<{ title: string; body: string; link: string }>('SELECT title, body, link FROM ecr.notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [userId, kind])).rows;
  const watchItem = async (url: string, title: string) => h.pool.query(
    `INSERT INTO ecr.source_watch_item (kind, fingerprint, title, detail, url, source) VALUES ('NEW_DOCUMENT', $1, $2, 'New on BPK', $3, 'peraturan.bpk.go.id')`,
    [`listing:${url}`, title, url]);
  const watchStatus = async (url: string) => (await h.pool.query('SELECT status, resolved_by, resolution_note FROM ecr.source_watch_item WHERE url = $1', [url])).rows[0];
  /** A new PMK at BPK: its page, its PDF and the text pdf.js would read from it. */
  const publishAtBpk = (number: number, title: string, promulgated: string, text: string) => {
    const url = `https://peraturan.bpk.go.id/Details/9${number}/pmk-no-${number}-tahun-2026`;
    const pdfPath = `/Download/9${number}/2026pmkeuangan${number}.pdf`;
    const pdf = `%PDF-1.7\n% PMK ${number}/2026\n%%EOF\n`;
    pages.set(url, bpkPage(bpkFields(number, title, promulgated), pdfPath));
    pages.set(`https://peraturan.bpk.go.id${pdfPath}`, Buffer.from(pdf));
    texts.set(pdf, text);
    return url;
  };
  const catalogueRow = async (date: string, nameEn: string) => {
    const body = (await viewer.agent.get(`/api/catalogue?date=${date}&pageSize=200`).expect(200)).body as { rows: { nameEn: string; bk: { usdPerMt: string | null }; pe: { usdPerMt: string | null } }[] };
    const row = body.rows.find((r) => r.nameEn === nameEn);
    if (!row) throw new Error(`No ${nameEn} on ${date}: ${JSON.stringify(body).slice(0, 300)}`);
    return row;
  };

  beforeAll(async () => {
    h = await startHarness({ AUTO_UPDATE: 'true' });
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    admin = await h.privileged(['SUPER_ADMIN']);
    viewer = await h.signedIn(['VIEWER']);
    const updates = h.app.get(AutoUpdateService);
    updates.today = () => '2026-11-10';
    updates.fetcher = async (url) => {
      const page = pages.get(url);
      return page === undefined ? { status: 404, body: Buffer.alloc(0) } : { status: 200, body: Buffer.isBuffer(page) ? page : Buffer.from(page) };
    };
    h.app.get(RegulationDraftService).readPdf = async (pdf) => {
      const text = texts.get(pdf.toString('latin1'));
      if (text === undefined) throw new Error('not a PDF this test knows');
      return text;
    };
    // The registry production starts with: the official palm data (PMK 68/2025 duty, PMK 9/2026 levy, 122 products).
    await loadOfficialSeed(h.app.get(ChangeSetsService), h.app.get(SourceDocumentsService),
      { id: maker.me.user.id, permissions: new Set(), sessionId: '00000000-0000-0000-0000-000000000000', ip: '127.0.0.1', userAgent: 'test' },
      SEED, 'Starting registry for the test', async (d) => Buffer.from(`%PDF-1.7\n% ${d.key}\n%%EOF\n`));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('drafts a new PMK that changes the palm export duty table, and a Checker\'s approval puts it in force', async () => {
    // PMK 99/2026 amends PMK 68/2025: the same Lampiran C, but CPO in the 930–980 band goes from US$ 124 to 130.
    const text = PMK_68
      .replace('NOMOR 68 TAHUN 2025', 'NOMOR 99 TAHUN 2026')
      .replace('NOMOR 38 TAHUN 2024 TENTANG PENETAPAN BARANG EKSPOR', 'NOMOR 68 TAHUN 2025 TENTANG PENETAPAN BARANG EKSPOR')
      .replace('6. Crude Palm Oil (CPO) 1511.10.00 0 3 18 33 52 74 124 148', '6. Crude Palm Oil (CPO) 1511.10.00 0 3 18 33 52 74 130 148');
    const url = publishAtBpk(99, 'Perubahan atas Peraturan Menteri Keuangan Nomor 68 Tahun 2025', '20 November 2026', text);
    await watchItem(url, 'Peraturan pmk-no-99-tahun-2026');

    const run = await runNow();
    expect(run.error).toBeNull();
    expect(run.status).toBe('OK');
    const handled = run.details.handled.find((x: { decree: string }) => x.decree === 'PMK 99/2026');
    expect(handled).toMatchObject({ outcome: 'SENT_TO_CHECKER' });
    expect(handled.detail).toContain('in force from 2026-11-27 (promulgated 2026-11-20)');
    expect(handled.detail).toContain('It amends PMK 68/2025.');
    expect(handled.detail).not.toContain('NOT linked to products');

    const setId = handled.changeSetId as string;
    const { rows: [set] } = await h.pool.query('SELECT status, created_by, title FROM ecr.change_set WHERE id = $1', [setId]);
    expect(set).toMatchObject({ status: 'SUBMITTED', created_by: AUTO_UPDATE_USER_ID });
    expect(set.title).toMatch(/^PMK 99\/2026: Perubahan atas Peraturan Menteri Keuangan Nomor 68 Tahun 2025 — drafted by ECR for a Checker$/);
    const { rows: items } = await h.pool.query<{ entity_type: string; operation: string; n: number }>(
      `SELECT entity_type, operation, count(*)::int AS n FROM ecr.change_item WHERE change_set_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [setId]);
    expect(items).toEqual([
      { entity_type: 'REGULATION', operation: 'CREATE', n: 1 },
      { entity_type: 'SCHEDULE', operation: 'CREATE', n: 1 },
      { entity_type: 'SCHEDULE', operation: 'END_DATE', n: 1 },
      { entity_type: 'SCHEDULE_LINE', operation: 'CREATE', n: 26 },
      { entity_type: 'SCHEDULE_LINE', operation: 'END_DATE', n: 26 },
    ]);
    expect(await watchStatus(url)).toMatchObject({ status: 'DONE', resolved_by: AUTO_UPDATE_USER_ID });
    expect((await notices(checker.me.user.id, 'CHANGESET_SUBMITTED')).at(-1)?.link).toBe(`/change-sets/${setId}`);

    // Nothing changes until a Checker approves; then CPO pays the new duty from 27 November.
    expect(Number((await catalogueRow('2026-11-27', 'Crude Palm Oil (CPO)')).bk.usdPerMt)).toBe(124);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200);
    expect(Number((await catalogueRow('2026-11-26', 'Crude Palm Oil (CPO)')).bk.usdPerMt)).toBe(124);
    expect(Number((await catalogueRow('2026-11-27', 'Crude Palm Oil (CPO)')).bk.usdPerMt)).toBe(130);
    expect(Number((await catalogueRow('2026-11-27', 'Palm Mesocarp Oil (PMO)')).bk.usdPerMt)).toBe(130);
    expect(Number((await catalogueRow('2026-11-27', 'Palm Kernel (PK)')).bk.usdPerMt)).toBe(125);
    expect((await notices(viewer.me.user.id, 'AUTO_UPDATE')).at(-1)?.title).toBe('Updated: PMK 99/2026: Perubahan atas Peraturan Menteri Keuangan Nomor 68 Tahun 2025');
  });

  it('drafts a new PMK that changes the levy table', async () => {
    const text = PMK_9.replace('NOMOR 9 TAHUN 2026', 'NOMOR 121 TAHUN 2026').replace('Ton\n12,5% dari Harga Referensi', 'Ton\n15% dari Harga Referensi');
    const url = publishAtBpk(121, 'Perubahan Kedua atas Peraturan Menteri Keuangan Nomor 69 Tahun 2025', '1 Desember 2026', text);
    await watchItem(url, 'Peraturan pmk-no-121-tahun-2026');
    const run = await runNow();
    const handled = run.details.handled.find((x: { decree: string }) => x.decree === 'PMK 121/2026');
    expect(handled).toMatchObject({ outcome: 'SENT_TO_CHECKER' });
    expect(handled.detail).toContain('Export levy: PMK 121/2026 Lampiran A replaces the levy table in force (34 lines) from 2026-12-03.');
    const { rows: lines } = await h.pool.query(
      `SELECT after->>'itemNo' AS no, after->>'pct' AS pct FROM ecr.change_item WHERE change_set_id = $1 AND entity_type = 'SCHEDULE_LINE' AND operation = 'CREATE' ORDER BY (after->>'itemNo')::int`, [handled.changeSetId]);
    expect(lines.slice(5, 11).map((l) => [l.no, l.pct])).toEqual([['6', '15'], ['7', '15'], ['8', '15'], ['9', '15'], ['10', '15'], ['11', '12']]);
  });

  it("reads the Ministry of Finance's own copy first, so BPK's link to another regulation's PDF does not matter", async () => {
    // As BPK really does for PMK 9/2026: its page offers PMK 8/2026's file.
    const url = publishAtBpk(122, 'Perubahan Ketiga atas Peraturan Menteri Keuangan Nomor 69 Tahun 2025', '4 Desember 2026',
      'PERATURAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR 8 TAHUN 2026 TENTANG PERUBAHAN ATAS PERATURAN MENTERI KEUANGAN NOMOR 228/PMK.03/2017 TENTANG RINCIAN DATA DENGAN RAHMAT TUHAN YANG MAHA ESA');
    const jdihPdf = 'https://jdih.kemenkeu.go.id/api/download/00000000-1111-2222-3333-444444444444/2026pmkeuangan122.pdf';
    pages.set('https://jdih.kemenkeu.go.id/dok/pmk-122-tahun-2026/files', `<a href="/api/download/00000000-1111-2222-3333-444444444444/2026pmkeuangan122.pdf">2026pmkeuangan122.pdf</a>`);
    const pdf = '%PDF-1.7\n% JDIH PMK 122/2026\n%%EOF\n';
    pages.set(jdihPdf, Buffer.from(pdf));
    // Same levy table as in force: the draft only registers the regulation and its amendment of PMK 69/2025.
    texts.set(pdf, PMK_9.replace('NOMOR 9 TAHUN 2026', 'NOMOR 122 TAHUN 2026'));
    await watchItem(url, 'Peraturan pmk-no-122-tahun-2026');

    const run = await runNow();
    const handled = run.details.handled.find((x: { decree: string }) => x.decree === 'PMK 122/2026');
    expect(handled).toMatchObject({ outcome: 'SENT_TO_CHECKER' });
    const { rows: [set] } = await h.pool.query('SELECT justification FROM ecr.change_set WHERE id = $1', [handled.changeSetId]);
    expect(set.justification).toContain(`official PDF (${jdihPdf})`);
    const { rows: items } = await h.pool.query(
      `SELECT entity_type, operation, after->'relations' AS relations, after->>'officialUrl' AS official, after->>'bpkStatusUrl' AS bpk FROM ecr.change_item WHERE change_set_id = $1`, [handled.changeSetId]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      entity_type: 'REGULATION', operation: 'CREATE', relations: [{ relation: 'AMENDS' }],
      official: 'https://jdih.kemenkeu.go.id/dok/pmk-122-tahun-2026', bpk: url,
    });
  });

  it("refuses BPK's PDF when it is another regulation and the Ministry has no copy, and asks the Makers", async () => {
    const url = publishAtBpk(123, 'Perubahan atas Peraturan Menteri Keuangan Nomor 69 Tahun 2025', '5 Desember 2026',
      'PERATURAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR 8 TAHUN 2026 TENTANG PERUBAHAN ATAS PERATURAN MENTERI KEUANGAN NOMOR 228/PMK.03/2017 TENTANG RINCIAN DATA DENGAN RAHMAT TUHAN YANG MAHA ESA');
    await watchItem(url, 'Peraturan pmk-no-123-tahun-2026');
    const run = await runNow();
    const handled = run.details.handled.find((x: { decree: string }) => x.decree.includes('123'));
    expect(handled).toMatchObject({ outcome: 'NEEDS_REVIEW' });
    expect(handled.detail).toMatch(/2026pmkeuangan123\.pdf is PMK 8\/2026, not PMK 123\/2026/);
    expect(await watchStatus(url)).toMatchObject({ status: 'OPEN' });
  });

  it('dismisses a regulation that touches nothing ECR holds', async () => {
    const text = PMK_9.replace('NOMOR 9 TAHUN 2026', 'NOMOR 130 TAHUN 2026').replace('NOMOR 69\nTAHUN 2025', 'NOMOR 70\nTAHUN 2025');
    // Same levy table as in force (after the drafts above were left unapproved, PMK 9's table is still the one in force).
    const url = publishAtBpk(130, 'Perubahan atas Peraturan Menteri Keuangan Nomor 70 Tahun 2025', '2 Desember 2026', text);
    await watchItem(url, 'Peraturan pmk-no-130-tahun-2026');
    const run = await runNow();
    expect(run.details.handled.find((x: { decree: string }) => x.decree === 'PMK 130/2026')).toMatchObject({ outcome: 'NOT_RELEVANT' });
    expect(await watchStatus(url)).toMatchObject({ status: 'DISMISSED', resolved_by: AUTO_UPDATE_USER_ID });
  });

  it('leaves a regulation it cannot read to the Makers, and says so once', async () => {
    const url = publishAtBpk(131, 'Tarif', '3 Desember 2026', 'SALINAN — gambar hasil pindaian');
    await watchItem(url, 'Peraturan pmk-no-131-tahun-2026');
    const run = await runNow();
    expect(run.details.handled.find((x: { decree: string }) => x.decree.includes('131'))).toMatchObject({ outcome: 'NEEDS_REVIEW' });
    expect(await watchStatus(url)).toMatchObject({ status: 'OPEN' });
    for (const p of [maker, checker, admin]) {
      expect((await notices(p.me.user.id, 'AUTO_UPDATE_NEEDS_REVIEW')).map((n) => n.title)).toContain('Peraturan pmk-no-131-tahun-2026 could not be drafted automatically');
    }
    await runNow();
    expect((await notices(maker.me.user.id, 'AUTO_UPDATE_NEEDS_REVIEW')).filter((n) => n.title.includes('131'))).toHaveLength(1);
  });
});
