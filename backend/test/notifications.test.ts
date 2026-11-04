import { randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { MAIL_SENDER, MemoryMailSender, SmtpMailSender } from '../src/notifications/mail';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ChangeSetsService } from '../src/registry/change-sets.service';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();
const monthStart = `${today.slice(0, 8)}01`;

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

describe('notifications, subscriptions and bulletins', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let checker2: Person;
  let viewer: { agent: Agent; me: Me };
  let follower: { agent: Agent; me: Me };
  let leaver: { agent: Agent; me: Me };
  let outbox: NotificationsService;
  let mail: MemoryMailSender;
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put' | 'delete', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const notices = async (p: { agent: Agent }, kind?: string) =>
    ((await p.agent.get('/api/notifications').expect(200)).body as { kind: string; title: string; body: string; link: string; readAt: string | null }[])
      .filter((n) => !kind || n.kind === kind);

  async function newSet(title: string) {
    return (await send(maker, 'post', '/api/change-sets', { title, justification: 'Test data' }).expect(201)).body.id as string;
  }
  async function item(setId: string, entityType: string, operation: string, after: object, entityId?: string): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation, after, entityId }).expect(200)).body;
    return entityId ?? (set.items[set.items.length - 1].entityId as string);
  }
  async function review(setId: string) {
    await send(maker, 'post', `/api/change-sets/${setId}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${setId}/start-review`).expect(200);
  }
  async function publish(setId: string): Promise<number> {
    await review(setId);
    return (await send(checker, 'post', `/api/change-sets/${setId}/approve`).expect(200)).body.versionNo as number;
  }
  const product = (overrides: object = {}) => ({
    groupId: ids.g1, itemNoAsPrinted: '1', nameId: 'Minyak Sawit Mentah', definition: 'CPO', classificationRegulationId: ids.reg, validFrom: '2024-01-01',
    parameters: [{ name: 'ALB', operator: '≤', valueText: '5', unit: '%', isPrimary: true }], hsCodes: [{ code: '1511.10.00' }], ...overrides,
  });
  const cpoLine = (bandValues: string[]) => ({
    scheduleId: ids.bk, uraian: 'Crude Palm Oil', itemNo: '1', productIds: [ids.cpo], validFrom: '2024-05-24', basisType: 'BAND_USD_PER_MT',
    bandTableId: ids.bands, refSeriesId: ids.cpoSeries, bandValues,
  });

  beforeAll(async () => {
    h = await startHarness();
    outbox = h.app.get(NotificationsService);
    mail = h.app.get<MemoryMailSender>(MAIL_SENDER);
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    checker2 = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    follower = await h.signedIn(['VIEWER']);
    leaver = await h.signedIn(['VIEWER']);

    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REGULATION', title: 'PMK 38/2024', officialUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-38-2024' })) req.field(k, v);
    const doc = (await req.attach('file', pdf(), { filename: 'pmk.pdf', contentType: 'application/pdf' }).expect(201)).body;
    const priceReq = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REF_PRICE_DECREE', title: 'HR CPO', officialUrl: 'https://jdih.kemendag.go.id/peraturan/hr-cpo' })) priceReq.field(k, v);
    const priceDoc = (await priceReq.attach('file', pdf(), { filename: 'hr.pdf', contentType: 'application/pdf' }).expect(201)).body;

    const set = await newSet('Base data');
    ids.reg = await item(set, 'REGULATION', 'CREATE', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE', effectiveOn: '2024-05-24',
      documents: [{ sourceDocumentId: doc.id, role: 'MAIN' }],
    });
    ids.palm = await item(set, 'COMMODITY', 'CREATE', { code: 'PALM', nameId: 'Kelapa sawit' });
    ids.g1 = await item(set, 'PRODUCT_GROUP', 'CREATE', { commodityId: ids.palm, code: 'I', label: 'Group I', ordinal: 1 });
    ids.g2 = await item(set, 'PRODUCT_GROUP', 'CREATE', { commodityId: ids.palm, code: 'II', label: 'Group II', ordinal: 2 });
    ids.cpo = await item(set, 'PRODUCT', 'CREATE', product());
    ids.kernel = await item(set, 'PRODUCT', 'CREATE', product({ groupId: ids.g2, nameId: 'Inti Sawit', hsCodes: [{ code: '1207.10.30' }] }));
    ids.cpoSeries = await item(set, 'REF_SERIES', 'CREATE', { code: 'CPO', name: 'Harga referensi CPO', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY' });
    await item(set, 'REF_VALUE', 'CREATE', { seriesId: ids.cpoSeries, periodFrom: monthStart, periodTo: addDays(today, 40), value: '950', sourceDocumentId: priceDoc.id });
    ids.bands = await item(set, 'BAND_TABLE', 'CREATE', {
      code: 'CPO-3', name: 'CPO', refSeriesId: ids.cpoSeries,
      bands: [{ lowerExclusive: null, upperInclusive: '680' }, { lowerExclusive: '680', upperInclusive: '1000' }, { lowerExclusive: '1000', upperInclusive: null }],
    });
    ids.bk = await item(set, 'SCHEDULE', 'CREATE', { regulationId: ids.reg, chargeType: 'BK', annexLabel: 'Lampiran I', commodityId: ids.palm });
    ids.line = await item(set, 'SCHEDULE_LINE', 'CREATE', cpoLine(['0', '33', '74']));
    ids.v1 = String(await publish(set));
    await outbox.sendDue();
    mail.sent.length = 0;
    for (const p of [maker, checker, checker2]) await send(p, 'post', '/api/notifications/read').expect(200);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('tells every other Checker when a set is submitted, and the Maker when it is rejected (US-29-P1 AC1, US-29-N2)', async () => {
    const set = await newSet('Rename CPO');
    await item(set, 'PRODUCT', 'UPDATE', product({ nameId: 'Minyak Sawit Mentah (CPO)' }), ids.cpo);
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);

    for (const c of [checker, checker2]) {
      const [n] = await notices(c, 'CHANGESET_SUBMITTED');
      expect(n).toMatchObject({ title: 'Change set waiting for review: Rename CPO', link: `/change-sets/${set}`, readAt: null });
    }
    expect(await notices(maker, 'CHANGESET_SUBMITTED')).toEqual([]);
    expect(await notices(viewer)).toEqual([]);
    expect((await checker.agent.get('/api/notifications/unread-count').expect(200)).body.unread).toBe(1);

    expect(await outbox.sendDue()).toEqual({ sent: 2, failed: 0 });
    const emails = mail.sent.filter((m) => m.subject === '[ECR] Change set waiting for review: Rename CPO');
    expect(emails.map((m) => m.to).sort()).toEqual([checker.me.user.email, checker2.me.user.email].sort());
    expect(emails[0].text).toContain(`Open in ECR: http://ecr.test/change-sets/${set}`);
    // US-48-N1 AC2: no draft data in emails.
    expect(emails[0].text).not.toContain('Minyak Sawit Mentah (CPO)');

    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/reject`, { comment: 'Use the gazette name' }).expect(200);
    const [rejected] = await notices(maker, 'CHANGESET_REJECTED');
    expect(rejected).toMatchObject({ title: 'Change set rejected: Rename CPO', link: `/change-sets/${set}` });
    expect(rejected.body).not.toContain('gazette');

    // Read state is per person.
    const id = ((await checker.agent.get('/api/notifications?unread=true').expect(200)).body as { id: string }[])[0].id;
    expect((await send(checker, 'post', '/api/notifications/read', { id }).expect(200)).body.unread).toBe(0);
    expect((await checker2.agent.get('/api/notifications/unread-count').expect(200)).body.unread).toBe(1);
    expect((await send(checker2, 'post', '/api/notifications/read').expect(200)).body.unread).toBe(0);
    await send(checker2, 'post', '/api/notifications/read', { id: 'nope' }).expect(400);
    await request(h.server).get('/api/notifications').expect(401);
    await send(maker, 'post', `/api/change-sets/${set}/discard`).expect(200);
  });

  it('tells followers of a commodity, group or product once per published version (US-48-P1, US-48-N1)', async () => {
    await send(viewer, 'post', '/api/subscriptions', { scopeType: 'PRODUCT_GROUP', scopeEntityId: ids.g1 }).expect(200);
    await send(follower, 'post', '/api/subscriptions', { scopeType: 'PRODUCT', scopeEntityId: ids.cpo }).expect(200);
    const subs = (await send(follower, 'post', '/api/subscriptions', { scopeType: 'COMMODITY', scopeEntityId: ids.palm }).expect(200)).body;
    expect(subs.map((s: { label: string }) => s.label)).toEqual(['1. Minyak Sawit Mentah', 'Kelapa sawit (PALM)']);
    // Subscribing twice changes nothing; unknown scopes are refused.
    expect((await send(follower, 'post', '/api/subscriptions', { scopeType: 'PRODUCT', scopeEntityId: ids.cpo }).expect(200)).body).toHaveLength(2);
    await send(follower, 'post', '/api/subscriptions', { scopeType: 'PRODUCT', scopeEntityId: ids.palm }).expect(404);
    await send(follower, 'post', '/api/subscriptions', { scopeType: 'HS_CODE', scopeEntityId: ids.cpo }).expect(400);
    await send(leaver, 'post', '/api/subscriptions', { scopeType: 'COMMODITY', scopeEntityId: ids.palm }).expect(200);
    await h.pool.query(`UPDATE ecr.app_user SET status = 'DEACTIVATED', deactivated_reason = 'Left the company' WHERE id = $1`, [leaver.me.user.id]);

    // A duty change on the CPO line: affects CPO (group I, palm).
    const set = await newSet('BK amounts for CPO');
    await item(set, 'SCHEDULE_LINE', 'UPDATE', cpoLine(['0', '35', '74']), ids.line);
    const v = await publish(set);

    const [forViewer] = await notices(viewer, 'VERSION_PUBLISHED');
    expect(forViewer).toMatchObject({ title: `Version ${v} published: BK amounts for CPO`, link: `/bulletins/${v}`, body: 'Published changes affect a product you follow: Minyak Sawit Mentah.' });
    // Two matching subscriptions, one notice.
    expect(await notices(follower, 'VERSION_PUBLISHED')).toHaveLength(1);
    const { rows: leaverRows } = await h.pool.query('SELECT count(*)::int AS n FROM ecr.notification WHERE user_id = $1', [leaver.me.user.id]);
    expect(leaverRows[0].n).toBe(0);
    expect((await notices(maker, 'CHANGESET_PUBLISHED'))[0].title).toBe(`Published as version ${v}: BK amounts for CPO`);

    await outbox.sendDue();
    const email = mail.sent.find((m) => m.to === follower.me.user.email && m.subject.startsWith(`[ECR] Version ${v}`))!;
    expect(email.text).toContain(`Open in ECR: http://ecr.test/bulletins/${v}`);
    expect(email.text).toMatch(/You follow 1\. Minyak Sawit Mentah\. Stop following it: http:\/\/ecr\.test\/unsubscribe\?token=[0-9a-f-]{36}\.[\w-]+/);
    expect(email.text).toMatch(/You follow Kelapa sawit \(PALM\)\. Stop following it:/);

    // A change in group II does not reach the group I follower.
    const other = await newSet('Kernel name');
    await item(other, 'PRODUCT', 'UPDATE', product({ groupId: ids.g2, nameId: 'Inti Sawit (kernel)', hsCodes: [{ code: '1207.10.30' }] }), ids.kernel);
    const v2 = await publish(other);
    expect((await notices(viewer, 'VERSION_PUBLISHED')).map((n) => n.link)).toEqual([`/bulletins/${v}`]);
    expect((await notices(follower, 'VERSION_PUBLISHED')).map((n) => n.link)).toEqual([`/bulletins/${v2}`, `/bulletins/${v}`]);

    // The bulletin shows what changed and the charge before and after, to anyone who can read the catalogue.
    const bulletin = (await viewer.agent.get(`/api/data-versions/${v}/bulletin`).expect(200)).body;
    expect(bulletin).toMatchObject({ versionNo: v, title: 'BK amounts for CPO', kind: 'NORMAL', items: [{ entityType: 'SCHEDULE_LINE', operation: 'UPDATE' }] });
    expect(bulletin.impact).toEqual([expect.objectContaining({
      product: 'Minyak Sawit Mentah', changed: true, bk: { before: expect.objectContaining({ usdPerMt: '33' }), after: expect.objectContaining({ usdPerMt: '35' }) },
    })]);
    await viewer.agent.get('/api/data-versions/999/bulletin').expect(404);
    ids.followerToken = /token=([^\s]+)/.exec(email.text)![1];
  });

  it('unsubscribes in one click from the email link, without signing in', async () => {
    await request(h.server).post('/api/subscriptions/unsubscribe').send({ token: `${ids.followerToken.split('.')[0]}.forged` }).expect(400);
    const res = await request(h.server).post('/api/subscriptions/unsubscribe').send({ token: ids.followerToken }).expect(200);
    expect(res.body).toEqual({ unsubscribed: true, label: '1. Minyak Sawit Mentah' });
    expect((await follower.agent.get('/api/subscriptions').expect(200)).body.map((s: { scopeType: string }) => s.scopeType)).toEqual(['COMMODITY']);
    // The same link again is harmless.
    await request(h.server).post('/api/subscriptions/unsubscribe').send({ token: ids.followerToken }).expect(200);
    const remaining = (await follower.agent.get('/api/subscriptions').expect(200)).body[0];
    expect((await send(follower, 'delete', `/api/subscriptions/${remaining.id}`).expect(200)).body).toEqual([]);
    await send(viewer, 'delete', `/api/subscriptions/${remaining.id}`).expect(404);
  });

  it('tells the Maker about scheduling and alerts once a day when a scheduled publication fails', async () => {
    const set = await newSet('Next month CPO amounts');
    await item(set, 'SCHEDULE_LINE', 'UPDATE', cpoLine(['0', '36', '74']), ids.line);
    await review(set);
    const later = addDays(today, 10);
    await send(checker, 'post', `/api/change-sets/${set}/approve`, { effectiveDate: later }).expect(200);
    expect((await notices(maker, 'CHANGESET_SCHEDULED'))[0].title).toBe(`Change set approved for ${later}: Next month CPO amounts`);

    // Something closed the line's current version meanwhile, so the job cannot publish the set.
    const { rows: [v] } = await h.pool.query<{ v: number }>('SELECT max(version_no) AS v FROM ecr.data_version');
    await h.pool.query('UPDATE ecr.schedule_line SET version_to = $2 WHERE entity_id = $1 AND version_to IS NULL', [ids.line, v.v]);
    const jobs = h.app.get(ChangeSetsService);
    const due = new Date(Date.now() + 11 * 86_400_000);
    expect((await jobs.publishDue(due)).failed).toEqual([set]);
    expect((await jobs.publishDue(due)).failed).toEqual([set]);
    for (const p of [checker, checker2, maker]) {
      const failed = await notices(p, 'CHANGESET_PUBLISH_FAILED');
      expect(failed).toHaveLength(1);
      expect(failed[0].body).toContain('stale');
    }
  });

  it('retries emails with back-off and never mails someone deactivated meanwhile', async () => {
    await outbox.sendDue();
    const set = await newSet('Retry check');
    await item(set, 'PRODUCT', 'UPDATE', product({ groupId: ids.g2, nameId: 'Inti Sawit', hsCodes: [{ code: '1207.10.30' }] }), ids.kernel);
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await h.pool.query(`UPDATE ecr.app_user SET status = 'DEACTIVATED', deactivated_reason = 'Left the company' WHERE id = $1`, [checker2.me.user.id]);
    mail.failNext = 1;
    expect(await outbox.sendDue()).toEqual({ sent: 0, failed: 1 });
    const { rows } = await h.pool.query<{ to_user_id: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(
      `SELECT o.to_user_id, o.status, o.attempts, o.last_error, o.next_attempt_at FROM ecr.email_outbox o
         JOIN ecr.notification n ON n.id = o.notification_id WHERE n.change_set_id = $1`, [set]);
    expect(rows.find((r) => r.to_user_id === checker2.me.user.id)).toMatchObject({ status: 'CANCELLED' });
    const pending = rows.find((r) => r.to_user_id === checker.me.user.id)!;
    expect(pending).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'SMTP relay unavailable' });
    expect(pending.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(await outbox.sendDue()).toEqual({ sent: 0, failed: 0 });
    expect(await outbox.sendDue(new Date(Date.now() + 2 * 60_000))).toEqual({ sent: 1, failed: 0 });
  });

  it('sends through an SMTP relay', async () => {
    const received: string[] = [];
    const server: Server = createServer((socket) => {
      let data = false;
      let buffer = '';
      socket.write('220 relay.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        let at: number;
        while ((at = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (data) {
            if (line === '.') {
              data = false;
              socket.write('250 queued\r\n');
            } else received.push(line);
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 relay.test\r\n');
          else if (cmd === 'DATA') {
            data = true;
            socket.write('354 go ahead\r\n');
          } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const smtp = new SmtpMailSender('ECR <no-reply@ecr.test>', { host: '127.0.0.1', port, secure: false, requireTls: false, user: null, password: null });
    await smtp.send({ to: 'someone@corp.example', subject: '[ECR] Test', text: 'Hello from ECR' });
    server.close();
    expect(received).toEqual(expect.arrayContaining(['Subject: [ECR] Test', 'To: someone@corp.example', 'Hello from ECR']));
  });
});
