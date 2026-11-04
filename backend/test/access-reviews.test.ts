import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessReviewsService, periodOf } from '../src/access-reviews/access-reviews.service';
import { wibToday } from '../src/common/fields';
import { Agent, Harness, Me, Person, startHarness } from './harness';

interface Item {
  id: string;
  userId: string;
  role: string;
  reviewerRole: string;
  decision: string | null;
  escalatedAt: string | null;
  canDecide: boolean;
}

describe('access reviews (PRD F-12, L2-1.9)', () => {
  let h: Harness;
  let admin: Person;
  let admin2: Person;
  let userAdmin: Person;
  let auditor: Person;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  let campaignId: string;

  const send = (p: { agent: Agent; me: Me }, method: 'post' | 'put', path: string, body: object = {}) =>
    p.agent[method](path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const notices = async (p: { agent: Agent }, kind: string) =>
    ((await p.agent.get('/api/notifications').expect(200)).body as { kind: string; title: string; link: string }[]).filter((n) => n.kind === kind);
  const campaign = async (p: { agent: Agent } = userAdmin) =>
    (await p.agent.get(`/api/admin/reviews/${campaignId}`).expect(200)).body as { status: string; items: Item[]; report: Record<string, string> | null };
  const itemOf = async (userId: string, role: string) => (await campaign()).items.find((i) => i.userId === userId && i.role === role)!;
  const decide = (p: Person, itemId: string, decision: string, reason?: string) =>
    send(p, 'post', `/api/admin/reviews/${campaignId}/items/${itemId}`, { decision, reason });

  beforeAll(async () => {
    h = await startHarness();
    admin = await h.privileged(['SUPER_ADMIN']);
    admin2 = await h.privileged(['SUPER_ADMIN']);
    userAdmin = await h.privileged(['USER_ADMIN']);
    auditor = await h.privileged(['AUDITOR']);
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER', 'MAKER']);
    viewer = await h.signedIn(['VIEWER']);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('opens one campaign a quarter with every live role assignment', async () => {
    const run = (await send(admin, 'post', '/api/jobs/access-review/run').expect(200)).body;
    expect(run).toMatchObject({ status: 'OK', details: { period: periodOf(wibToday()), escalated: 0 } });
    campaignId = run.details.started.id;
    const { rows: [live] } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ecr.user_role WHERE revoked_at IS NULL');
    expect(run.details.started.items).toBe(live.n);

    // Running again in the same quarter does not open a second one.
    expect((await send(admin, 'post', '/api/jobs/access-review/run').expect(200)).body.details.started).toBeNull();

    const c = await campaign();
    expect(c.status).toBe('OPEN');
    // BR-IAM-02: administrators' assignments go to a Super Admin; everyone else's to User Admins.
    expect((await itemOf(userAdmin.me.user.id, 'USER_ADMIN')).reviewerRole).toBe('SUPER_ADMIN');
    expect((await itemOf(admin.me.user.id, 'SUPER_ADMIN')).reviewerRole).toBe('SUPER_ADMIN');
    expect((await itemOf(maker.me.user.id, 'MAKER')).reviewerRole).toBe('USER_ADMIN');
    expect((await itemOf(maker.me.user.id, 'MAKER')).canDecide).toBe(true);
    expect((await itemOf(admin.me.user.id, 'SUPER_ADMIN')).canDecide).toBe(false);

    const [notice] = await notices(userAdmin, 'ACCESS_REVIEW_OPEN');
    expect(notice.link).toBe(`/admin/reviews/${campaignId}`);
    const list = (await auditor.agent.get('/api/admin/reviews').expect(200)).body;
    expect(list[0]).toMatchObject({ id: campaignId, status: 'OPEN', items: live.n, decided: 0, waitingForYou: 0 });
    expect((await userAdmin.agent.get('/api/admin/reviews').expect(200)).body[0].waitingForYou).toBeGreaterThan(0);
    await viewer.agent.get('/api/admin/reviews').expect(403);
    await maker.agent.get(`/api/admin/reviews/${campaignId}`).expect(403);
  });

  it('enforces who may decide (SoD-3, BR-IAM-02) and needs a fresh step-up', async () => {
    const own = await itemOf(userAdmin.me.user.id, 'USER_ADMIN');
    expect((await decide(userAdmin, own.id, 'KEEP').expect(403)).body.error.code).toBe('SOD_VIOLATION');
    const superItem = await itemOf(admin.me.user.id, 'SUPER_ADMIN');
    expect((await decide(userAdmin, superItem.id, 'KEEP').expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await decide(admin, superItem.id, 'KEEP').expect(403)).body.error.code).toBe('SOD_VIOLATION');
    await decide(auditor, superItem.id, 'KEEP').expect(403);

    const makerItem = await itemOf(maker.me.user.id, 'MAKER');
    expect((await decide(userAdmin, makerItem.id, 'REVOKE').expect(400)).body.error.code).toBe('INVALID_INPUT');
    await h.expireStepUp(userAdmin.me.session.id);
    expect((await decide(userAdmin, makerItem.id, 'KEEP').expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    await send(userAdmin, 'post', '/api/auth/step-up', { code: h.nextCode(userAdmin.secret) }).expect(200);
  });

  it('revokes a role at once and ends the user’s sessions', async () => {
    const makerItem = await itemOf(maker.me.user.id, 'MAKER');
    const res = (await decide(userAdmin, makerItem.id, 'REVOKE', 'Moved to another team').expect(200)).body;
    expect(res.closed).toBe(false);
    expect(res.items.find((i: Item) => i.id === makerItem.id)).toMatchObject({ decision: 'REVOKE', reason: 'Moved to another team' });
    await maker.agent.get('/api/auth/me').expect(401);
    const user = (await userAdmin.agent.get(`/api/admin/users/${maker.me.user.id}`).expect(200)).body;
    expect(user.roles).toEqual([]);
    expect(await h.auditActions(maker.me.user.id)).toEqual(expect.arrayContaining(['ROLES_CHANGED']));
    expect(await h.auditActions(campaignId)).toEqual(expect.arrayContaining(['ACCESS_REVIEW_STARTED', 'ACCESS_REVIEW_DECIDED']));
    expect((await decide(userAdmin, makerItem.id, 'KEEP').expect(409)).body.error.code).toBe('ALREADY_DECIDED');

    // A role removed elsewhere since the campaign started can only be recorded as revoked.
    await send(userAdmin, 'put', `/api/admin/users/${checker.me.user.id}/roles`, { roles: ['CHECKER'], reason: 'Not a maker any more' }).expect(200);
    const gone = await itemOf(checker.me.user.id, 'MAKER');
    expect((await decide(userAdmin, gone.id, 'KEEP').expect(409)).body.error.code).toBe('ROLE_ALREADY_REVOKED');
    expect((await decide(userAdmin, gone.id, 'REVOKE', 'Already removed').expect(200)).body.closed).toBe(false);
  });

  it('escalates assignments not reviewed in 14 days to Super Admins', async () => {
    const reviews = h.app.get(AccessReviewsService);
    expect(await reviews.escalate(new Date(Date.now() + 13 * 86_400_000))).toBe(0);
    const open = (await campaign()).items.filter((i) => !i.decision).length;
    expect(await reviews.escalate(new Date(Date.now() + 15 * 86_400_000))).toBe(open);
    expect(await reviews.escalate(new Date(Date.now() + 16 * 86_400_000))).toBe(0);
    expect((await campaign()).items.filter((i) => i.escalatedAt).length).toBe(open);
    const [notice] = await notices(admin, 'ACCESS_REVIEW_ESCALATED');
    expect(notice.title).toContain(`${open} assignment`);
    expect(await notices(userAdmin, 'ACCESS_REVIEW_ESCALATED')).toEqual([]);
  });

  it('closes on the last decision with a signed report for auditors', async () => {
    await auditor.agent.get(`/api/admin/reviews/${campaignId}/report`).expect(409);
    const open = (await campaign(admin)).items.filter((i) => !i.decision);
    let last: { closed: boolean } = { closed: false };
    for (const i of open) {
      const reviewer = i.userId === admin.me.user.id ? admin2 : admin;
      last = (await decide(reviewer, i.id, 'KEEP').expect(200)).body;
    }
    expect(last.closed).toBe(true);

    const c = await campaign(auditor);
    expect(c.status).toBe('CLOSED');
    expect(c.report).toMatchObject({ contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/), signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const file = await auditor.agent.get(`/api/admin/reviews/${campaignId}/report`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    const pdf = (file.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('pdfaid:part');
    expect((await auditor.agent.get(`/api/admin/reviews/${campaignId}/report/verify`).expect(200)).body)
      .toMatchObject({ valid: true, fileIntact: true, contentIntact: true, signatureValid: true });
    expect(await notices(auditor, 'ACCESS_REVIEW_COMPLETED')).toHaveLength(1);
    expect(await h.auditActions(campaignId)).toEqual(expect.arrayContaining(['ACCESS_REVIEW_COMPLETED', 'ACCESS_REVIEW_REPORT_DOWNLOADED']));
    expect((await decide(admin, open[0].id, 'REVOKE', 'Too late').expect(409)).body.error.code).toBe('REVIEW_CLOSED');

    // Changing the stored record breaks the content hash.
    await h.pool.query(`UPDATE ecr.access_review_campaign SET report_payload = jsonb_set(report_payload, '{totals,revoked}', '0') WHERE id = $1`, [campaignId]);
    expect((await auditor.agent.get(`/api/admin/reviews/${campaignId}/report/verify`).expect(200)).body)
      .toMatchObject({ valid: false, fileIntact: true, contentIntact: false, signatureValid: true });
  });
});
