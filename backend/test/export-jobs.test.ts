import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, AppConfig } from '../src/config';
import { ExportJobsService } from '../src/exports/export-jobs.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { Agent, Harness, Me, Person, startHarness } from './harness';

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

function sheetXml(xlsx: Buffer): string {
  let at = 0;
  while (xlsx.readUInt32LE(at) === 0x04034b50) {
    const size = xlsx.readUInt32LE(at + 18);
    const nameLength = xlsx.readUInt16LE(at + 26);
    const start = at + 30 + nameLength + xlsx.readUInt16LE(at + 28);
    if (xlsx.toString('utf8', at + 30, at + 30 + nameLength) === 'xl/worksheets/sheet1.xml') return inflateRawSync(xlsx.subarray(start, start + size)).toString('utf8');
    at = start + size;
  }
  throw new Error('no sheet');
}

const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('asynchronous catalogue exports (US-47-N1 AC3)', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  let other: { agent: Agent; me: Me };
  let jobs: ExportJobsService;
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  async function item(setId: string, entityType: string, operation: string, after: object, entityId?: string): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation, after, entityId }).expect(200)).body;
    return entityId ?? (set.items[set.items.length - 1].entityId as string);
  }
  async function publish(setId: string): Promise<number> {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
    return (await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200)).body.versionNo as number;
  }
  const newSet = async (title: string) => (await send(maker, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201)).body.id as string;
  const product = (nameId: string, itemNo: string, code: string) => ({
    groupId: ids.g1, itemNoAsPrinted: itemNo, nameId, definition: nameId, classificationRegulationId: ids.reg, validFrom: '2024-01-01',
    parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code }],
  });
  const download = (p: { agent: Agent }, path: string) => p.agent.get(path).buffer(true).parse(binary);

  beforeAll(async () => {
    h = await startHarness({ EXPORT_ASYNC_THRESHOLD: '2' });
    jobs = h.app.get(ExportJobsService);
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    other = await h.signedIn(['VIEWER']);

    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REGULATION', title: 'PMK 38/2024', officialUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-38-2024' })) req.field(k, v);
    const doc = (await req.attach('file', pdf(), { filename: 'pmk.pdf', contentType: 'application/pdf' }).expect(201)).body;
    const set = await newSet('Base data');
    ids.reg = await item(set, 'REGULATION', 'CREATE', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE', effectiveOn: '2024-05-24',
      documents: [{ sourceDocumentId: doc.id, role: 'MAIN' }],
    });
    const palm = await item(set, 'COMMODITY', 'CREATE', { code: 'PALM', nameId: 'Kelapa sawit' });
    ids.g1 = await item(set, 'PRODUCT_GROUP', 'CREATE', { commodityId: palm, code: 'I', label: 'Group I', ordinal: 1 });
    ids.cpo = await item(set, 'PRODUCT', 'CREATE', product('Minyak Sawit Mentah', '1', '1511.10.00'));
    await item(set, 'PRODUCT', 'CREATE', product('Olein Sawit', '2', '1511.90.36'));
    await item(set, 'PRODUCT', 'CREATE', product('Inti Sawit', '3', '1207.10.30'));
    ids.v1 = String(await publish(set));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('points an export above the limit to a job, and keeps small ones synchronous', async () => {
    const tooLarge = (await viewer.agent.get('/api/exports/catalogue?format=csv').expect(422)).body.error;
    expect(tooLarge).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { rows: 3, limit: 2, jobUrl: '/api/exports/jobs' } });
    await download(viewer, '/api/exports/catalogue?format=csv&q=olein').expect(200);
  });

  it('builds the file in the background at the version asked for and tells the requester only', async () => {
    const job = (await send(viewer, 'post', '/api/exports/jobs', { format: 'xlsx', query: { sort: 'name', page: '9' } }).expect(201)).body;
    expect(job).toMatchObject({ status: 'QUEUED', format: 'xlsx', versionNo: Number(ids.v1), rowCount: null });
    expect((await viewer.agent.get(`/api/exports/jobs/${job.id}/file`).expect(409)).body.error.code).toBe('EXPORT_NOT_READY');
    await other.agent.get(`/api/exports/jobs/${job.id}`).expect(404);

    // Data published after the request does not change the file.
    const rename = await newSet('Rename CPO');
    await item(rename, 'PRODUCT', 'UPDATE', product('Minyak Sawit Mentah (CPO)', '1', '1511.10.00'), ids.cpo);
    await publish(rename);

    expect(await jobs.runDue()).toEqual({ ready: [job.id], failed: [] });
    const ready = (await viewer.agent.get(`/api/exports/jobs/${job.id}`).expect(200)).body;
    expect(ready).toMatchObject({ status: 'READY', rowCount: 3, fileName: `ecr-catalogue-${ready.date}-v${ids.v1}.xlsx` });
    const hours = (new Date(ready.expiresAt).getTime() - new Date(ready.finishedAt).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);

    const [notice] = (await viewer.agent.get('/api/notifications').expect(200)).body;
    expect(notice).toMatchObject({ kind: 'EXPORT_READY', title: 'Your catalogue export is ready (3 rows)', link: `/exports/${job.id}` });
    const { rows: [mail] } = await h.pool.query('SELECT to_email, body_text FROM ecr.email_outbox WHERE to_user_id = $1', [viewer.me.user.id]);
    expect(mail.to_email).toBe(viewer.me.user.email);
    expect(mail.body_text).toContain(`Open in ECR: http://ecr.test/exports/${job.id}`);
    expect(mail.body_text).not.toContain('Minyak');

    const file = await download(viewer, `/api/exports/jobs/${job.id}/file`).expect(200);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${ready.fileName}"`);
    const sheet = sheetXml(file.body as Buffer);
    expect(sheet).toContain('<t xml:space="preserve">Minyak Sawit Mentah</t>');
    expect(sheet).not.toContain('(CPO)');
    expect(sheet).toContain(`<t xml:space="preserve">${ids.v1}, published`);
    await other.agent.get(`/api/exports/jobs/${job.id}/file`).expect(404);
    expect(await h.auditActions(job.id)).toEqual(['EXPORT_REQUESTED', 'EXPORT_GENERATED', 'EXPORT_DOWNLOADED']);
    expect((await viewer.agent.get('/api/exports/jobs').expect(200)).body.map((j: { id: string }) => j.id)).toEqual([job.id]);
    ids.job = job.id;
  });

  it('removes the file after 24 hours and keeps the record', async () => {
    const { storageDir } = h.app.get<AppConfig>(APP_CONFIG);
    const { rows: [row] } = await h.pool.query('SELECT object_key FROM ecr.export_job WHERE id = $1', [ids.job]);
    expect(existsSync(join(storageDir, row.object_key))).toBe(true);
    await h.pool.query(`UPDATE ecr.export_job SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ids.job]);
    expect((await viewer.agent.get(`/api/exports/jobs/${ids.job}/file`).expect(410)).body.error.code).toBe('EXPORT_EXPIRED');
    expect((await viewer.agent.get(`/api/exports/jobs/${ids.job}`).expect(200)).body.status).toBe('EXPIRED');
    expect(await jobs.purgeExpired()).toBe(1);
    expect(existsSync(join(storageDir, row.object_key))).toBe(false);
    expect((await viewer.agent.get(`/api/exports/jobs/${ids.job}`).expect(200)).body.status).toBe('EXPIRED');
  });

  it('limits open jobs per person, refuses bad requests and reports failures', async () => {
    await send(viewer, 'post', '/api/exports/jobs', { format: 'pdf', query: {} }).expect(400);
    const nobody = await h.signedIn([]);
    await send(nobody, 'post', '/api/exports/jobs', { format: 'csv', query: {} }).expect(403);

    const queued: string[] = [];
    for (let i = 0; i < 3; i++) queued.push((await send(other, 'post', '/api/exports/jobs', { format: 'csv', query: {} }).expect(201)).body.id);
    expect((await send(other, 'post', '/api/exports/jobs', { format: 'csv', query: {} }).expect(429)).body.error.code).toBe('EXPORT_QUEUE_FULL');

    // A job whose query cannot run fails once, and the requester is told.
    await h.pool.query(`UPDATE ecr.export_job SET query = jsonb_set(query, '{versionNo}', '999') WHERE id = $1`, [queued[0]]);
    const run = await jobs.runDue();
    expect(run).toEqual({ ready: [queued[1], queued[2]], failed: [queued[0]] });
    expect((await other.agent.get(`/api/exports/jobs/${queued[0]}`).expect(200)).body).toMatchObject({ status: 'FAILED', error: expect.stringContaining('999') });
    const failed = (await other.agent.get('/api/notifications').expect(200)).body.filter((n: { kind: string }) => n.kind === 'EXPORT_FAILED');
    expect(failed).toHaveLength(1);
    await send(other, 'post', '/api/exports/jobs', { format: 'csv', query: {} }).expect(201);
    await h.app.get(NotificationsService).sendDue();
  });
});
