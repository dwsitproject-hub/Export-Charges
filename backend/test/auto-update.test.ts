import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_UPDATE_USER_ID, AutoUpdateService, KEMENDAG_LISTING, KURS_PAGE } from '../src/auto-update/auto-update.service';
import { idDate, idNumber, parseCpoDecree, parseKmkDecree, parseKursPage } from '../src/auto-update/official-values';
import { pdfText } from '../src/auto-update/pdf-text';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
/** The real decrees: Kepmendag 2064/2026 (CPO November 2026) and KMK 53/MK/EF.2/2026 (USD 4–10 November 2026). */
const KEPMENDAG_2064 = fixture('kepmendag-2064-tahun-2026.pdf');
const KMK_53 = fixture('kmk-53-mk-ef2-2026-kurs-pajak.pdf');

/** A one-page PDF with these lines of text (standard Helvetica), to stand in for a future decree. */
function textPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 9 Tf 30 800 Td 12 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const cpoDecreePdf = (number: number, price: string, from: string, to: string) => textPdf([
  `KEPUTUSAN MENTERI PERDAGANGAN REPUBLIK INDONESIA NOMOR ${number} TAHUN 2026`,
  'TENTANG HARGA PATOKAN EKSPOR DAN HARGA REFERENSI ATAS PRODUK PERTANIAN DAN KEHUTANAN',
  'KESATU : Menetapkan Harga Referensi Crude Palm Oil yang dikenakan Bea Keluar dan Tarif Layanan',
  `Badan Layanan Umum sebesar US$ ${price}/MT.`,
  'KEEMPAT : Harga Referensi sebagaimana dimaksud dalam Diktum KESATU berlaku',
  `terhitung sejak tanggal ${from} sampai dengan tanggal ${to}.`,
]);
const decreeSlug = (number: number) =>
  `keputusan-menteri-perdagangan-republik-indonesia-nomor-${number}-tahun-2026-tentang-harga-patokan-ekspor-dan-harga-referensi-atas-produk-pertanian-dan-kehutanan-yang-dikenakan-bea-keluar-dan-tarif-layanan-badan-layanan-umum`;
const decreeUrl = (number: number) => `https://jdih.kemendag.go.id/peraturan/${decreeSlug(number)}`;
const decreePdfUrl = (number: number) => `https://jdih.kemendag.go.id/uploads/peraturan/2026/17932${number}_abc.pdf`;
const listing = (numbers: number[]) => numbers.map((n) => `<a href="${decreeUrl(n)}">Kepmendag ${n}</a>`).join('\n')
  + '\n<a href="https://jdih.kemendag.go.id/peraturan/keputusan-menteri-perdagangan-republik-indonesia-nomor-2061-tahun-2026-tentang-harga-patokan-ekspor-dan-harga-referensi-atas-produk-pertambangan-yang-dikenakan-bea-keluar">mining</a>';
const decreePage = (number: number) => `<a href="https://jdih.kemendag.go.id/${decreePdfUrl(number).split('.go.id/')[1]}" target="_blank">Unduh</a>`;
/** BKF's Kurs Pajak page, as the site renders the parts ECR reads. */
const kursPage = (kmk: string, from: string, to: string, usd: string, pdf: string) => `
  <h4>KMK Nomor ${kmk}</h4><p>Tanggal berlaku: ${from} - ${to}</p>
  <a href="/${pdf}">Unduh KMK</a>
  <table class="kurs-pajak-table"><tbody><tr><td>1</td><td class="text-left"> <span class='hidden-xs'>Dolar Amerika Serikat (USD)</span>
  <span class='visible-xs-inline'>USD</span> </td><td class="flex text-right"><img src="/css/transparent.gif"> <div class="m-l-5">${usd}</div></td>
  <td>109,00</td></tr></tbody></table>`;
const KMK_53_PDF = 'files/kurs/file/1793693747_nilai_kurs_04-10_nov_2026.pdf';

