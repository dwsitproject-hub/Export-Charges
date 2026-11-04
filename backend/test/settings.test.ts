import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, Harness, Me, Person, startHarness } from './harness';

interface Setting {
  key: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
  updatedBy: string | null;
  min: number;
  max: number;
  options?: { code: string; privileged: boolean }[];
}

describe('configuration screen (PRD F-52)', () => {
  let h: Harness;
  let admin: Person;
  let userAdmin: Person;
  let auditor: Person;
  let viewer: Awaited<ReturnType<Harness['signedIn']>>;

  const send = (p: { agent: Agent; me: Me }, values: object, reason: string | undefined = 'Policy update') =>
    p.agent.put('/api/admin/config').set('X-CSRF-Token', p.me.csrfToken).send({ values, reason });
  const settings = async () => ((await admin.agent.get('/api/admin/config').expect(200)).body.settings as Setting[]);
  const setting = async (key: string) => (await settings()).find((s) => s.key === key)!;
  const refused = async (values: object, reason?: string) => {
    const body = (await send(admin, values, reason).expect(400)).body;
    expect(body.error.code).toBe('INVALID_INPUT');
    return body.error.details.fields as { field: string; message: string }[];
  };
  const sessionOf = async (sessionId: string) =>
    (await h.pool.query<{ idle_timeout_minutes: number; hours: number; revoked_at: Date | null }>(
      `SELECT idle_timeout_minutes, extract(epoch FROM absolute_expires_at - created_at) / 3600 AS hours, revoked_at FROM ecr.user_session WHERE id = $1`,
      [sessionId],
    )).rows[0];

  beforeAll(async () => {
    h = await startHarness();
    admin = await h.privileged(['SUPER_ADMIN']);
    userAdmin = await h.privileged(['USER_ADMIN']);
    auditor = await h.privileged(['AUDITOR']);
    viewer = await h.signedIn(['VIEWER']);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lists each setting with its value, default and range, and deployment settings read-only', async () => {
    const res = (await admin.agent.get('/api/admin/config').expect(200)).body;
    expect(res.settings.map((s: Setting) => s.key)).toEqual([
      'sessionIdleMinutes', 'privilegedIdleMinutes', 'sessionAbsoluteHours', 'maxSessionsPerUser', 'stepUpWindowMinutes',
      'jitDefaultRoles', 'allowedNetworks', 'disclaimer',
    ]);
    expect(await setting('sessionIdleMinutes')).toMatchObject({ value: 30, default: 30, overridden: false, min: 5, max: 60 });
    expect(await setting('sessionAbsoluteHours')).toMatchObject({ value: 8, max: 12 });
    const roles = await setting('jitDefaultRoles');
    expect(roles.value).toEqual(['VIEWER']);
    expect(roles.options!.find((o) => o.code === 'MAKER')!.privileged).toBe(true);
    expect(res.fixed[0]).toMatchObject({ label: 'Authenticator for privileged roles', value: 'Always required' });
    expect(res.fixed.map((f: { label: string }) => f.label)).toContain('DWS Hub client id');

    // Super Admins only.
    await userAdmin.agent.get('/api/admin/config').expect(403);
    await auditor.agent.get('/api/admin/config').expect(403);
    await viewer.agent.get('/api/admin/config').expect(403);
  });

  it('blocks values outside the safe limits with the allowed range (US-52-N1)', async () => {
    expect((await refused({ sessionIdleMinutes: 61 }))[0].message).toBe('Idle timeout: must be a whole number from 5 to 60 minutes.');
    expect((await refused({ sessionAbsoluteHours: 13 }))[0].message).toContain('from 1 to 12 hours');
    expect((await refused({ privilegedIdleMinutes: 45 }))[0].message).toContain('must not be longer than the general idle timeout');
    expect((await refused({ sessionIdleMinutes: 10 }))[0]).toMatchObject({ field: 'privilegedIdleMinutes' });
    // AC2: a privileged role cannot be the default at first sign-in.
    expect((await refused({ jitDefaultRoles: ['MAKER'] }))[0].message).toContain('MAKER is a privileged role');
    expect((await refused({ jitDefaultRoles: ['NOPE'] }))[0].message).toContain('unknown role NOPE');
    expect((await refused({ allowedNetworks: '10.0.0.0/33\nnot-an-ip' }))[0].message).toContain('10.0.0.0/33, not-an-ip');
    expect((await refused({ allowedNetworks: ['0.0.0.0/0'] }))[0].message).toContain('not a restriction');
    expect((await refused({ allowedNetworks: [] }))[0].message).toContain('must list 1 to 50');
    // Saving a list without your own address would lock you out.
    expect((await refused({ allowedNetworks: ['10.0.0.0/8'] }))[0].message).toMatch(/Your own address .* is not in the list/);
    expect((await refused({ disclaimer: 'Too short' }))[0].message).toContain('20 to 1000 characters');
    expect((await refused({ stepUpWindowMinutes: 2.5 }))[0].field).toBe('stepUpWindowMinutes');
    expect((await refused({ sessionIdleMinutes: 20 }, ''))[0].field).toBe('reason');
    expect((await send(admin, { nope: 1 }).expect(400)).body.error.message).toContain('Unknown setting(s): nope');
    expect((await settings()).some((s) => s.overridden)).toBe(false);
  });

  it('needs a fresh authenticator code and the config.manage permission', async () => {
    await h.expireStepUp(admin.me.session.id);
    expect((await send(admin, { sessionIdleMinutes: 20 }).expect(403)).body.error.code).toBe('STEP_UP_REQUIRED');
    await admin.agent.post('/api/auth/step-up').set('X-CSRF-Token', admin.me.csrfToken).send({ code: h.nextCode(admin.secret) }).expect(200);
    await send(userAdmin, { sessionIdleMinutes: 20 }).expect(403);
  });

  it('applies a change at once, also to open sessions, and audits before and after (US-52-P1)', async () => {
    const res = (await send(admin, { sessionIdleMinutes: '20', privilegedIdleMinutes: 10, sessionAbsoluteHours: 4 }, 'Shorter sessions per IT policy').expect(200)).body;
    expect(res.changed).toEqual(['sessionIdleMinutes', 'privilegedIdleMinutes', 'sessionAbsoluteHours']);
    expect(res.settings.find((s: Setting) => s.key === 'sessionIdleMinutes')).toMatchObject({ value: 20, default: 30, overridden: true, updatedBy: expect.any(String) });

    expect(await sessionOf(viewer.me.session.id)).toMatchObject({ idle_timeout_minutes: 20, hours: '4.0000000000000000' });
    expect((await sessionOf(admin.me.session.id)).idle_timeout_minutes).toBe(10);
    const fresh = await h.signedIn(['VIEWER']);
    expect((await sessionOf(fresh.me.session.id)).idle_timeout_minutes).toBe(20);

    const { rows: [event] } = await h.pool.query(
      `SELECT before, after, reason FROM ecr.audit_event WHERE action = 'CONFIG_CHANGED' ORDER BY chain_seq DESC LIMIT 1`,
    );
    expect(event.before).toEqual({ sessionIdleMinutes: 30, privilegedIdleMinutes: 15, sessionAbsoluteHours: 8 });
    expect(event.after).toMatchObject({ sessionIdleMinutes: 20, privilegedIdleMinutes: 10, sessionAbsoluteHours: 4 });
    expect(event.reason).toBe('Shorter sessions per IT policy');

    // Saving the same values again changes nothing and records nothing.
    expect((await send(admin, { sessionIdleMinutes: 20 }).expect(200)).body.changed).toEqual([]);
  });

  it('ends sessions beyond a lower limit and controls the roles given at first sign-in', async () => {
    const second = await h.signedIn(undefined, viewer.user);
    await send(admin, { maxSessionsPerUser: 1 }).expect(200);
    expect((await sessionOf(viewer.me.session.id)).revoked_at).not.toBeNull();
    expect((await sessionOf(second.me.session.id)).revoked_at).toBeNull();
    await viewer.agent.get('/api/auth/me').expect(401);

    await send(admin, { jitDefaultRoles: [] }).expect(200);
    const newcomer = await h.signedIn();
    expect(newcomer.me.user.roles).toEqual([]);
    await send(admin, { jitDefaultRoles: null, maxSessionsPerUser: null }).expect(200);
    expect((await h.signedIn()).me.user.roles).toEqual(['VIEWER']);
    expect(await setting('jitDefaultRoles')).toMatchObject({ value: ['VIEWER'], overridden: false });
  });

  it('applies a new network allow-list to the next request', async () => {
    // A request from outside the list is refused; the API sees the test client as loopback.
    await send(admin, { allowedNetworks: '127.0.0.0/8\n::1/128\n::ffff:127.0.0.1/128\n10.20.0.0/16' }).expect(200);
    expect((await setting('allowedNetworks')).value).toEqual(['127.0.0.0/8', '::1/128', '::ffff:127.0.0.1/128', '10.20.0.0/16']);
    await admin.agent.get('/api/admin/config').expect(200);
    await send(admin, { allowedNetworks: null }).expect(200);
    expect((await setting('allowedNetworks')).overridden).toBe(false);
  });

  it('ignores a stored value that breaks the limits and uses the default', async () => {
    await send(admin, { sessionAbsoluteHours: 6 }).expect(200);
    expect((await setting('sessionAbsoluteHours')).value).toBe(6);
    await h.pool.query(
      `INSERT INTO ecr.system_config (key, value, updated_by) VALUES ('sessionAbsoluteHours', '48', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [admin.me.user.id],
    );
    const { SettingsService } = await import('../src/settings/settings.service');
    await h.app.get(SettingsService).reload();
    expect((await setting('sessionAbsoluteHours')).value).toBe(8);
  });
});
