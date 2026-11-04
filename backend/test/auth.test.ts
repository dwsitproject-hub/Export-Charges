import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Harness, startHarness, testConfig } from './harness';

describe('DWS Hub sign-in, session and logout', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(() => {
    h.hub.mode = {};
  });

  // ------------------------------------------------------------------ sign-in and just-in-time accounts

  it('creates an ECR account with the default role on first DWS Hub sign-in', async () => {
    const user = h.newUser();
    const agent = request.agent(h.server);

    const { res } = await h.signIn(agent, user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/catalogue');
    const cookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookie.find((c) => c.startsWith('ecr_sid='))).toMatch(/HttpOnly/);
    expect(cookie.find((c) => c.startsWith('ecr_sid='))).toMatch(/SameSite=Strict/);

    const me = await h.me(agent);
    expect(me.user.email).toBe(user.email);
    expect(me.user.roles).toEqual(['VIEWER']);
    expect(me.user.privileged).toBe(false);
    expect(me.totp.enrollmentRequired).toBe(false);
    expect(me.session.idleTimeoutMinutes).toBe(30);

    const { rows } = await h.pool.query(`SELECT subject FROM ecr.user_identity WHERE user_id = $1`, [me.user.id]);
    expect(rows[0].subject).toBe(user.sub);
    expect(await h.auditActions(me.user.id)).toEqual(['USER_PROVISIONED', 'LOGIN_SUCCESS']);
  });

  it('gives privileged roles a 15-minute idle timeout', async () => {
    const { me } = await h.signedIn(['MAKER']);
    expect(me.user.privileged).toBe(true);
    expect(me.session.idleTimeoutMinutes).toBe(15);
    expect(me.totp.enrollmentRequired).toBe(true);
  });

  it('selects the account by Hub sub on later sign-ins, even if the Hub email changes', async () => {
    const { user, me } = await h.signedIn();
    const again = request.agent(h.server);
    const { res } = await h.signIn(again, { ...user, email: `renamed.${user.email}` });
    expect(res.headers.location).toBe('/catalogue');
    expect((await h.me(again)).user.id).toBe(me.user.id);
  });

  it('refuses a new Hub identity whose email already belongs to another account', async () => {
    const { user } = await h.signedIn();
    const impostor = { ...h.newUser(), email: user.email };
    const { res } = await h.signIn(request.agent(h.server), impostor);
    expect(res.headers.location).toBe('/signin-error?reason=LOGIN_IDENTITY_CONFLICT');
    const { rows } = await h.pool.query(
      `SELECT 1 FROM ecr.audit_event WHERE action = 'LOGIN_IDENTITY_CONFLICT' AND after->>'hubSubject' = $1`,
      [impostor.sub],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a new Hub identity that has no email', async () => {
    const { res } = await h.signIn(request.agent(h.server), { sub: h.newUser().sub });
    expect(res.headers.location).toBe('/signin-error?reason=LOGIN_NO_EMAIL');
  });

  it('refuses sign-in for a deactivated account', async () => {
    const { user, me } = await h.signedIn();
    await h.pool.query(`UPDATE ecr.app_user SET status = 'DEACTIVATED', deactivated_reason = 'leaver' WHERE id = $1`, [me.user.id]);
    const { res } = await h.signIn(request.agent(h.server), user);
    expect(res.headers.location).toBe('/signin-error?reason=LOGIN_BLOCKED');
  });

  it('refuses a replayed callback (single-use state)', async () => {
    const agent = request.agent(h.server);
    const { res, callbackPath } = await h.signIn(agent, h.newUser());
    expect(res.headers.location).toBe('/catalogue');
    const replay = await agent.get(callbackPath);
    expect(replay.headers.location).toBe('/signin-error?reason=LOGIN_STATE_INVALID');
  });

  it('refuses a callback completed in a different browser (login CSRF)', async () => {
    h.hub.user = h.newUser();
    const victim = request.agent(h.server);
    const attacker = request.agent(h.server);
    const start = await attacker.get('/api/auth/login').expect(302);
    const hubResponse = await fetch(start.headers.location, { redirect: 'manual' });
    const callback = new URL(hubResponse.headers.get('location')!);
    const res = await victim.get(callback.pathname + callback.search);
    expect(res.headers.location).toBe('/signin-error?reason=LOGIN_STATE_INVALID');
  });

  it.each([
    ['wrong audience', { audience: 'another-app' }],
    ['wrong issuer', { issuer: 'http://evil.example' }],
    ['HS256 signature', { signWithHs256: true }],
    ['expired token', { expired: true }],
    ['nonce mismatch', { nonce: 'not-the-nonce' }],
  ])('refuses an ID token with %s', async (_label, mode) => {
    h.hub.mode = mode;
    const { res } = await h.signIn(request.agent(h.server), h.newUser());
    expect(res.headers.location).toBe('/signin-error?reason=LOGIN_TOKEN_INVALID');
  });

  it('accepts an ID token without nonce (optional in the Hub contract)', async () => {
    h.hub.mode = { nonce: null };
    const { res } = await h.signIn(request.agent(h.server), h.newUser());
    expect(res.headers.location).toBe('/catalogue');
  });

  it.each(['https://evil.example/x', '//evil.example', '/\\evil.example'])('ignores an off-site returnTo (%s)', async (returnTo) => {
    const { res } = await h.signIn(request.agent(h.server), h.newUser(), returnTo);
    expect(res.headers.location).toBe('/');
  });

  // ------------------------------------------------------------------ session

  it('rejects an idle-expired session and revokes it', async () => {
    const { agent, me } = await h.signedIn();
    await h.pool.query(`UPDATE ecr.user_session SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [me.session.id]);
    const res = await agent.get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    const { rows } = await h.pool.query('SELECT revoke_reason FROM ecr.user_session WHERE id = $1', [me.session.id]);
    expect(rows[0].revoke_reason).toBe('EXPIRED');
  });

  // ------------------------------------------------------------------ logout

  it('returns the DWS Hub user id for the Hub SDK (DwsHub.identify)', async () => {
    const user = h.newUser();
    const { agent } = await h.signedIn(undefined, user);
    expect((await agent.get('/api/auth/me').expect(200)).body.user).toMatchObject({ email: user.email, hubSubject: user.sub });
  });

  it('requires the CSRF token to log out a live session', async () => {
    const { agent } = await h.signedIn();
    const res = await agent.post('/api/auth/logout').expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    await agent.post('/api/auth/logout').set('X-CSRF-Token', 'wrong').expect(403);
    await agent.get('/api/auth/me').expect(200);
  });

  it('logs out: revokes the session, clears cookies, audits, and points to DWS Hub', async () => {
    const { agent, me } = await h.signedIn();
    const res = await agent.post('/api/auth/logout').set('X-CSRF-Token', me.csrfToken).expect(200);

    expect(res.body).toEqual({
      loggedOut: true,
      scope: 'CURRENT',
      revokedSessions: 1,
      hubSessionEnded: false,
      hubDashboardUrl: 'http://hub.test/dashboard',
      message: expect.stringContaining('DWS Hub session is still active'),
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['clear-site-data']).toBe('"cache", "storage"');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith('ecr_sid=;'))).toMatch(/Expires=Thu, 01 Jan 1970/);

    const after = await agent.get('/api/auth/me').expect(401);
    expect(after.body.error.code).toBe('NOT_SIGNED_IN');
    const { rows } = await h.pool.query('SELECT revoked_at, revoke_reason FROM ecr.user_session WHERE id = $1', [me.session.id]);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoke_reason).toBe('LOGOUT');
    expect(await h.auditActions(me.user.id)).toContain('LOGOUT');
  });

  it('makes the old session cookie useless after logout, even if replayed', async () => {
    const agent = request.agent(h.server);
    const { res } = await h.signIn(agent, h.newUser());
    const sid = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ecr_sid='))!.split(';')[0];
    const me = await h.me(agent);
    await agent.post('/api/auth/logout').set('X-CSRF-Token', me.csrfToken).expect(200);
    await request(h.server).get('/api/auth/me').set('Cookie', sid).expect(401);
  });

  it('is idempotent: logging out without a session still returns 200', async () => {
    const res = await request(h.server).post('/api/auth/logout').expect(200);
    expect(res.body.scope).toBe('NONE');
    expect(res.body.revokedSessions).toBe(0);
    await request(h.server).post('/api/auth/logout').set('Cookie', 'ecr_sid=not-a-real-token').expect(200);
  });

  it('logs out an expired session without a CSRF token', async () => {
    const { agent, me } = await h.signedIn();
    await h.pool.query(`UPDATE ecr.user_session SET absolute_expires_at = now() - interval '1 minute' WHERE id = $1`, [me.session.id]);
    const res = await agent.post('/api/auth/logout').expect(200);
    expect(res.body.scope).toBe('CURRENT');
    const { rows } = await h.pool.query('SELECT revoke_reason FROM ecr.user_session WHERE id = $1', [me.session.id]);
    expect(rows[0].revoke_reason).toBe('EXPIRED');
  });

  it('signs out every browser with allSessions', async () => {
    const { agent: first, user, me } = await h.signedIn();
    const second = request.agent(h.server);
    await h.signIn(second, user);
    await second.get('/api/auth/me').expect(200);

    const res = await first.post('/api/auth/logout').set('X-CSRF-Token', me.csrfToken).send({ allSessions: true }).expect(200);
    expect(res.body.scope).toBe('ALL');
    expect(res.body.revokedSessions).toBe(2);
    await second.get('/api/auth/me').expect(401);
    expect(await h.auditActions(me.user.id)).toContain('LOGOUT_ALL');
  });

  // ------------------------------------------------------------------ platform guarantees

  it('keeps the audit trail append-only and its hash chain intact', async () => {
    await expect(h.pool.query(`UPDATE ecr.audit_event SET action = 'X'`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query('DELETE FROM ecr.audit_event')).rejects.toThrow(/append-only/);
    const { rows } = await h.pool.query('SELECT ecr.audit_chain_verify() AS broken_at');
    expect(rows[0].broken_at).toBeNull();
  });

  it('refuses requests from outside the office and VPN networks', async () => {
    const restricted = await createApp(testConfig(h.hub.issuer, { ALLOWED_NETWORKS: '10.0.0.0/8' }), false);
    await restricted.init();
    try {
      const res = await request(restricted.getHttpServer()).get('/api/health').expect(403);
      expect(res.body.error.code).toBe('NETWORK_NOT_ALLOWED');
    } finally {
      await restricted.close();
    }
  });
});