describe('official values: reading the decrees', () => {
  it('reads Indonesian numbers and dates', () => {
    expect(idNumber('18.141,00')).toBe('18141.00');
    expect(idNumber('978,90')).toBe('978.90');
    expect(idNumber('1.012,5')).toBe('1012.5');
    expect(idNumber('18,141.00')).toBeNull();
    expect(idDate('1 November 2026')).toBe('2026-11-01');
    expect(idDate('04 NOVEMBER 2026')).toBe('2026-11-04');
    expect(idDate('31 November 2026')).toBeNull();
  });

  it('reads the CPO reference price and its period from the real Kepmendag 2064/2026', async () => {
    expect(parseCpoDecree(await pdfText(KEPMENDAG_2064))).toMatchObject({ number: '2064', year: 2026, value: '978.90', periodFrom: '2026-11-01', periodTo: '2026-11-30' });
  });

  it('reads the USD rate and its period from the real KMK 53/MK/EF.2/2026', async () => {
    expect(parseKmkDecree(await pdfText(KMK_53))).toMatchObject({ number: '53/MK/EF.2/2026', usd: '18141.00', periodFrom: '2026-11-04', periodTo: '2026-11-10' });
  });

  it('reads BKF\'s Kurs Pajak page', () => {
    expect(parseKursPage(kursPage('53/MK/EF.2/2026', '04 November 2026', '10 November 2026', '18.141,00', KMK_53_PDF))).toEqual({
      number: '53/MK/EF.2/2026', usd: '18141.00', periodFrom: '2026-11-04', periodTo: '2026-11-10', pdfUrl: `https://fiskal.kemenkeu.go.id/${KMK_53_PDF}`,
    });
  });

  it('returns nothing for text without the expected wording', async () => {
    expect(parseCpoDecree(await pdfText(KMK_53))).toBeNull();
    expect(parseKmkDecree(await pdfText(KEPMENDAG_2064))).toBeNull();
    expect(parseKursPage('<html>maintenance</html>')).toBeNull();
  });
});

