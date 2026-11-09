import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { expect, inject } from 'vitest';
import { createApp } from '../src/app';
import { totpCode } from '../src/auth/totp';
import { AppConfig, loadConfig } from '../src/config';
import { createPool } from '../src/db/db.service';
import { migrate } from '../src/db/migrate';
import { HubStub, startHubStub, StubUser } from './hub-stub';

export const PUBLIC_BASE_URL = 'http://ecr.test';
export const CLIENT_ID = 'ecr-test';
export type Agent = ReturnType<typeof request.agent>;

export interface Me {
  csrfToken: string;
  session: { id: string; idleTimeoutMinutes: number; steppedUpAt: string | null };
  user: { id: string; email: string; roles: string[]; permissions: string[]; privileged: boolean };
  totp: { enrolled: boolean; required: boolean; enrollmentRequired: boolean };
}

export function testConfig(hubIssuer: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: inject('testDatabaseUrl'),
    PUBLIC_BASE_URL,
    HUB_ISSUER: hubIssuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    HUB_DASHBOARD_URL: 'http://hub.test/dashboard',
    COOKIE_SECURE: 'false',
    ECR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ALLOWED_NETWORKS: '127.0.0.0/8,::1/128',
    JIT_DEFAULT_ROLES: 'VIEWER',
    // Tests exercise the authenticator on every privileged role; the Super Admin exemption has its own test.
    TOTP_EXEMPT_ROLES: '',
    // No test reads the real official websites; the auto-update test turns it on with stand-in pages.
    AUTO_UPDATE: 'false',
    MALWARE_SCAN_REQUIRED: 'false',
    PUBLISH_DUE_INTERVAL_MS: '0',
    MAIL_TRANSPORT: 'memory',
    EMAIL_OUTBOX_INTERVAL_MS: '0',
    EXPORT_JOB_INTERVAL_MS: '0',
    SCHEDULER_TICK_MS: '0',
    SETTINGS_REFRESH_MS: '0',
    ...overrides,
  });
}

export interface Person {
  agent: Agent;
  me: Me;
  secret: string;
  recoveryCodes: string[];
}

/** Fresh schema, DWS Hub stub and API app for one test file. */
export async function startHarness(overrides: Record<string, string> = {}) {
  const pool: Pool = createPool(inject('testDatabaseUrl'));
  await pool.query('DROP SCHEMA IF EXISTS ecr CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.ecr_schema_migrations');
  await migrate(pool, resolve(process.cwd(), 'migrations'));

  const hub: HubStub = await startHubStub(CLIENT_ID, `${PUBLIC_BASE_URL}/api/auth/callback`);
  const storageDir = await mkdtemp(join(tmpdir(), 'ecr-storage-'));
  const app: INestApplication = await createApp(testConfig(hub.issuer, { STORAGE_DIR: storageDir, ...overrides }), false);
  await app.init();
  const server = app.getHttpServer();
  let seq = 0;

  const h = {
    pool,
    hub,
    app,
    server,

    async close() {
      await app.close();
      await hub.close();
      await pool.end();
      await rm(storageDir, { recursive: true, force: true, maxRetries: 5 });
    },

    newUser(): StubUser {
      seq += 1;
      const id = `${Date.now()}-${seq}`;
      return { sub: `hub-${id}`, email: `user.${id}@corp.example`, name: `User ${seq}` };
    },

    /** Creates the ECR account directly (as if the person had signed in before) with exactly these roles. */
    async provision(user: StubUser, roles: string[]): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ecr.app_user (email, full_name, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
        [user.email, user.name],
      );
      const id = rows[0].id;
      await pool.query(
        `INSERT INTO ecr.user_identity (user_id, provider, subject, issuer, email_at_link) VALUES ($1, 'DWS_HUB', $2, $3, $4)`,
        [id, user.sub, hub.issuer, user.email],
      );
      await pool.query(
        `INSERT INTO ecr.user_role (user_id, role_id) SELECT $1, id FROM ecr.role WHERE code = ANY($2)`,
        [id, roles],
      );
      return id;
    },

    /** Browser side of the OIDC flow; returns the callback response and path. */
    async signIn(agent: Agent, user: StubUser, returnTo = '/catalogue') {
      hub.user = user;
      const start = await agent.get(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`).expect(302);
      const authorize = new URL(start.headers.location);
      expect(authorize.origin).toBe(hub.issuer);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      const hubResponse = await fetch(authorize, { redirect: 'manual' });
      expect(hubResponse.status).toBe(302);
      const callback = new URL(hubResponse.headers.get('location')!);
      expect(callback.origin).toBe(PUBLIC_BASE_URL);
      const path = callback.pathname + callback.search;
      return { res: await agent.get(path), callbackPath: path };
    },

    /** Signs a user in (provisioning them with `roles` first when given) and returns /me. */
    async signedIn(roles?: string[], given?: StubUser): Promise<{ agent: Agent; user: StubUser; me: Me }> {
      const user = given ?? h.newUser();
      if (roles) await h.provision(user, roles);
      const agent = request.agent(server);
      const { res } = await h.signIn(agent, user);
      expect(res.status).toBe(302);
      const me = (await agent.get('/api/auth/me').expect(200)).body as Me;
      return { agent, user, me };
    },

    /** Signs in a provisioned user with `roles` and enrols an authenticator (which also counts as a step-up). */
    async privileged(roles: string[]): Promise<Person> {
      const { agent, me } = await h.signedIn(roles);
      const { secret, recoveryCodes } = await h.enrollTotp(agent, me.csrfToken);
      return { agent, me: await h.me(agent), secret, recoveryCodes };
    },

    async me(agent: Agent): Promise<Me> {
      return (await agent.get('/api/auth/me').expect(200)).body as Me;
    },

    /** Enrols an authenticator through the API; returns the secret and recovery codes. */
    async enrollTotp(agent: Agent, csrf: string) {
      const start = await agent.post('/api/auth/totp/enroll').set('X-CSRF-Token', csrf).expect(200);
      const secret = start.body.secret as string;
      const confirm = await agent.post('/api/auth/totp/confirm').set('X-CSRF-Token', csrf).send({ code: totpCode(secret) }).expect(200);
      return { secret, recoveryCodes: confirm.body.recoveryCodes as string[] };
    },

    /** A valid code that has not been used yet: the next time step (accepted within the ±1 drift window). */
    nextCode(secret: string): string {
      return totpCode(secret, Date.now() + 30_000);
    },

    async expireStepUp(sessionId: string) {
      await pool.query(`UPDATE ecr.user_session SET stepped_up_at = now() - interval '1 hour' WHERE id = $1`, [sessionId]);
    },

    async auditActions(entityOrActorId: string): Promise<string[]> {
      const { rows } = await pool.query<{ action: string }>(
        'SELECT action FROM ecr.audit_event WHERE actor_user_id = $1::uuid OR entity_id = $1::text ORDER BY chain_seq',
        [entityOrActorId],
      );
      return rows.map((r) => r.action);
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;
