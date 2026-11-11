import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, Harness, Me, startHarness } from './harness';

type Person = { agent: Agent; me: Me };
type Matrix = { pages: { key: string; levels: { key: string }[] }[]; roles: { code: string; access: Record<string, string>; locked: Record<string, string> }[] };

describe('page access by role (Users → Roles and access)', () => {
  let h: Harness;
  let superAdmin: Person;
  let userAdmin: Person;

  const put = (p: Person, path: string, body: object) => p.agent.put(path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  const matrix = async (p: Person) => (await p.agent.get('/api/admin/roles/access').expect(200)).body as Matrix;
  const levels = async (code: string) => (await matrix(superAdmin)).roles.find((r) => r.code === code)!.access;

  beforeAll(async () => {
    // Authenticator off, as in production, so the matrix is exercised on its own.
    h = await startHarness({ TOTP_REQUIRED: 'false' });
    superAdmin = await h.signedIn(['SUPER_ADMIN']);
    userAdmin = await h.signedIn(['USER_ADMIN']);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('shows every role with the pages it can open today', async () => {
    const m = await matrix(superAdmin);
    expect(m.pages.map((p) => p.key)).toContain('catalogue');
    expect(await levels('VIEWER')).toMatchObject({ catalogue: 'VIEW', find: 'VIEW', calculator: 'EDIT', policy_history: 'VIEW', exports: 'EDIT', changesets: 'NONE', users: 'NONE', audit: 'NONE' });
    expect(await levels('MAKER')).toMatchObject({ changesets: 'ENTER', sources: 'EDIT', imports: 'EDIT', source_watch: 'VIEW' });
    expect(await levels('CHECKER')).toMatchObject({ changesets: 'APPROVE', data_quality: 'VIEW' });
    expect(await levels('AUDITOR')).toMatchObject({ audit: 'EDIT', jobs: 'VIEW', changesets: 'VIEW' });
    expect(m.roles.find((r) => r.code === 'SUPER_ADMIN')).toMatchObject({ access: { users: 'EDIT', settings: 'EDIT' }, locked: { users: 'EDIT', settings: 'EDIT' } });
    // User Admins can read the matrix but not change it.
    await matrix(userAdmin);
    await put(userAdmin, '/api/admin/roles/VIEWER/access', { access: { find: 'NONE' }, reason: 'Not allowed' }).expect(403);
  });

  it('closes and reopens pages for a role, at once and audited', async () => {
    const viewer = await h.signedIn(['VIEWER']);
    await viewer.agent.post('/api/calculations/preview').set('X-CSRF-Token', viewer.me.csrfToken).send({}).expect(400); // allowed, bad input

    const res = await put(superAdmin, '/api/admin/roles/VIEWER/access', { access: { calculator: 'NONE', policy_history: 'NONE' }, reason: 'Viewers only look up' }).expect(200);
    expect(res.body).toEqual({ role: 'VIEWER', changed: ['calculator', 'policy_history'] });
    const me = (await viewer.agent.get('/api/auth/me').expect(200)).body as Me;
    expect(me.user.permissions).not.toContain('calc.run');
    expect(me.user.permissions).not.toContain('page.policy_history');
    expect(me.user.permissions).toContain('page.catalogue');
    await viewer.agent.post('/api/calculations/preview').set('X-CSRF-Token', viewer.me.csrfToken).send({}).expect(403);
    await viewer.agent.get('/api/catalogue').expect(200); // the product table is still open

    const { rows: [event] } = await h.pool.query(`SELECT reason, before, after FROM ecr.audit_event WHERE action = 'ROLE_ACCESS_CHANGED' ORDER BY chain_seq DESC LIMIT 1`);
    expect(event).toMatchObject({ reason: 'Viewers only look up', before: { calculator: 'EDIT', policy_history: 'VIEW' }, after: { calculator: 'NONE', policy_history: 'NONE' } });

    await put(superAdmin, '/api/admin/roles/VIEWER/access', { access: { calculator: 'EDIT', policy_history: 'VIEW' }, reason: 'Back as before' }).expect(200);
    await viewer.agent.post('/api/calculations/preview').set('X-CSRF-Token', viewer.me.csrfToken).send({}).expect(400);
  });

  it('opens an administration page to a role, enforced by the API', async () => {
    const checker = await h.signedIn(['CHECKER']);
    await checker.agent.get('/api/jobs').expect(403);
    await put(superAdmin, '/api/admin/roles/CHECKER/access', { access: { jobs: 'VIEW' }, reason: 'Checkers follow the automatic updates' }).expect(200);
    await checker.agent.get('/api/jobs').expect(200);
    await checker.agent.get('/api/audit-events').expect(403); // the audit log stays closed
  });

  it('keeps the safety rules', async () => {
    const locked = await put(superAdmin, '/api/admin/roles/SUPER_ADMIN/access', { access: { settings: 'NONE' }, reason: 'Lock out' }).expect(422);
    expect(locked.body.error.code).toBe('ACCESS_LOCKED');
    const sod = await put(superAdmin, '/api/admin/roles/USER_ADMIN/access', { access: { changesets: 'ENTER' }, reason: 'SoD' }).expect(422);
    expect(sod.body.error.code).toBe('SOD_CONFLICT');
    await put(superAdmin, '/api/admin/roles/VIEWER/access', { access: { find: 'EVERYTHING' }, reason: 'Bad level' }).expect(400);
    await put(superAdmin, '/api/admin/roles/VIEWER/access', { access: { find: 'NONE' }, reason: '' }).expect(400);
    await put(superAdmin, '/api/admin/roles/NOBODY/access', { access: {}, reason: 'No such role' }).expect(404);
    // Permissions no page manages are kept (a Super Admin still invites administrators).
    await put(superAdmin, '/api/admin/roles/SUPER_ADMIN/access', { access: { find: 'NONE' }, reason: 'Admins use the table' }).expect(200);
    const { rows } = await h.pool.query(`SELECT rp.permission_code FROM ecr.role_permission rp JOIN ecr.role r ON r.id = rp.role_id WHERE r.code = 'SUPER_ADMIN'`);
    const perms = rows.map((r) => r.permission_code);
    expect(perms).toEqual(expect.arrayContaining(['user.invite_admin', 'role.manage', 'config.manage', 'user.manage', 'catalogue.read']));
    expect(perms).not.toContain('page.find');
  });
});