describe('automatic update of the CPO reference price and the KMK rate', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let admin: Person;
  let viewer: { agent: Agent; me: Me };
  let service: AutoUpdateService;
  const pages = new Map<string, string | Buffer>();
  let offline = false;

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const runNow = async () => (await send(admin, 'post', '/api/jobs/auto-update/run').expect(200)).body;
  const published = async (code: string) => (await h.pool.query<{ period_from: string; period_to: string; value: string }>(
    `SELECT to_char(v.period_from, 'YYYY-MM-DD') AS period_from, to_char(v.period_to, 'YYYY-MM-DD') AS period_to, trim_scale(v.value)::text AS value
       FROM ecr.ref_value v JOIN ecr.ref_series s ON s.entity_id = v.series_entity_id AND s.version_to IS NULL
      WHERE s.code = $1 AND v.version_to IS NULL ORDER BY v.period_from`, [code])).rows;
  const notices = async (userId: string, kind: string) =>
    (await h.pool.query<{ title: string; body: string; link: string }>('SELECT title, body, link FROM ecr.notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [userId, kind])).rows;

  beforeAll(async () => {
    h = await startHarness({ AUTO_UPDATE: 'true' });
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    admin = await h.privileged(['SUPER_ADMIN']);
    viewer = await h.signedIn(['VIEWER']);
    service = h.app.get(AutoUpdateService);
    service.today = () => '2026-11-04';
    service.fetcher = async (url) => {
      if (offline) throw new Error('getaddrinfo ENOTFOUND');
      const page = pages.get(url);
      if (page === undefined) return { status: 404, body: Buffer.alloc(0) };
      return { status: 200, body: Buffer.isBuffer(page) ? page : Buffer.from(page) };
    };

    // The registry before: October's CPO price and the previous week's KMK rate, entered by a Maker and approved.
    const up = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REF_PRICE_DECREE', title: 'Kepmendag October 2026', officialUrl: decreeUrl(1999) })) up.field(k, v);
    const doc = (await up.attach('file', textPdf(['October decree']), { filename: 'oct.pdf', contentType: 'application/pdf' }).expect(201)).body.id;
    const set = (await send(maker, 'post', '/api/change-sets', { title: 'Reference series', justification: 'Test data' }).expect(201)).body.id;
    const add = async (entityType: string, after: object) => {
      const items = (await send(maker, 'put', `/api/change-sets/${set}/items`, { entityType, operation: 'CREATE', after }).expect(200)).body.items as { entityId: string; entityType: string }[];
      return items[items.length - 1].entityId;
    };
    const cpo = await add('REF_SERIES', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY', productId: null });
    const fx = await add('REF_SERIES', { code: 'FX-USDIDR', name: 'Kurs KMK USD/IDR', kind: 'FX_RATE', unit: 'IDR/USD', cadence: 'WEEKLY', productId: null });
    await add('REF_VALUE', { seriesId: cpo, periodFrom: '2026-10-01', periodTo: '2026-10-31', value: '950.00', sourceDocumentId: doc, sourceReference: 'Kepmendag October' });
    await add('REF_VALUE', { seriesId: fx, periodFrom: '2026-10-28', periodTo: '2026-11-03', value: '18032.00', sourceDocumentId: doc, sourceReference: 'KMK previous week' });
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/approve`).expect(200);

    // The official sites today: Kepmendag 2064/2026 and KMK 53/MK/EF.2/2026, the real PDFs.
    pages.set(KEMENDAG_LISTING, listing([2064]));
    pages.set(decreeUrl(2064), decreePage(2064));
    pages.set(decreePdfUrl(2064), KEPMENDAG_2064);
    pages.set(KURS_PAGE, kursPage('53/MK/EF.2/2026', '04 November 2026', '10 November 2026', '18.141,00', KMK_53_PDF));
    pages.set(`https://fiskal.kemenkeu.go.id/${KMK_53_PDF}`, KMK_53);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('reads both new decrees, publishes them without a Checker and tells every user', async () => {
    const run = await runNow();
    expect(run.status).toBe('OK');
    expect(run.details.handled).toEqual([
      expect.objectContaining({ decree: 'Kepmendag 2064/2026', outcome: 'PUBLISHED' }),
      expect.objectContaining({ decree: 'KMK 53/MK/EF.2/2026', outcome: 'PUBLISHED' }),
    ]);

    expect(await published('CPO')).toEqual([
      { period_from: '2026-10-01', period_to: '2026-10-31', value: '950' },
      { period_from: '2026-11-01', period_to: '2026-11-30', value: '978.9' },
    ]);
    expect((await published('FX-USDIDR')).at(-1)).toEqual({ period_from: '2026-11-04', period_to: '2026-11-10', value: '18141' });

    // Recorded under the system account, as a direct publication, with the official PDF stored as its source.
    const { rows: sets } = await h.pool.query(
      `SELECT title, status, created_by, reviewed_by, decision_comment FROM ecr.change_set WHERE created_by = $1 ORDER BY created_at`, [AUTO_UPDATE_USER_ID]);
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ status: 'PUBLISHED', reviewed_by: null, title: 'CPO reference price November 2026 (Kepmendag 2064/2026) — automatic update' });
    expect(sets[0].decision_comment).toMatch(/^Published directly, without a Checker: Automatic update from Kepmendag 2064\/2026/);
    const { rows: audit } = await h.pool.query(`SELECT action FROM ecr.audit_event WHERE actor_user_id = $1 AND action = 'CHANGESET_PUBLISHED_DIRECT'`, [AUTO_UPDATE_USER_ID]);
    expect(audit).toHaveLength(2);
    const { rows: docs } = await h.pool.query(`SELECT doc_kind, official_url FROM ecr.source_document WHERE uploaded_by = $1 ORDER BY doc_kind DESC`, [AUTO_UPDATE_USER_ID]);
    expect(docs).toEqual([
      { doc_kind: 'REF_PRICE_DECREE', official_url: decreeUrl(2064) },
      { doc_kind: 'FX_DECREE', official_url: `https://fiskal.kemenkeu.go.id/${KMK_53_PDF}` },
    ]);

    // Every user, whatever their role, is told — in ECR and by email.
    for (const person of [viewer, maker, checker, admin]) {
      const got = await notices(person.me.user.id, 'AUTO_UPDATE');
      expect(got.map((n) => n.title)).toEqual([
        'CPO reference price for November 2026: US$ 978.90/MT',
        'KMK rate for 4 November 2026 – 10 November 2026: Rp 18,141.00 per US$',
      ]);
    }
    const [cpoNotice] = await notices(viewer.me.user.id, 'AUTO_UPDATE');
    expect(cpoNotice.body).toContain('(previous period: US$ 950.00)');
    expect(cpoNotice.link).toMatch(/^\/bulletins\/\d+$/);
    const { rows: [mail] } = await h.pool.query('SELECT count(*)::int AS n FROM ecr.email_outbox WHERE to_user_id = $1 AND subject LIKE $2', [viewer.me.user.id, '[ECR] CPO reference price%']);
    expect(mail.n).toBe(1);
  });

  it('does nothing more on the next runs', async () => {
    const run = await runNow();
    expect(run.details.handled).toEqual([]);
    expect(await notices(viewer.me.user.id, 'AUTO_UPDATE')).toHaveLength(2);
  });

  it('drafts a decree that changes the price too much for a Checker; the Checker\'s approval publishes it and tells everyone', async () => {
    pages.set(KEMENDAG_LISTING, listing([2100, 2064]));
    pages.set(decreeUrl(2100), decreePage(2100));
    pages.set(decreePdfUrl(2100), cpoDecreePdf(2100, '1.600,00', '1 Desember 2026', '31 Desember 2026'));

    const run = await runNow();
    expect(run.details.handled).toEqual([expect.objectContaining({ decree: 'Kepmendag 2100/2026', outcome: 'SENT_TO_CHECKER' })]);
    expect(run.details.handled[0].detail).toMatch(/differs by 63\.4 % from the previous 978\.90/);
    const setId = run.details.handled[0].changeSetId as string;
    const { rows: [set] } = await h.pool.query('SELECT status, created_by, title, justification FROM ecr.change_set WHERE id = $1', [setId]);
    expect(set).toMatchObject({ status: 'SUBMITTED', created_by: AUTO_UPDATE_USER_ID, title: 'CPO reference price December 2026 (Kepmendag 2100/2026) — drafted by ECR for a Checker' });
    expect(set.justification).toMatch(/NOT published because: Kepmendag 2100\/2026: 1600\.00 differs by 63\.4 %/);
    // Nothing is published yet; the Checkers are asked to review.
    expect((await published('CPO')).map((v) => v.period_from)).toEqual(['2026-10-01', '2026-11-01']);
    const review = (await notices(checker.me.user.id, 'CHANGESET_SUBMITTED')).at(-1)!;
    expect(review).toMatchObject({ title: `Change set waiting for review: ${set.title}`, link: `/change-sets/${setId}` });
    expect(review.body).toMatch(/^ECR drafted this change by itself from the official source/);
    expect(await notices(viewer.me.user.id, 'CHANGESET_SUBMITTED')).toEqual([]);

    const reviews = (await notices(checker.me.user.id, 'CHANGESET_SUBMITTED')).length;
    await runNow();
    expect(await notices(checker.me.user.id, 'CHANGESET_SUBMITTED')).toHaveLength(reviews);

    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200);
    expect((await published('CPO')).at(-1)).toEqual({ period_from: '2026-12-01', period_to: '2026-12-31', value: '1600' });
    const announced = (await notices(viewer.me.user.id, 'AUTO_UPDATE')).at(-1)!;
    expect(announced.title).toBe('Updated: CPO reference price December 2026 (Kepmendag 2100/2026)');
    expect(announced.body).toMatch(/^ECR prepared this change from the official source and .+ checked and approved it\. It is published as data version \d+\.$/);
  });

  it('asks the Makers to enter a decree it cannot read at all', async () => {
    pages.set(KEMENDAG_LISTING, listing([2099, 2064]));
    pages.set(decreeUrl(2099), decreePage(2099));
    pages.set(decreePdfUrl(2099), textPdf(['KEPUTUSAN MENTERI PERDAGANGAN REPUBLIK INDONESIA NOMOR 2099 TAHUN 2026', 'Lampiran: tabel harga (gambar)']));
    const run = await runNow();
    expect(run.details.handled).toEqual([expect.objectContaining({ decree: 'Kepmendag 2099/2026', outcome: 'NEEDS_REVIEW' })]);
    for (const person of [maker, checker, admin]) {
      expect((await notices(person.me.user.id, 'AUTO_UPDATE_NEEDS_REVIEW')).map((n) => n.title)).toEqual(['Kepmendag 2099/2026 could not be updated automatically — please enter it']);
    }
    expect(await notices(viewer.me.user.id, 'AUTO_UPDATE_NEEDS_REVIEW')).toEqual([]);
  });

  it('publishes a normal next month, and closes the source watch item for that decree', async () => {
    await h.pool.query(
      `INSERT INTO ecr.source_watch_item (kind, fingerprint, title, detail, url, source) VALUES ('NEW_DOCUMENT', $1, 'Kepmendag 2101', 'new', $2, 'jdih.kemendag.go.id')`,
      [`listing:${decreeUrl(2101)}`, decreeUrl(2101)],
    );
    pages.set(KEMENDAG_LISTING, listing([2101, 2100, 2099]));
    pages.set(decreeUrl(2101), decreePage(2101));
    pages.set(decreePdfUrl(2101), cpoDecreePdf(2101, '1.650,50', '1 Januari 2027', '31 Januari 2027'));

    const run = await runNow();
    expect(run.details.handled).toEqual([expect.objectContaining({ decree: 'Kepmendag 2101/2026', outcome: 'PUBLISHED' })]);
    expect((await published('CPO')).at(-1)).toEqual({ period_from: '2027-01-01', period_to: '2027-01-31', value: '1650.5' });
    expect((await notices(viewer.me.user.id, 'AUTO_UPDATE')).at(-1)?.title).toBe('CPO reference price for January 2027: US$ 1,650.50/MT');
    const { rows: [item] } = await h.pool.query('SELECT status, resolved_by, resolution_note FROM ecr.source_watch_item WHERE url = $1', [decreeUrl(2101)]);
    expect(item).toMatchObject({ status: 'DONE', resolved_by: AUTO_UPDATE_USER_ID });
    expect(item.resolution_note).toMatch(/^Published automatically as data version \d+\.$/);
  });

  it('sends a KMK whose PDF disagrees with BKF\'s page to a Checker, with the decree\'s own figures', async () => {
    pages.set(KURS_PAGE, kursPage('54/MK/EF.2/2026', '11 November 2026', '17 November 2026', '18.200,00', 'files/kurs/file/54.pdf'));
    pages.set('https://fiskal.kemenkeu.go.id/files/kurs/file/54.pdf', textPdf([
      'KEPUTUSAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR 54/MK/EF.2/2026',
      'periode 11 November 2026 sampai dengan 17 November 2026 sebagai berikut:',
      '1. Rp 18.250,00 1,- dolar Amerika Serikat (USD)',
    ]));
    const run = await runNow();
    expect(run.details.handled).toEqual([expect.objectContaining({ decree: 'KMK 54/MK/EF.2/2026', outcome: 'SENT_TO_CHECKER' })]);
    expect(run.details.handled[0].detail).toContain('USD rate 18250.00 (page 18200.00)');
    expect((await published('FX-USDIDR')).at(-1)?.period_from).toBe('2026-11-04');
    const { rows: [item] } = await h.pool.query(`SELECT after->>'value' AS value FROM ecr.change_item WHERE change_set_id = $1`, [run.details.handled[0].changeSetId]);
    expect(item.value).toBe('18250');
  });

  it('skips a decree whose period is already over', async () => {
    service.today = () => '2026-11-20';
    pages.set(KURS_PAGE, kursPage('55/MK/EF.2/2026', '11 November 2026', '17 November 2026', '18.200,00', 'files/kurs/file/55.pdf'));
    pages.set('https://fiskal.kemenkeu.go.id/files/kurs/file/55.pdf', textPdf([
      'KEPUTUSAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR 55/MK/EF.2/2026',
      'periode 11 November 2026 sampai dengan 17 November 2026 sebagai berikut:',
      '1. Rp 18.200,00 1,- dolar Amerika Serikat (USD)',
    ]));
    const run = await runNow();
    expect(run.details.handled).toEqual([expect.objectContaining({ decree: 'KMK 55/MK/EF.2/2026', outcome: 'OLDER_PERIOD' })]);
    service.today = () => '2026-11-04';
  });

  it('fails the run (and alerts Super Admins) when no official site can be read', async () => {
    offline = true;
    const run = await runNow();
    offline = false;
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/No official source could be read/);
    expect((await notices(admin.me.user.id, 'JOB_FAILED')).map((n) => n.title)).toContain('Scheduled job auto-update failed');
  });
});
