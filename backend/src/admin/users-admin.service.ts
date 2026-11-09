import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { SessionService } from '../auth/session.service';
import { TotpService } from '../auth/totp.service';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';

export const ADMIN_ROLES = ['USER_ADMIN', 'SUPER_ADMIN'];
const MIN_SUPER_ADMINS = 2; // SoD-4

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  status: string;
  roles: string[];
  totpEnrolled: boolean;
  liveSessions: number;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  department: string | null;
  status: string;
  roles: string[];
  totp_enrolled: boolean;
  live_sessions: number;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.department, u.status, u.last_login_at, u.created_at,
         COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
         (lc.totp_confirmed_at IS NOT NULL) AS totp_enrolled,
         (SELECT count(*)::int FROM ecr.user_session s
           WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.absolute_expires_at > now()) AS live_sessions
    FROM ecr.app_user u
    LEFT JOIN ecr.user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                              AND (ur.expires_at IS NULL OR ur.expires_at > now())
    LEFT JOIN ecr.role r ON r.id = ur.role_id
    LEFT JOIN ecr.local_credential lc ON lc.user_id = u.id`;

function toSummary(r: UserRow): UserSummary {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    department: r.department,
    status: r.status,
    roles: r.roles,
    totpEnrolled: r.totp_enrolled,
    liveSessions: r.live_sessions,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function text(v: unknown, field: string, max: number, required: boolean): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (required) throw new ApiError(400, 'INVALID_INPUT', `${field} is required.`, { fields: [{ field, message: 'Required.' }] });
    return null;
  }
  if (s.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field} is too long (at most ${max} characters).`, { fields: [{ field, message: 'Too long.' }] });
  return s;
}

function email(v: unknown): string {
  const e = text(v, 'email', 254, true)!.toLowerCase();
  if (!EMAIL.test(e)) throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid email address.', { fields: [{ field: 'email', message: 'Not an email address.' }] });
  return e;
}

/** The account ECR's automatic updates are recorded under (migration 0017): not a person, never listed or changed. */
const SYSTEM_ACCOUNT = '00000000-0000-0000-0000-00000000ec01';

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new ApiError(400, 'INVALID_INPUT', 'A reason of at least 3 characters is required.');
  }
  return reason.trim().slice(0, 500);
}

/**
 * User and role administration (PRD F-10, Technical Design §4.1.7). DWS Hub owns invitations and
 * access requests; ECR owns roles, account status, sessions and authenticator resets.
 */
