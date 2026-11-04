import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { addDays, wibToday } from '../src/common/fields';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

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

describe('audit log search and export (US-50-P1)', () => {
  let h: Harness;
  let auditor: Person;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  const today = wibToday();

  const search = async (query: string) => (await auditor.agent.get(`/api/audit-events?${query}`).expect(200)).body.items as {
    chainSeq: number; action: string; actorKind: string; actorEmail: string | null; actorName: string | null; reason: string | null; entityId: string | null;
  }[];

  beforeAll(async () => {
    h = await startHarness();
    auditor = await h.privileged(['AUDITOR']);
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    await maker.agent.post('/api/change-sets').set('X-CSRF-Token', maker.me.csrfToken).send({ title: 'Audit trail check', justification: 'Test' }).expect(201);
    const audit = h.app.get(AuditService);
    await audit.record(h.pool, { action: 'TEST_SYSTEM_EVENT', actorKind: 'SYSTEM', entityType: 'JOB', entityId: 'session-sweep' });
    await audit.record(h.pool, {
      action: 'TEST_REASON', actorKind: 'USER', actorUserId: checker.me.user.id, entityType: 'CHANGE_SET', entityId: 'x', reason: '=HYPERLINK("http://evil")',
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('searches by actor name or email, several actions, entity and WIB dates', async () => {
    const mine = await search(`actor=${encodeURIComponent(maker.me.user.email.split('@')[0])}`);
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((e) => e.actorEmail))).toEqual(new Set([maker.me.user.email]));
    expect(mine.map((e) => e.action)).toContain('CHANGESET_CREATED');
    const { rows: [name] } = await h.pool.query('SELECT full_name FROM ecr.app_user WHERE id = $1', [maker.me.user.id]);
    expect(mine[0].actorName).toBe(name.full_name);

    const system = await search('actor=system');
    expect(system.map((e) => e.action)).toEqual(['TEST_SYSTEM_EVENT']);

    const two = await search('action=TEST_SYSTEM_EVENT,TEST_REASON');
    expect(two.map((e) => e.action)).toEqual(['TEST_REASON', 'TEST_SYSTEM_EVENT']);
    expect(await search('entityType=JOB&entityId=session-sweep')).toHaveLength(1);

    // A date is a whole WIB day.
    expect((await search(`action=TEST_REASON&from=${today}&to=${today}`))).toHaveLength(1);
    expect(await search(`action=TEST_REASON&to=${addDays(today, -1)}`)).toEqual([]);
    expect(await search(`action=TEST_REASON&from=${addDays(today, 1)}`)).toEqual([]);
    await auditor.agent.get('/api/audit-events?from=yesterday').expect(400);

    const facets = (await auditor.agent.get('/api/audit-events/facets').expect(200)).body;
    expect(facets.actions).toContainEqual({ value: 'TEST_REASON', count: 1 });
    expect(facets.entityTypes).toContainEqual({ value: 'JOB', count: 1 });
    await viewer.agent.get('/api/audit-events/facets').expect(403);
  });

  it('exports the filtered log with the hash-chain status, neutralising formula text', async () => {
    const res = await auditor.agent.get(`/api/audit-events/export?format=csv&from=${today}`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ecr-audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (res.body as Buffer).toString('utf8').slice(1);
    expect(text).toMatch(/\r\nHash chain,"?Intact: all [\d,]+ events verified \d{4}-\d{2}-\d{2} \d{2}:\d{2} WIB"?\r\n/);
    expect(text).toContain(`Filters,from ${today}\r\n`);
    expect(text).toContain(`<${auditor.me.user.email}>`);
    expect(text).toContain('Event,Time (WIB),Actor kind,Actor,Actor email,Action,Entity type,Entity id,Reason,IP,User agent,Session,Before,After,Hash');
    expect(text).toContain(`,"'=HYPERLINK(""http://evil"")",`);
    // Oldest first, as the chain runs.
    const seqs = text.split('\r\n').filter((l) => /^\d+,/.test(l)).map((l) => Number(l.split(',')[0]));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(await h.auditActions(auditor.me.user.id)).toContain('AUDIT_EXPORTED');

    const xlsx = await auditor.agent.get('/api/audit-events/export?format=xlsx&action=TEST_REASON').buffer(true).parse(binary).expect(200);
    expect(sheetXml(xlsx.body as Buffer)).toContain('<t xml:space="preserve">TEST_REASON</t>');
    await auditor.agent.get('/api/audit-events/export?format=pdf').expect(400);
    // Reading is not exporting: Checkers have neither; Auditors and Super Admins have both.
    await checker.agent.get('/api/audit-events/export?format=csv').expect(403);
    await viewer.agent.get('/api/audit-events/export?format=csv').expect(403);
  });

  it('says so in the export when the chain is broken', async () => {
    await h.pool.query('ALTER TABLE ecr.audit_event DISABLE TRIGGER USER');
    await h.pool.query(`UPDATE ecr.audit_event SET reason = 'tampered' WHERE chain_seq = 2`);
    await h.pool.query('ALTER TABLE ecr.audit_event ENABLE TRIGGER USER');
    expect((await auditor.agent.get('/api/audit-events/verify').expect(200)).body).toMatchObject({ intact: false, brokenAtChainSeq: 2 });
    const res = await auditor.agent.get('/api/audit-events/export?format=csv&action=TEST_REASON').buffer(true).parse(binary).expect(200);
    expect((res.body as Buffer).toString('utf8')).toMatch(/Hash chain,"?BROKEN at event 2: verified [^\r]+; treat as a security incident"?\r\n/);
  });
});
