import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { randomToken, sha256 } from '../common/crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Queryable } from '../db/db.service';

export type RevokeReason = 'LOGOUT' | 'LOGOUT_ALL' | 'EXPIRED' | 'SESSION_LIMIT' | 'ADMIN_REVOKE' | 'USER_INACTIVE';

export interface SessionRow {
  id: string;
  user_id: string;
  auth_method: 'DWS_HUB' | 'LOCAL';
  csrf_token: string;
  idle_timeout_minutes: number;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  stepped_up_at: Date | null;
  revoked_at: Date | null;
}

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  status: string;
  access_expires_at: Date | null;
}

export interface LookedUpSession {
  session: SessionRow;
  user: SessionUser;
  /** True when the idle or absolute limit has passed (session not yet revoked). */
  expired: boolean;
}

const TOUCH_INTERVAL_MS = 60_000;

/** Server-side sessions (BR-IAM-08): the cookie holds a random token; only its SHA-256 is stored. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
  ) {}

  async create(
    q: Queryable,
    p: { userId: string; authMethod: 'DWS_HUB' | 'LOCAL'; idTokenHash?: Buffer; ip: string; userAgent?: string },
  ): Promise<{ token: string; session: SessionRow }> {
    const privileged = await this.isPrivileged(q, p.userId);
    const idle = privileged ? this.config.privilegedIdleMinutes : this.config.sessionIdleMinutes;

    // Keep at most maxSessionsPerUser live sessions: revoke the oldest beyond (max - 1) before adding one.
    await q.query(
      `UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = 'SESSION_LIMIT'
        WHERE id IN (SELECT id FROM ecr.user_session
                      WHERE user_id = $1 AND revoked_at IS NULL
                      ORDER BY created_at DESC OFFSET $2)`,
      [p.userId, this.config.maxSessionsPerUser - 1],
    );

    const token = randomToken();
    const { rows } = await q.query<SessionRow>(
      `INSERT INTO ecr.user_session
         (token_hash, user_id, auth_method, id_token_hash, csrf_token, idle_timeout_minutes,
          absolute_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8, $9)
       RETURNING *`,
      [sha256(token), p.userId, p.authMethod, p.idTokenHash ?? null, randomToken(), idle,
        this.config.sessionAbsoluteHours, p.ip || null, p.userAgent ?? null],
    );
    return { token, session: rows[0] };
  }

  /** Finds the session for a cookie token, live or not. Returns null when unknown or already revoked. */
  async lookup(token: string | undefined): Promise<LookedUpSession | null> {
    if (!token) return null;
    const { rows } = await this.db.query<SessionRow & { u_email: string; u_full_name: string; u_status: string; u_access_expires_at: Date | null; is_expired: boolean }>(
      `SELECT s.*, u.email AS u_email, u.full_name AS u_full_name, u.status AS u_status,
              u.access_expires_at AS u_access_expires_at,
              (now() >= s.absolute_expires_at
               OR now() >= s.last_seen_at + make_interval(mins => s.idle_timeout_minutes)) AS is_expired
         FROM ecr.user_session s JOIN ecr.app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      session: r,
      user: { id: r.user_id, email: r.u_email, full_name: r.u_full_name, status: r.u_status, access_expires_at: r.u_access_expires_at },
      expired: r.is_expired,
    };
  }

  /** Validates a live session for a protected request; throws 401 and revokes when it cannot be used. */
  async requireLive(token: string | undefined): Promise<LookedUpSession> {
    const found = await this.lookup(token);
    if (!found) throw new ApiError(401, 'NOT_SIGNED_IN', 'Please sign in.');
    if (found.expired) {
      await this.revoke(this.db.pool, found.session.id, 'EXPIRED');
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
    }
    const accessEnded = found.user.access_expires_at && found.user.access_expires_at.getTime() <= Date.now();
    if (found.user.status !== 'ACTIVE' || accessEnded) {
      await this.revokeAllForUser(this.db.pool, found.user.id, 'USER_INACTIVE');
      throw new ApiError(401, 'NOT_SIGNED_IN', 'Your account is not active. Contact your administrator.');
    }
    if (Date.now() - found.session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.query('UPDATE ecr.user_session SET last_seen_at = now() WHERE id = $1', [found.session.id]);
    }
    return found;
  }

  async revoke(q: Queryable, sessionId: string, reason: RevokeReason): Promise<number> {
    const { rowCount } = await q.query(
      'UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, reason],
    );
    return rowCount ?? 0;
  }

  async revokeAllForUser(q: Queryable, userId: string, reason: RevokeReason): Promise<number> {
    const { rowCount } = await q.query(
      'UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, reason],
    );
    return rowCount ?? 0;
  }

  async isPrivileged(q: Queryable, userId: string): Promise<boolean> {
    const { rows } = await q.query<{ privileged: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND ur.revoked_at IS NULL
            AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND r.is_privileged) AS privileged`,
      [userId],
    );
    return rows[0].privileged;
  }

  /**
   * Live roles and effective permissions. `privileged` drives the shorter idle timeout; `totpRequired` the ECR authenticator
   * (enrolment and step-up), which roles in TOTP_EXEMPT_ROLES (default Super Admin) never need.
   */
  async access(userId: string): Promise<{ roles: string[]; permissions: string[]; privileged: boolean; totpRequired: boolean }> {
    const { rows } = await this.db.query<{ role: string; is_privileged: boolean; permission: string | null }>(
      `SELECT r.code AS role, r.is_privileged, rp.permission_code AS permission
         FROM ecr.user_role ur
         JOIN ecr.role r ON r.id = ur.role_id
         LEFT JOIN ecr.role_permission rp ON rp.role_id = r.id
        WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [userId],
    );
    const roles = [...new Set(rows.map((r) => r.role))].sort();
    const privileged = rows.some((r) => r.is_privileged);
    return {
      roles,
      permissions: [...new Set(rows.map((r) => r.permission).filter((p): p is string => !!p))].sort(),
      privileged,
      totpRequired: privileged && !roles.some((r) => this.config.totpExemptRoles.includes(r)),
    };
  }
}
