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
  private async applyRoles(c: PoolClient, actor: Actor, targetId: string, wanted: string[], reason: string): Promise<boolean> {
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
    await this.record(c, actor, 'ROLES_CHANGED', target.id, reason, { roles: current }, { roles: wanted, added, removed, revokedSessions });
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
    const { rows } = await c.query<{ id: string; status: string }>('SELECT id, status FROM ecr.app_user WHERE id = $1 FOR UPDATE', [id]);
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
