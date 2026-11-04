import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, wibToday } from '../src/common/fields';
import { JobsService } from '../src/jobs/jobs.service';
import { SourceWatchService } from '../src/source-watch/source-watch.service';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const today = wibToday();

function pdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${randomBytes(16).toString('hex')}\n%%EOF\n`);
}

describe('scheduled jobs (Technical Design §4.2.7)', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let admin: Person;
  let userAdmin: Person;
  let auditor: Person;
  let viewer: { agent: Agent; me: Me };
  let jobs: JobsService;
  const ids: Record<string, string> = {};

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  async function item(setId: string, entityType: string, after: object): Promise<string> {
    const set = (await send(maker, 'put', `/api/change-sets/${setId}/items`, { entityType, operation: 'CREATE', after }).expect(200)).body;
    return set.items[set.items.length - 1].entityId as string;
  }
  const notices = async (p: { agent: Agent }, kind: string) =>
    ((await p.agent.get('/api/notifications').expect(200)).body as { kind: string; title: string; body: string; link: string }[]).filter((n) => n.kind === kind);
  const runs = async (name: string) => (await auditor.agent.get(`/api/jobs/${name}/runs`).expect(200)).body as { status: string; details: Record<string, unknown>; error: string | null }[];
  /** Runs one job through the API as the Super Admin. */
  const runNow = async (name: string) => (await send(admin, 'post', `/api/jobs/${name}/run`).expect(200)).body;

  beforeAll(async () => {
    h = await startHarness();
    jobs = h.app.get(JobsService);
    // The source watch reads official websites; here it gets one stand-in page for every address.
    h.app.get(SourceWatchService).fetcher = async () => ({
      status: 200,
      body: Buffer.from('<a href="/Details/1/pmk-no-1-tahun-2026">PMK No. 1 Tahun 2026</a> <a href="https://jdih.kemendag.go.id/peraturan/kepmendag-nomor-1-tahun-2026-tentang-harga-referensi-cpo">x</a>'),
    });
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    admin = await h.privileged(['SUPER_ADMIN']);
    userAdmin = await h.privileged(['USER_ADMIN']);
    auditor = await h.privileged(['AUDITOR']);
    viewer = await h.signedIn(['VIEWER']);

    const req = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'REGULATION', title: 'PMK 38/2024', officialUrl: 'https://jdih.kemenkeu.go.id/dok/pmk-38-2024' })) req.field(k, v);
    ids.doc = (await req.attach('file', pdf(), { filename: 'pmk.pdf', contentType: 'application/pdf' }).expect(201)).body.id;
    const fxReq = maker.agent.post('/api/source-documents').set('X-CSRF-Token', maker.me.csrfToken);
    for (const [k, v] of Object.entries({ docKind: 'FX_DECREE', title: 'KMK kurs', officialUrl: 'https://fiskal.kemenkeu.go.id/kurs-pajak' })) fxReq.field(k, v);
    const fxDoc = (await fxReq.attach('file', pdf(), { filename: 'kmk.pdf', contentType: 'application/pdf' }).expect(201)).body.id;

    const set = (await send(maker, 'post', '/api/change-sets', { title: 'Base data', justification: 'Test data' }).expect(201)).body.id;
    ids.reg = await item(set, 'REGULATION', {
      regType: 'PMK', number: '38', year: 2024, titleId: 'Bea keluar', issuer: 'Kementerian Keuangan', status: 'IN_FORCE', effectiveOn: '2024-05-24',
      documents: [{ sourceDocumentId: ids.doc, role: 'MAIN' }],
    });
    // The KMK rate only covers last week, so today has none.
    ids.fx = await item(set, 'REF_SERIES', { code: 'FX-USDIDR', name: 'Kurs Menteri Keuangan', kind: 'FX_RATE', unit: 'IDR/USD', cadence: 'WEEKLY' });
    await item(set, 'REF_VALUE', { seriesId: ids.fx, periodFrom: addDays(today, -10), periodTo: addDays(today, -4), value: '16250', sourceDocumentId: fxDoc });
    await send(maker, 'post', `/api/change-sets/${set}/submit`, { acknowledgeWarnings: true }).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/start-review`).expect(200);
    await send(checker, 'post', `/api/change-sets/${set}/approve`).expect(200);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('runs each due job once, by its WIB time or interval', async () => {
    const now = new Date();
    expect((await jobs.tick(now)).sort()).toEqual(['access-review', 'audit-chain-verify', 'dormancy', 'dq-nightly', 'jwks-refresh', 'ref-gap-check', 'session-sweep', 'source-watch']);
    expect(await jobs.tick(now)).toEqual([]);
    expect(await jobs.tick(new Date(now.getTime() + 16 * 60_000))).toEqual(['session-sweep']);
    // 08:00 WIB the next day: every daily job is due again, and more than 6 h have passed for jwks-refresh.
    const tomorrow = new Date(`${addDays(today, 1)}T08:00:00+07:00`);
    expect((await jobs.tick(tomorrow)).sort()).toEqual(['access-review', 'audit-chain-verify', 'dormancy', 'dq-nightly', 'jwks-refresh', 'ref-gap-check', 'session-sweep', 'source-watch']);

    const list = (await auditor.agent.get('/api/jobs').expect(200)).body;
    expect(list.map((j: { name: string; schedule: string }) => `${j.name} ${j.schedule}`)).toEqual([
      'dq-nightly Daily 01:00 WIB', 'dormancy Daily 01:30 WIB', 'audit-chain-verify Daily 03:30 WIB', 'source-watch Daily 06:00 WIB', 'ref-gap-check Daily 07:00 WIB', 'access-review Daily 08:00 WIB',
      'jwks-refresh Every 6 h', 'session-sweep Every 15 min',
    ]);
    expect(list.find((j: { name: string }) => j.name === 'jwks-refresh').lastRun).toMatchObject({ status: 'OK', details: { keys: 1, usable: 1 } });
    await viewer.agent.get('/api/jobs').expect(403);
  });

  it('warns when no reference value covers today (US-27-N2)', async () => {
    const [run] = await runs('ref-gap-check');
    expect(run).toMatchObject({ status: 'OK', details: { checked: 1, missing: [{ code: 'FX-USDIDR', latestPeriodTo: addDays(today, -4) }] } });
    for (const p of [maker, checker]) {
      const [n] = await notices(p, 'REFERENCE_GAP');
      expect(n).toMatchObject({ title: 'No published value for today: FX-USDIDR', link: '/prices' });
    }
    expect(await notices(viewer, 'REFERENCE_GAP')).toEqual([]);
  });

  it('checks the published data every night and shows the findings to Makers and Checkers (US-51-P1)', async () => {
    expect((await runs('dq-nightly'))[0]).toMatchObject({ status: 'OK', details: { errors: 0 } });
    // The official PDF no longer matches what the weekly re-check downloaded.
    await h.pool.query('UPDATE ecr.source_document SET recheck_mismatch = true WHERE id = $1', [ids.doc]);
    const run = await runNow('dq-nightly');
    expect(run).toMatchObject({ status: 'OK', details: { errors: 1 } });
    const dq = (await maker.agent.get('/api/dq/findings').expect(200)).body;
    expect(dq.run).toMatchObject({ id: run.id, errors: 1 });
    expect(dq.findings).toContainEqual(expect.objectContaining({ ruleCode: 'SRC-HASH', severity: 'ERROR', label: 'PMK 38/2024', link: `/regulations/${ids.reg}` }));
    expect((await notices(checker, 'DQ_ERRORS'))[0]).toMatchObject({ link: '/data-quality' });
    await viewer.agent.get('/api/dq/findings').expect(403);
  });

  it('warns dormant accounts at day 80 and disables them at day 90, keeping two Super Admins (BR-IAM-11)', async () => {
    const quiet = await h.signedIn(['VIEWER']);
    const gone = await h.signedIn(['VIEWER']);
    const age = (id: string, days: number) => h.pool.query(
      `UPDATE ecr.app_user SET created_at = now() - make_interval(days => $2), last_login_at = now() - make_interval(days => $2) WHERE id = $1`, [id, days]);
    await age(quiet.me.user.id, 85);
    await age(gone.me.user.id, 95);
    // The only Super Admin would be disabled too, but SoD-4 keeps them.
    await age(admin.me.user.id, 120);

    const run = await runNow('dormancy');
    expect(run.details).toMatchObject({ warned: 1, disabled: 1, skippedSuperAdmins: 1 });
    const [warning] = await notices(quiet, 'DORMANCY_WARNING');
    expect(warning.title).toMatch(/^Your ECR account will be disabled on \d{4}-\d{2}-\d{2}$/);
    const { rows: [g] } = await h.pool.query('SELECT status, deactivated_reason FROM ecr.app_user WHERE id = $1', [gone.me.user.id]);
    expect(g).toEqual({ status: 'DORMANT_DISABLED', deactivated_reason: 'No sign-in for 90 days' });
    await gone.agent.get('/api/auth/me').expect(401);
    expect((await h.signIn(request.agent(h.server), { sub: (await h.pool.query('SELECT subject FROM ecr.user_identity WHERE user_id = $1', [gone.me.user.id])).rows[0].subject, email: gone.me.user.email, name: 'Gone' })).res.headers.location)
      .toContain('LOGIN_BLOCKED');
    expect(await h.auditActions(gone.me.user.id)).toContain('USER_DORMANT_DISABLED');

    // Warned once, not every night.
    expect((await runNow('dormancy')).details).toMatchObject({ warned: 0, disabled: 0 });
    expect(await notices(quiet, 'DORMANCY_WARNING')).toHaveLength(1);

    // A User Admin reactivates the account; the 90 days start again.
    await send(userAdmin, 'post', `/api/admin/users/${gone.me.user.id}/reactivate`, { reason: 'Back from leave' }).expect(200);
    expect((await runNow('dormancy')).details).toMatchObject({ disabled: 0 });
    expect((await h.pool.query('SELECT status FROM ecr.app_user WHERE id = $1', [gone.me.user.id])).rows[0].status).toBe('ACTIVE');
    await age(admin.me.user.id, 0);
  });

  it('ends expired sessions and deletes old sign-in states', async () => {
    const stale = await h.signedIn(['VIEWER']);
    await h.pool.query(`UPDATE ecr.user_session SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [stale.me.session.id]);
    await h.pool.query(`UPDATE ecr.oidc_login_state SET expires_at = now() - interval '1 minute'`);
    const run = await runNow('session-sweep');
    expect(run.details.sessionsEnded).toBeGreaterThanOrEqual(1);
    const { rows: [s] } = await h.pool.query('SELECT revoke_reason FROM ecr.user_session WHERE id = $1', [stale.me.session.id]);
    expect(s.revoke_reason).toBe('EXPIRED');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM ecr.oidc_login_state')).rows[0].n).toBe(0);
  });

  it('lets only a Super Admin with a fresh code run a job now', async () => {
    await send(auditor, 'post', '/api/jobs/session-sweep/run').expect(403);
    await h.expireStepUp(admin.me.session.id);
    expect((await send(admin, 'post', '/api/jobs/session-sweep/run').expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    await send(admin, 'post', '/api/auth/step-up', { code: h.nextCode(admin.secret) }).expect(200);
    await send(admin, 'post', '/api/jobs/no-such-job/run').expect(404);
    const run = await runNow('session-sweep');
    expect(run).toMatchObject({ status: 'OK', triggeredBy: expect.any(String) });
    expect(await h.auditActions(admin.me.user.id)).toContain('JOB_RUN_REQUESTED');
  });

  it('raises a critical alert when the audit hash chain is broken (US-50-N1 AC2)', async () => {
    expect((await runNow('audit-chain-verify')).details).toMatchObject({ intact: true });
    await h.pool.query('ALTER TABLE ecr.audit_event DISABLE TRIGGER USER');
    await h.pool.query(`UPDATE ecr.audit_event SET reason = 'tampered' WHERE chain_seq = 3`);
    await h.pool.query('ALTER TABLE ecr.audit_event ENABLE TRIGGER USER');
    const run = await runNow('audit-chain-verify');
    expect(run).toMatchObject({ status: 'FAILED', error: 'Audit hash chain broken at event 3', details: { intact: false, brokenAtChainSeq: 3 } });
    for (const p of [admin, auditor]) {
      expect((await notices(p, 'AUDIT_CHAIN_BROKEN'))[0].title).toBe('CRITICAL: the audit trail was altered at event 3');
    }
    expect(await notices(checker, 'AUDIT_CHAIN_BROKEN')).toEqual([]);
  });
});
