import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import type { HubClaims } from './oidc.service';

export interface BoundUser {
  id: string;
  email: string;
  fullName: string;
  provisioned: boolean;
}

/**
 * Maps a verified DWS Hub identity to an ECR account (Technical Design §4.1.2).
 * DWS Hub decides who may use ECR (its own invitations and access requests), so an unknown `sub`
 * gets an ECR account just-in-time with the configured default roles. The Hub `sub` is the only key;
 * `email` and `name` are profile data.
 */
@Injectable()
export class UserBindingService {
  private readonly logger = new Logger(UserBindingService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async bind(client: PoolClient, claims: HubClaims, issuer: string, ctx: { ip: string; userAgent?: string }): Promise<BoundUser> {
    const existing = await client.query<{ id: string; email: string; full_name: string; status: string; access_expires_at: Date | null }>(
      `SELECT u.id, u.email, u.full_name, u.status, u.access_expires_at
         FROM ecr.user_identity i JOIN ecr.app_user u ON u.id = i.user_id
        WHERE i.provider = 'DWS_HUB' AND i.subject = $1
        FOR UPDATE OF u`,
      [claims.sub],
    );

    if (existing.rows[0]) {
      const u = existing.rows[0];
      if (u.access_expires_at && u.access_expires_at.getTime() <= Date.now() && u.status === 'ACTIVE') {
        await client.query(`UPDATE ecr.app_user SET status = 'EXPIRED', updated_at = now() WHERE id = $1`, [u.id]);
        u.status = 'EXPIRED';
      }
      if (u.status !== 'ACTIVE') {
        throw new ApiError(403, 'LOGIN_BLOCKED', 'Your account is not active. Contact your administrator.', { userId: u.id, status: u.status });
      }
      // Profile snapshot only; email and name never select the account (DWS Hub contract §4).
      // An email already used by another account is left unchanged rather than failing the sign-in.
      await client.query(
        `UPDATE ecr.app_user u
            SET email = CASE WHEN $2::citext IS NULL
                               OR EXISTS (SELECT 1 FROM ecr.app_user o WHERE o.email = $2::citext AND o.id <> u.id)
                             THEN u.email ELSE $2::citext END,
                full_name = COALESCE($3, u.full_name),
                last_login_at = now(), updated_at = now()
          WHERE u.id = $1`,
        [u.id, claims.email ?? null, claims.name ?? null],
      );
      await client.query(
        `UPDATE ecr.user_identity SET last_seen_at = now() WHERE provider = 'DWS_HUB' AND subject = $1`,
        [claims.sub],
      );
      return { id: u.id, email: claims.email ?? u.email, fullName: claims.name ?? u.full_name, provisioned: false };
    }

    if (!claims.email) {
      throw new ApiError(403, 'LOGIN_NO_EMAIL', 'DWS Hub did not provide an email for this account.', { hubSubject: claims.sub });
    }

    // An administrator added this person before their first sign-in (Users → Add user): the account waits, INVITED and
    // not linked to any Hub identity, for exactly this email. Their first sign-in links it and keeps the roles chosen.
    const invited = await client.query<{ id: string; email: string; full_name: string }>(
      `SELECT u.id, u.email, u.full_name FROM ecr.app_user u
        WHERE u.email = $1 AND u.status = 'INVITED' AND u.pseudonymised_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ecr.user_identity i WHERE i.user_id = u.id)
        FOR UPDATE`,
      [claims.email],
    );
    if (invited.rows[0]) {
      const u = invited.rows[0];
      await client.query(
        `UPDATE ecr.app_user SET status = 'ACTIVE', full_name = COALESCE($2, full_name), last_login_at = now(), updated_at = now() WHERE id = $1`,
        [u.id, claims.name ?? null],
      );
      await client.query(
        `INSERT INTO ecr.user_identity (user_id, provider, subject, issuer, email_at_link, last_seen_at)
         VALUES ($1, 'DWS_HUB', $2, $3, $4, now())`,
        [u.id, claims.sub, issuer, claims.email],
      );
      await this.audit.record(client, {
        action: 'USER_INVITE_ACCEPTED',
        actorKind: 'SYSTEM',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        entityType: 'APP_USER',
        entityId: u.id,
        after: { provider: 'DWS_HUB', hubSubject: claims.sub, email: claims.email, status: 'ACTIVE' },
      });
      return { id: u.id, email: u.email, fullName: claims.name ?? u.full_name, provisioned: false };
    }

    // Another Hub identity already owns this email. Linking it silently could hand one person's
    // account to another, so an administrator has to resolve it.
    const clash = await client.query<{ id: string }>('SELECT id FROM ecr.app_user WHERE email = $1', [claims.email]);
    if (clash.rows[0]) {
      throw new ApiError(403, 'LOGIN_IDENTITY_CONFLICT', 'This email already belongs to another ECR account. Contact your administrator.', {
        hubSubject: claims.sub,
        email: claims.email,
        existingUserId: clash.rows[0].id,
      });
    }

    const user = await client.query<{ id: string; email: string; full_name: string }>(
      `INSERT INTO ecr.app_user (email, full_name, status, last_login_at)
       VALUES ($1, $2, 'ACTIVE', now())
       RETURNING id, email, full_name`,
      [claims.email, claims.name ?? claims.email],
    );
    const u = user.rows[0];

    await client.query(
      `INSERT INTO ecr.user_identity (user_id, provider, subject, issuer, email_at_link, last_seen_at)
       VALUES ($1, 'DWS_HUB', $2, $3, $4, now())`,
      [u.id, claims.sub, issuer, claims.email],
    );

    const roles = await client.query<{ code: string }>(
      `INSERT INTO ecr.user_role (user_id, role_id, granted_by)
       SELECT $1, r.id, NULL FROM ecr.role r WHERE r.code = ANY($2)
       RETURNING (SELECT code FROM ecr.role WHERE id = role_id) AS code`,
      [u.id, this.config.jitDefaultRoles],
    );
    const granted = roles.rows.map((r) => r.code).sort();
    if (granted.length !== this.config.jitDefaultRoles.length) {
      this.logger.warn(`JIT_DEFAULT_ROLES contains unknown roles: ${this.config.jitDefaultRoles.join(',')}`);
    }

    await this.audit.record(client, {
      action: 'USER_PROVISIONED',
      actorKind: 'SYSTEM',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      entityType: 'APP_USER',
      entityId: u.id,
      after: { provider: 'DWS_HUB', hubSubject: claims.sub, email: claims.email, roles: granted },
    });
    return { id: u.id, email: u.email, fullName: u.full_name, provisioned: true };
  }
}
