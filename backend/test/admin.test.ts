import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/auth/totp';
import { Harness, Person, startHarness } from './harness';

describe('authenticator step-up, user administration and audit log', () => {
  let h: Harness;
  let superA: Person;
  let superB: Person;
  let userAdmin: Person;

  const privileged = (roles: string[]) => h.privileged(roles);

  /** A 6-digit code that matches none of the steps in the ±1 drift window. */
  function wrongCode(secret: string): string {
    const valid = new Set([-30_000, 0, 30_000].map((d) => totpCode(secret, Date.now() + d)));
    for (let n = 0; ; n++) {
      const candidate = String(n).padStart(6, '0');
      if (!valid.has(candidate)) return candidate;
    }
  }

  function put(p: Person, path: string, body: object) {
    return p.agent.put(path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  }

  function post(p: Person, path: string, body: object = {}) {
    return p.agent.post(path).set('X-CSRF-Token', p.me.csrfToken).send(body);
  }

  beforeAll(async () => {
    h = await startHarness();
    superA = await privileged(['SUPER_ADMIN']);
    superB = await privileged(['SUPER_ADMIN']);
    userAdmin = await privileged(['USER_ADMIN']);
  });

  afterAll(async () => {
    await h?.close();
  });

  // ------------------------------------------------------------------ authenticator

  describe('authenticator (TOTP)', () => {
    it('blocks privileged functions until an authenticator is enrolled', async () => {
      const { agent, me } = await h.signedIn(['USER_ADMIN']);
      expect(me.totp.enrollmentRequired).toBe(true);
      const res = await agent.get('/api/admin/users').expect(403);
      expect(res.body.error.code).toBe('TOTP_ENROLLMENT_REQUIRED');
    });

    it('enrols with a valid code, returns ten recovery codes and cannot be enrolled twice', async () => {
      const { agent, me } = await h.signedIn(['USER_ADMIN']);
      const start = await agent.post('/api/auth/totp/enroll').set('X-CSRF-Token', me.csrfToken).expect(200);
      expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/ECR:.+\?secret=/);

      const bad = await agent.post('/api/auth/totp/confirm').set('X-CSRF-Token', me.csrfToken).send({ code: wrongCode(start.body.secret) }).expect(400);
      expect(bad.body.error.code).toBe('TOTP_INVALID');

      const ok = await agent.post('/api/auth/totp/confirm').set('X-CSRF-Token', me.csrfToken).send({ code: totpCode(start.body.secret) }).expect(200);
      expect(ok.body.recoveryCodes).toHaveLength(10);
      expect(new Set(ok.body.recoveryCodes).size).toBe(10);

      const after = await h.me(agent);
      expect(after.totp).toEqual({ enrolled: true, required: true, enrollmentRequired: false });
      await agent.get('/api/admin/users').expect(200);

      const again = await agent.post('/api/auth/totp/enroll').set('X-CSRF-Token', me.csrfToken).expect(409);
      expect(again.body.error.code).toBe('TOTP_ALREADY_ENROLLED');
    });

    it('requires a fresh step-up for a sensitive action and accepts a TOTP code', async () => {
      const p = await privileged(['USER_ADMIN']);
      const { me: viewer } = await h.signedIn();
      await h.expireStepUp(p.me.session.id);

      const blocked = await put(p, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['VIEWER', 'CHECKER'], reason: 'Review duty' }).expect(403);
      expect(blocked.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { enrolled: true } });

      const step = await post(p, '/api/auth/step-up', { code: h.nextCode(p.secret) }).expect(200);
      expect(step.body.method).toBe('TOTP');
      await put(p, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['VIEWER', 'CHECKER'], reason: 'Review duty' }).expect(200);
    });

    it('refuses a replayed code', async () => {
      const p = await privileged(['CHECKER']);
      const code = h.nextCode(p.secret);
      await post(p, '/api/auth/step-up', { code }).expect(200);
      const replay = await post(p, '/api/auth/step-up', { code }).expect(400);
      expect(replay.body.error.code).toBe('TOTP_INVALID');
    });

    it('locks the authenticator for 15 minutes after five wrong codes', async () => {
      const p = await privileged(['MAKER']);
      for (let i = 0; i < 4; i++) {
        expect((await post(p, '/api/auth/step-up', { code: wrongCode(p.secret) })).body.error.code).toBe('TOTP_INVALID');
      }
      const fifth = await post(p, '/api/auth/step-up', { code: wrongCode(p.secret) }).expect(429);
      expect(fifth.body.error.code).toBe('TOTP_LOCKED');
      const correct = await post(p, '/api/auth/step-up', { code: h.nextCode(p.secret) }).expect(429);
      expect(correct.body.error.code).toBe('TOTP_LOCKED');

      const { rows } = await h.pool.query(
        `SELECT count(*)::int AS n FROM ecr.audit_event WHERE actor_user_id = $1 AND action = 'STEP_UP_FAILED'`,
        [p.me.user.id],
      );
      expect(rows[0].n).toBe(5);
    });

    it('accepts each recovery code exactly once', async () => {
      const p = await privileged(['AUDITOR']);
      const [code] = p.recoveryCodes;
      const first = await post(p, '/api/auth/step-up', { recoveryCode: code.toLowerCase() }).expect(200);
      expect(first.body).toEqual({ method: 'RECOVERY_CODE', recoveryCodesLeft: 9 });
      const reuse = await post(p, '/api/auth/step-up', { recoveryCode: code }).expect(400);
      expect(reuse.body.error.code).toBe('TOTP_INVALID');
    });
  });

  // ------------------------------------------------------------------ users and roles

  describe('user and role administration', () => {
    it('keeps viewers out of user administration and records the attempt', async () => {
      const { agent, me } = await h.signedIn();
      const res = await agent.get('/api/admin/users').expect(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { missing: ['user.manage'] } });
      const { rows } = await h.pool.query(
        `SELECT after FROM ecr.audit_event WHERE action = 'AUTHZ_DENIED' AND actor_user_id = $1`,
        [me.user.id],
      );
      expect(rows[0].after).toEqual({ method: 'GET', path: '/api/admin/users', missing: ['user.manage'] });
    });

    it('lets a User Admin grant MAKER; the change ends the user\'s sessions and is audited', async () => {
      const { agent: viewerAgent, me: viewer } = await h.signedIn();
      const res = await put(userAdmin, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['VIEWER', 'MAKER'], reason: 'Joins the data team' }).expect(200);
      expect(res.body.roles).toEqual(['MAKER', 'VIEWER']);

      await viewerAgent.get('/api/auth/me').expect(401);
      const { rows } = await h.pool.query(
        `SELECT reason, before, after FROM ecr.audit_event WHERE action = 'ROLES_CHANGED' AND entity_id = $1`,
        [viewer.user.id],
      );
      expect(rows[0].reason).toBe('Joins the data team');
      expect(rows[0].before).toEqual({ roles: ['VIEWER'] });
      expect(rows[0].after).toMatchObject({ added: ['MAKER'], removed: [], revokedSessions: 1 });
    });

    it('validates the request: reason, role codes and CSRF token', async () => {
      const { me: viewer } = await h.signedIn();
      const path = `/api/admin/users/${viewer.user.id}/roles`;
      expect((await put(userAdmin, path, { roles: ['MAKER'], reason: '' }).expect(400)).body.error.code).toBe('INVALID_INPUT');
      expect((await put(userAdmin, path, { roles: ['WIZARD'], reason: 'Typo test' }).expect(400)).body.error.message).toMatch(/WIZARD/);
      const noCsrf = await userAdmin.agent.put(path).send({ roles: ['MAKER'], reason: 'No token' }).expect(403);
      expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
    });

    it('SoD-3: nobody can change their own access', async () => {
      const res = await put(userAdmin, `/api/admin/users/${userAdmin.me.user.id}/roles`, { roles: ['USER_ADMIN', 'AUDITOR'], reason: 'Self grant' }).expect(403);
      expect(res.body.error.code).toBe('SOD_VIOLATION');
    });

    it('only a Super Admin can manage administrator roles and accounts', async () => {
      const { me: viewer } = await h.signedIn();
      await put(userAdmin, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['USER_ADMIN'], reason: 'Escalate' }).expect(403);
      await post(userAdmin, `/api/admin/users/${superB.me.user.id}/deactivate`, { reason: 'Take over' }).expect(403);
      await put(superA, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['USER_ADMIN'], reason: 'New user administrator' }).expect(200);
    });

    it('SoD-2: USER_ADMIN cannot be combined with MAKER or CHECKER', async () => {
      const { me: viewer } = await h.signedIn();
      const res = await put(superA, `/api/admin/users/${viewer.user.id}/roles`, { roles: ['USER_ADMIN', 'MAKER'], reason: 'Combined' }).expect(422);
      expect(res.body.error.code).toBe('SOD_CONFLICT');
    });

    it('SoD-4: keeps at least two active Super Admins', async () => {
      const demote = await put(superA, `/api/admin/users/${superB.me.user.id}/roles`, { roles: ['VIEWER'], reason: 'Demote' }).expect(409);
      expect(demote.body.error.code).toBe('SUPER_ADMIN_MINIMUM');
      await post(superA, `/api/admin/users/${superB.me.user.id}/deactivate`, { reason: 'Leaver' }).expect(409);
    });

    it('deactivation ends sessions and blocks sign-in; reactivation restores access', async () => {
      const { agent, user, me } = await h.signedIn();
      const off = await post(userAdmin, `/api/admin/users/${me.user.id}/deactivate`, { reason: 'Left the company' }).expect(200);
      expect(off.body.status).toBe('DEACTIVATED');
      await agent.get('/api/auth/me').expect(401);
      expect((await h.signIn(request.agent(h.server), user)).res.headers.location).toBe('/signin-error?reason=LOGIN_BLOCKED');

      await post(userAdmin, `/api/admin/users/${me.user.id}/reactivate`, { reason: 'Rehired' }).expect(200);
      expect((await h.signIn(request.agent(h.server), user)).res.headers.location).toBe('/catalogue');
      expect(await h.auditActions(me.user.id)).toEqual(expect.arrayContaining(['USER_DEACTIVATED', 'USER_REACTIVATED']));
    });

    it('resetting an authenticator forces the user to enrol again', async () => {
      const maker = await privileged(['MAKER']);
      await post(userAdmin, `/api/admin/users/${maker.me.user.id}/reset-totp`, { reason: 'Lost phone' }).expect(200);
      await maker.agent.get('/api/auth/me').expect(401); // sessions ended
      const { me } = await h.signedIn(undefined, { sub: (await h.pool.query('SELECT subject FROM ecr.user_identity WHERE user_id = $1', [maker.me.user.id])).rows[0].subject, email: maker.me.user.email });
      expect(me.totp).toEqual({ enrolled: false, required: true, enrollmentRequired: true });
    });

    it('revokes a user\'s sessions without step-up', async () => {
      const { agent, me } = await h.signedIn();
      await h.expireStepUp(userAdmin.me.session.id);
      const res = await post(userAdmin, `/api/admin/users/${me.user.id}/revoke-sessions`, { reason: 'Suspicious activity' }).expect(200);
      expect(res.body.revokedSessions).toBe(1);
      await agent.get('/api/auth/me').expect(401);
    });

    it('lists and shows users', async () => {
      const { me } = await h.signedIn();
      const list = await superA.agent.get(`/api/admin/users?q=${encodeURIComponent(me.user.email)}`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: me.user.id, roles: ['VIEWER'], status: 'ACTIVE', totpEnrolled: false });
      const detail = await superA.agent.get(`/api/admin/users/${me.user.id}`).expect(200);
      expect(detail.body.email).toBe(me.user.email);
      await superA.agent.get('/api/admin/users/not-a-uuid').expect(404);
    });
  });

  // ------------------------------------------------------------------ audit log

  describe('audit log API', () => {
    it('lets a Super Admin search events and verify the hash chain', async () => {
      const res = await superA.agent.get('/api/audit-events?action=ROLES_CHANGED&limit=2').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0]).toMatchObject({ action: 'ROLES_CHANGED', entityType: 'APP_USER' });
      expect(res.body.items[0].hash).toMatch(/^[0-9a-f]{64}$/);
      if (res.body.nextBefore) {
        const next = await superA.agent.get(`/api/audit-events?action=ROLES_CHANGED&before=${res.body.nextBefore}`).expect(200);
        expect(next.body.items.every((i: { chainSeq: number }) => i.chainSeq < res.body.nextBefore)).toBe(true);
      }
      const verify = await superA.agent.get('/api/audit-events/verify').expect(200);
      expect(verify.body).toMatchObject({ intact: true, brokenAtChainSeq: null });
    });

    it('rejects bad filters and keeps viewers out', async () => {
      await superA.agent.get('/api/audit-events?actorUserId=nope').expect(400);
      const { agent } = await h.signedIn();
      await agent.get('/api/audit-events').expect(403);
    });
  });
});