@Injectable()
export class UsersAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly totp: TotpService,
  ) {}

  async list(f: { q?: string; status?: string; role?: string; limit: number; offset: number }): Promise<UserSummary[]> {
    const q = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await this.db.query<UserRow>(
      `${USER_SELECT}
        WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.full_name ILIKE $1)
          AND ($2::text IS NULL OR u.status = $2)
          AND u.pseudonymised_at IS NULL AND u.id <> '00000000-0000-0000-0000-00000000ec01'
        GROUP BY u.id, lc.totp_confirmed_at
       HAVING ($3::text IS NULL OR $3 = ANY (array_agg(r.code)))
        ORDER BY u.full_name, u.id
        LIMIT $4 OFFSET $5`,
      [q, f.status ?? null, f.role ?? null, f.limit, f.offset],
    );
    return rows.map(toSummary);
  }

  async get(id: string): Promise<UserSummary> {
    const { rows } = await this.db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id, lc.totp_confirmed_at`, [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    return toSummary(rows[0]);
  }

  /**
   * Adds a person before their first sign-in: an INVITED account with its roles. Their first DWS Hub sign-in with this
   * email links the Hub identity to it and makes it ACTIVE (UserBindingService); until then it cannot be used.
   */
  async create(actor: Actor, input: Record<string, unknown>): Promise<UserSummary> {
    const reason = requireReason(input.reason);
    const mail = email(input.email);
    const fullName = text(input.fullName, 'fullName', 200, true)!;
    const department = text(input.department, 'department', 200, false);
    const roles = Array.isArray(input.roles)
      ? [...new Set((input.roles as unknown[]).filter((r): r is string => typeof r === 'string').map((r) => r.trim().toUpperCase()))].sort()
      : [];
    if (!roles.length) throw new ApiError(400, 'INVALID_INPUT', 'Give the person at least one role.', { fields: [{ field: 'roles', message: 'Choose at least one role.' }] });
    const id = await this.db.tx(async (c) => {
      const { rows: taken } = await c.query('SELECT 1 FROM ecr.app_user WHERE email = $1', [mail]);
      if (taken.length) throw new ApiError(409, 'EMAIL_TAKEN', 'An ECR account with this email already exists.', { fields: [{ field: 'email', message: 'Already has an account.' }] });
      const { rows: [u] } = await c.query<{ id: string }>(
        `INSERT INTO ecr.app_user (email, full_name, department, status) VALUES ($1, $2, $3, 'INVITED') RETURNING id`, [mail, fullName, department],
      );
      await this.applyRoles(c, actor, u.id, roles, reason, { quiet: true });
      await this.record(c, actor, 'USER_CREATED', u.id, reason, undefined, { email: mail, fullName, department, status: 'INVITED', roles });
      return u.id;
    });
    return this.get(id);
  }

  /** Edits the name and department; the email only while the account is still INVITED (afterwards DWS Hub supplies it). */
  async update(actor: Actor, targetId: string, input: Record<string, unknown>): Promise<UserSummary> {
    const reason = requireReason(input.reason);
    await this.db.tx(async (c) => {
      const target = await this.lockTarget(c, targetId);
      this.assertMayManage(actor, targetId, await this.liveRoles(c, targetId));
      const { rows: [before] } = await c.query<{ email: string; full_name: string; department: string | null }>(
        'SELECT email, full_name, department FROM ecr.app_user WHERE id = $1', [targetId]);
      const fullName = 'fullName' in input ? text(input.fullName, 'fullName', 200, true)! : before.full_name;
      const department = 'department' in input ? text(input.department, 'department', 200, false) : before.department;
      let mail = before.email;
      if ('email' in input && email(input.email) !== before.email.toLowerCase()) {
        if (target.status !== 'INVITED') {
          throw new ApiError(409, 'EMAIL_FROM_HUB', 'The email comes from DWS Hub once the person has signed in; change it in DWS Hub.', { fields: [{ field: 'email', message: 'Set by DWS Hub.' }] });
        }
        mail = email(input.email);
        const { rows: taken } = await c.query('SELECT 1 FROM ecr.app_user WHERE email = $1 AND id <> $2', [mail, targetId]);
        if (taken.length) throw new ApiError(409, 'EMAIL_TAKEN', 'An ECR account with this email already exists.', { fields: [{ field: 'email', message: 'Already has an account.' }] });
      }
      if (fullName === before.full_name && department === before.department && mail === before.email) return;
      await c.query('UPDATE ecr.app_user SET email = $2, full_name = $3, department = $4, updated_at = now() WHERE id = $1', [targetId, mail, fullName, department]);
      await this.record(c, actor, 'USER_UPDATED', targetId, reason,
        { email: before.email, fullName: before.full_name, department: before.department }, { email: mail, fullName, department });
    });
    return this.get(targetId);
  }

  /**
   * Deletes an account. One that was never used (INVITED, nothing recorded under it) is removed entirely. One with
   * history is anonymised instead, because change sets, calculations and the audit trail must keep pointing at it:
   * roles, sessions, authenticator, follows and the DWS Hub link are removed, the name and email are replaced, and it
   * is DEACTIVATED and hidden from the list. The same person can then be added again.
   */
  async remove(actor: Actor, targetId: string, reasonInput: unknown): Promise<{ id: string; result: 'REMOVED' | 'ANONYMISED' }> {
    const reason = requireReason(reasonInput);
    return this.db.tx(async (c) => {
      const target = await this.lockTarget(c, targetId);
      const roles = await this.liveRoles(c, targetId);
      this.assertMayManage(actor, targetId, roles);
      if (roles.includes('SUPER_ADMIN') && target.status === 'ACTIVE') await this.assertSuperAdminsRemain(c, targetId);
      const { rows: [before] } = await c.query<{ email: string; full_name: string }>('SELECT email, full_name FROM ecr.app_user WHERE id = $1', [targetId]);
      const was = { email: before.email, fullName: before.full_name, roles, status: target.status };

      if (target.status === 'INVITED') {
        await c.query('SAVEPOINT remove_user');
        try {
          await c.query('DELETE FROM ecr.user_role WHERE user_id = $1', [targetId]);
          await c.query('DELETE FROM ecr.app_user WHERE id = $1', [targetId]);
          await this.record(c, actor, 'USER_DELETED', targetId, reason, was, { result: 'REMOVED' });
          return { id: targetId, result: 'REMOVED' as const };
        } catch (err) {
          if ((err as { code?: string }).code !== '23503') throw err; // still referenced somewhere: anonymise instead
          await c.query('ROLLBACK TO SAVEPOINT remove_user');
        }
      }

      await c.query('UPDATE ecr.user_role SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL', [targetId, actor.id]);
      const revokedSessions = await this.sessions.revokeAllForUser(c, targetId, 'ADMIN_REVOKE');
      await c.query('DELETE FROM ecr.user_identity WHERE user_id = $1', [targetId]);
      await c.query('DELETE FROM ecr.local_credential WHERE user_id = $1', [targetId]);
      await c.query('DELETE FROM ecr.subscription WHERE user_id = $1', [targetId]);
      await c.query(
        `UPDATE ecr.app_user SET email = $2, full_name = 'Deleted user', department = NULL, status = 'DEACTIVATED',
                deactivated_reason = $3, pseudonymised_at = now(), updated_at = now() WHERE id = $1`,
        [targetId, `deleted-${targetId}@ecr.invalid`, `Deleted: ${reason}`],
      );
      await this.record(c, actor, 'USER_DELETED', targetId, reason, was, { result: 'ANONYMISED', revokedSessions });
      return { id: targetId, result: 'ANONYMISED' as const };
    });
  }

  /** Replaces the user's roles. Takes effect at once: the user's sessions are ended so access is re-evaluated. */
  async setRoles(actor: Actor, targetId: string, roleCodes: unknown, reasonInput: unknown): Promise<UserSummary> {
    const reason = requireReason(reasonInput);
    if (!Array.isArray(roleCodes) || roleCodes.some((r) => typeof r !== 'string')) {
      throw new ApiError(400, 'INVALID_INPUT', 'roles must be a list of role codes.');
    }
    const wanted = [...new Set((roleCodes as string[]).map((r) => r.trim().toUpperCase()))].sort();
    await this.db.tx((c) => this.applyRoles(c, actor, targetId, wanted, reason));
    return this.get(targetId);
  }

  /** Removes one live role inside the caller's transaction, under the same rules as setRoles (access reviews). */
  async revokeRole(c: PoolClient, actor: Actor, targetId: string, roleCode: string, reason: string): Promise<boolean> {
    await this.lockTarget(c, targetId);
    const current = await this.liveRoles(c, targetId);
    if (!current.includes(roleCode)) return false;
    return this.applyRoles(c, actor, targetId, current.filter((r) => r !== roleCode), reason);
  }

  /** Replaces the user's live roles with `wanted`; false when nothing changed. */
  private async applyRoles(c: PoolClient, actor: Actor, targetId: string, wanted: string[], reason: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const target = await this.lockTarget(c, targetId);
    const current = await this.liveRoles(c, targetId);
    this.assertMayManage(actor, targetId, [...current, ...wanted]);

    const { rows: known } = await c.query<{ id: string; code: string }>('SELECT id, code FROM ecr.role WHERE code = ANY($1)', [wanted]);
    const unknown = wanted.filter((w) => !known.some((k) => k.code === w));
    if (unknown.length) throw new ApiError(400, 'INVALID_INPUT', `Unknown role(s): ${unknown.join(', ')}`);

    if (wanted.includes('USER_ADMIN') && (wanted.includes('MAKER') || wanted.includes('CHECKER'))) {
      throw new ApiError(422, 'SOD_CONFLICT', 'USER_ADMIN cannot be combined with MAKER or CHECKER (SoD-2).');
    }
    if (current.includes('SUPER_ADMIN') && !wanted.includes('SUPER_ADMIN')) {
      await this.assertSuperAdminsRemain(c, targetId);
    }

    const removed = current.filter((r) => !wanted.includes(r));
    const added = wanted.filter((r) => !current.includes(r));
    if (!removed.length && !added.length) return false;

    await c.query(
      `UPDATE ecr.user_role ur SET revoked_at = now(), revoked_by = $2
         FROM ecr.role r
        WHERE r.id = ur.role_id AND ur.user_id = $1 AND ur.revoked_at IS NULL AND r.code = ANY($3)`,
      [targetId, actor.id, removed],
    );
    await c.query(
      `INSERT INTO ecr.user_role (user_id, role_id, granted_by)
       SELECT $1, r.id, $2 FROM ecr.role r WHERE r.code = ANY($3)`,
      [targetId, actor.id, added],
    );
    const revokedSessions = await this.sessions.revokeAllForUser(c, targetId, 'ADMIN_REVOKE');
    if (!opts.quiet) await this.record(c, actor, 'ROLES_CHANGED', target.id, reason, { roles: current }, { roles: wanted, added, removed, revokedSessions });
    return true;
  }

  async deactivate(actor: Actor, targetId: string, reasonInput: unknown): Promise<UserSummary> {
    const reason = requireReason(reasonInput);
    await this.db.tx(async (c) => {
      const target = await this.lockTarget(c, targetId);
      const roles = await this.liveRoles(c, targetId);
      this.assertMayManage(actor, targetId, roles);
      if (target.status === 'DEACTIVATED') return;
      if (roles.includes('SUPER_ADMIN')) await this.assertSuperAdminsRemain(c, targetId);

      await c.query(
        `UPDATE ecr.app_user SET status = 'DEACTIVATED', deactivated_reason = $2, updated_at = now() WHERE id = $1`,
        [targetId, reason],
      );
      const revokedSessions = await this.sessions.revokeAllForUser(c, targetId, 'USER_INACTIVE');
      await this.record(c, actor, 'USER_DEACTIVATED', targetId, reason, { status: target.status }, { status: 'DEACTIVATED', revokedSessions });
    });
    return this.get(targetId);
  }

  async reactivate(actor: Actor, targetId: string, reasonInput: unknown): Promise<UserSummary> {
    const reason = requireReason(reasonInput);
    await this.db.tx(async (c) => {
      const target = await this.lockTarget(c, targetId);
      this.assertMayManage(actor, targetId, await this.liveRoles(c, targetId));
      if (target.status === 'ACTIVE') return;
      await c.query(
        // reactivated_at restarts the 90-day dormancy clock (BR-IAM-11).
        `UPDATE ecr.app_user SET status = 'ACTIVE', deactivated_reason = NULL, access_expires_at = NULL, reactivated_at = now(),
                updated_at = now() WHERE id = $1`,
        [targetId],
      );
      await this.record(c, actor, 'USER_REACTIVATED', targetId, reason, { status: target.status }, { status: 'ACTIVE' });
    });
    return this.get(targetId);
  }

  async revokeSessions(actor: Actor, targetId: string, reasonInput: unknown): Promise<{ revokedSessions: number }> {
    const reason = requireReason(reasonInput);
    return this.db.tx(async (c) => {
      await this.lockTarget(c, targetId);
      const revokedSessions = await this.sessions.revokeAllForUser(c, targetId, 'ADMIN_REVOKE');
      await this.record(c, actor, 'SESSIONS_REVOKED', targetId, reason, undefined, { revokedSessions });
      return { revokedSessions };
    });
  }

  /** The user must enrol a new authenticator at their next privileged use (PRD US-07-P2). */
  async resetTotp(actor: Actor, targetId: string, reasonInput: unknown): Promise<UserSummary> {
    const reason = requireReason(reasonInput);
    await this.db.tx(async (c) => {
      await this.lockTarget(c, targetId);
      this.assertMayManage(actor, targetId, await this.liveRoles(c, targetId));
      const reset = await this.totp.reset(c, targetId);
      const revokedSessions = await this.sessions.revokeAllForUser(c, targetId, 'ADMIN_REVOKE');
      await this.record(c, actor, 'TOTP_RESET', targetId, reason, undefined, { hadAuthenticator: reset, revokedSessions });
    });
    return this.get(targetId);
  }

  /** SoD-3: never on yourself. BR-IAM-02: administrator accounts and roles need a Super Admin. */
  private assertMayManage(actor: Actor, targetId: string, rolesInvolved: string[]): void {
    if (actor.id === targetId) {
      throw new ApiError(403, 'SOD_VIOLATION', 'You cannot change your own access (SoD-3).');
    }
    if (rolesInvolved.some((r) => ADMIN_ROLES.includes(r)) && !actor.permissions.has('user.invite_admin')) {
      throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can change administrator accounts or roles.');
    }
  }

  private async assertSuperAdminsRemain(c: PoolClient, leavingUserId: string): Promise<void> {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(DISTINCT u.id)::int AS n
         FROM ecr.app_user u
         JOIN ecr.user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
         JOIN ecr.role r ON r.id = ur.role_id AND r.code = 'SUPER_ADMIN'
        WHERE u.status = 'ACTIVE' AND u.id <> $1`,
      [leavingUserId],
    );
    if (rows[0].n < MIN_SUPER_ADMINS) {
      throw new ApiError(409, 'SUPER_ADMIN_MINIMUM', `At least ${MIN_SUPER_ADMINS} active Super Admins are required (SoD-4).`);
    }
  }

  private async lockTarget(c: PoolClient, id: string): Promise<{ id: string; status: string }> {
    const { rows } = await c.query<{ id: string; status: string }>(
      'SELECT id, status FROM ecr.app_user WHERE id = $1 AND pseudonymised_at IS NULL AND id <> $2 FOR UPDATE', [id, SYSTEM_ACCOUNT]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    return rows[0];
  }

  private async liveRoles(c: PoolClient, userId: string): Promise<string[]> {
    const { rows } = await c.query<{ code: string }>(
      `SELECT r.code FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
        ORDER BY r.code`,
      [userId],
    );
    return rows.map((r) => r.code);
  }

  private record(c: PoolClient, actor: Actor, action: string, targetId: string, reason: string, before?: unknown, after?: unknown) {
    return this.audit.record(c, {
      action,
      actorKind: 'USER',
      actorUserId: actor.id,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      entityType: 'APP_USER',
      entityId: targetId,
      before,
      after,
      reason,
    });
  }
}
