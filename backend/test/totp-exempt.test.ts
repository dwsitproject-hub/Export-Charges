import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, Harness } from './harness';

describe('authenticator exemption (TOTP_EXEMPT_ROLES, default Super Admin)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ TOTP_EXEMPT_ROLES: 'SUPER_ADMIN' });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lets a Super Admin work without enrolling or stepping up', async () => {
    const admin = await h.signedIn(['SUPER_ADMIN']);
    const me = (await admin.agent.get('/api/auth/me').expect(200)).body;
    expect(me.totp).toEqual({ enrolled: false, required: false, enrollmentRequired: false });
    expect(me.user.privileged).toBe(true);
    // Admin functions and a change that otherwise needs a fresh authenticator code.
    await admin.agent.get('/api/admin/users').expect(200);
    const res = await admin.agent.put('/api/admin/config').set('X-CSRF-Token', admin.me.csrfToken)
      .send({ values: { sessionIdleMinutes: 25 }, reason: 'Exemption test' }).expect(200);
    expect(res.body.changed).toEqual(['sessionIdleMinutes']);
    const fixed = (await admin.agent.get('/api/admin/config').expect(200)).body.fixed as { label: string; value: string }[];
    expect(fixed.find((f) => f.label === 'Authenticator for privileged roles')?.value).toBe('Required, except SUPER_ADMIN');
  });

  it('still requires the authenticator of other privileged roles', async () => {
    const checker = await h.signedIn(['CHECKER']);
    expect((await checker.agent.get('/api/auth/me').expect(200)).body.totp).toEqual({ enrolled: false, required: true, enrollmentRequired: true });
    const res = await checker.agent.get('/api/change-sets').expect(403);
    expect(res.body.error.code).toBe('TOTP_ENROLLMENT_REQUIRED');
  });
});
