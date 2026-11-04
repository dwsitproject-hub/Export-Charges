import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ADMIN_ROLES, UsersAdminService } from '../admin/users-admin.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { canonicalHash } from '../catalogue/calculator';
import { ApiError } from '../common/api-error';
import { wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { wibDateTime } from '../exports/present';
import { NotificationsService } from '../notifications/notifications.service';
import type { ObjectStore } from '../registry/file-handling';
import { OBJECT_STORE } from '../registry/source-documents.service';
import { renderReviewReport, ReviewReportPayload } from './review-report';

/** L2-1.9: items not decided within this many days are escalated to Super Admins. */
export const REVIEW_DAYS = 14;

const LIVE_ROLE = `ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())`;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** The quarter a WIB business date falls in, e.g. 2026-Q4. */
export function periodOf(date: string): string {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

interface CampaignRow {
  id: string;
  period_label: string;
  status: 'OPEN' | 'CLOSED';
  started_by: string | null;
  started_at: Date;
  due_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
  report_payload: ReviewReportPayload | null;
  report_content_sha256: Buffer | null;
  report_signature: Buffer | null;
  report_object_key: string | null;
  report_sha256: Buffer | null;
  report_byte_size: number | null;
}

interface ItemRow {
  id: string;
  user_id: string;
  user_name: string;
  email: string;
  user_status: string;
  role_code: string;
  role_name: string;
  granted_at: Date;
  last_login_at: Date | null;
  reviewer_role: string;
  decision: string | null;
  reason: string | null;
  reviewer_name: string | null;
  decided_at: Date | null;
  escalated_at: Date | null;
  role_live: boolean;
}

const ITEM_SELECT = `
  SELECT i.id, i.user_id, u.full_name AS user_name, u.email, i.user_status, r.code AS role_code, r.name AS role_name,
         i.granted_at, i.last_login_at, i.reviewer_role, i.decision, i.reason, rv.full_name AS reviewer_name,
         i.decided_at, i.escalated_at,
         (ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())) AS role_live
    FROM ecr.access_review_item i
    JOIN ecr.app_user u ON u.id = i.user_id
    JOIN ecr.role r ON r.id = i.role_id
    JOIN ecr.user_role ur ON ur.id = i.user_role_id
    LEFT JOIN ecr.app_user rv ON rv.id = i.reviewer_id`;

/**
 * Quarterly access reviews (PRD F-12, L2-1.9; Technical Design §4.1.7). The quarterly job snapshots every live role
 * assignment; User Admins keep or revoke each one, and assignments of administrators go to a Super Admin (BR-IAM-02).
 * Items still open after 14 days are escalated to Super Admins. The last decision closes the campaign and stores a
 * signed PDF/A report that auditors can download.
 */
@Injectable()
export class AccessReviewsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly usersAdmin: UsersAdminService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  // ------------------------------------------------------------------ the quarterly job

  /**
   * access-review job: opens this quarter's campaign if it has none yet (normally on its first day), then escalates
   * items open past their due date. `startedBy` is the Super Admin who pressed "Run now", if any.
   */
  async scheduled(startedBy: string | null, now = new Date()) {
    const period = periodOf(wibToday(now));
    const started = await this.db.tx(async (c) => {
      // Two instances could reach this at once; the unique period label makes the second insert a no-op.
      const { rows: [campaign] } = await c.query<{ id: string; due_at: Date }>(
        `INSERT INTO ecr.access_review_campaign (period_label, started_by, started_at, due_at)
         VALUES ($1, $2, $3, $3::timestamptz + make_interval(days => $4))
         ON CONFLICT (period_label) DO NOTHING RETURNING id, due_at`,
        [period, startedBy, now, REVIEW_DAYS],
      );
      if (!campaign) return null;
      const { rows: items } = await c.query<{ reviewer_role: string }>(
        `INSERT INTO ecr.access_review_item
           (campaign_id, user_role_id, user_id, role_id, user_status, last_login_at, granted_at, reviewer_role)
         SELECT $1, ur.id, ur.user_id, ur.role_id, u.status, u.last_login_at, ur.granted_at,
                CASE WHEN EXISTS (SELECT 1 FROM ecr.user_role a JOIN ecr.role ar ON ar.id = a.role_id
                                   WHERE a.user_id = ur.user_id AND ar.code = ANY($2) AND a.revoked_at IS NULL
                                     AND (a.expires_at IS NULL OR a.expires_at > now()))
                     THEN 'SUPER_ADMIN' ELSE 'USER_ADMIN' END
           FROM ecr.user_role ur JOIN ecr.app_user u ON u.id = ur.user_id
          WHERE ${LIVE_ROLE}
         RETURNING reviewer_role`,
        [campaign.id, ADMIN_ROLES],
      );
      const forSuper = items.filter((i) => i.reviewer_role === 'SUPER_ADMIN').length;
      await this.audit.record(c, {
        action: 'ACCESS_REVIEW_STARTED', actorKind: startedBy ? 'USER' : 'SYSTEM', actorUserId: startedBy ?? undefined,
        entityType: 'ACCESS_REVIEW', entityId: campaign.id,
        after: { period, items: items.length, superAdminItems: forSuper, dueAt: campaign.due_at },
      });
      await this.notifications.alert(c, { permissions: ['user.manage'] }, {
        kind: 'ACCESS_REVIEW_OPEN',
        title: `Access review ${period}: ${items.length} role assignment${items.length === 1 ? '' : 's'} to review`,
        body: `Keep or revoke each assignment by ${wibDateTime(campaign.due_at)}. ${forSuper} belong to administrators and need a Super Admin. ` +
          `Assignments not reviewed by then are escalated to Super Admins.`,
        link: `/admin/reviews/${campaign.id}`,
        dedupeKey: `access-review-open:${campaign.id}`,
      });
      return { id: campaign.id, items: items.length };
    });
    const escalated = await this.escalate(now);
    return { period, started, escalated };
  }

  /** US-12-N1 AC2: open items past the due date are marked and Super Admins are told once per campaign and day. */
  async escalate(now = new Date()): Promise<number> {
    return this.db.tx(async (c) => {
      const { rows } = await c.query<{ campaign_id: string; period_label: string; n: number }>(
        `WITH marked AS (
           UPDATE ecr.access_review_item i SET escalated_at = $1
             FROM ecr.access_review_campaign k
            WHERE k.id = i.campaign_id AND k.status = 'OPEN' AND k.due_at <= $1 AND i.decision IS NULL AND i.escalated_at IS NULL
           RETURNING i.campaign_id)
         SELECT m.campaign_id, k.period_label, count(*)::int AS n
           FROM marked m JOIN ecr.access_review_campaign k ON k.id = m.campaign_id
          GROUP BY m.campaign_id, k.period_label`,
        [now],
      );
      for (const r of rows) {
        await this.audit.record(c, {
          action: 'ACCESS_REVIEW_ESCALATED', actorKind: 'SYSTEM', entityType: 'ACCESS_REVIEW', entityId: r.campaign_id,
          after: { items: r.n, afterDays: REVIEW_DAYS },
        });
        await this.notifications.alert(c, { roles: ['SUPER_ADMIN'] }, {
          kind: 'ACCESS_REVIEW_ESCALATED',
          title: `Access review ${r.period_label}: ${r.n} assignment${r.n === 1 ? '' : 's'} not reviewed in ${REVIEW_DAYS} days`,
          body: 'These role assignments were escalated to Super Admins. Keep or revoke them so the review can be completed.',
          link: `/admin/reviews/${r.campaign_id}`,
          dedupeKey: `access-review-escalated:${r.campaign_id}:${wibToday(now)}`,
        });
      }
      return rows.reduce((s, r) => s + r.n, 0);
    });
  }

  // ------------------------------------------------------------------ reading

  async list(actor: Actor) {
    const { rows } = await this.db.query(
      `SELECT k.id, k.period_label AS "periodLabel", k.status, k.started_at AS "startedAt", k.due_at AS "dueAt", k.closed_at AS "closedAt",
              count(i.id)::int AS items,
              count(i.id) FILTER (WHERE i.decision IS NOT NULL)::int AS decided,
              count(i.id) FILTER (WHERE i.decision = 'REVOKE')::int AS revoked,
              count(i.id) FILTER (WHERE i.decision IS NULL AND i.escalated_at IS NOT NULL)::int AS escalated,
              count(i.id) FILTER (WHERE i.decision IS NULL AND i.user_id <> $1
                                    AND (i.reviewer_role = 'USER_ADMIN' OR $2::boolean))::int AS "waitingForYou"
         FROM ecr.access_review_campaign k LEFT JOIN ecr.access_review_item i ON i.campaign_id = k.id
        GROUP BY k.id ORDER BY k.started_at DESC`,
      [actor.id, actor.permissions.has('user.invite_admin')],
    );
    return rows.map((r) => ({ ...r, waitingForYou: actor.permissions.has('user.manage') ? r.waitingForYou : 0 }));
  }

  async get(actor: Actor, id: string) {
    const k = await this.campaign(this.db.pool, id);
    const { rows } = await this.db.query<ItemRow>(
      `${ITEM_SELECT} WHERE i.campaign_id = $1 ORDER BY (i.decision IS NOT NULL), u.full_name, r.code`, [id],
    );
    const { rows: [names] } = await this.db.query<{ started_by: string | null; closed_by: string | null }>(
      `SELECT s.full_name AS started_by, c.full_name AS closed_by FROM (SELECT 1) x
         LEFT JOIN ecr.app_user s ON s.id = $1 LEFT JOIN ecr.app_user c ON c.id = $2`,
      [k.started_by, k.closed_by],
    );
    return {
      id: k.id,
      periodLabel: k.period_label,
      status: k.status,
      startedAt: k.started_at,
      startedBy: names.started_by,
      dueAt: k.due_at,
      closedAt: k.closed_at,
      closedBy: names.closed_by,
      report: k.report_object_key ? {
        contentSha256: k.report_content_sha256!.toString('hex'),
        signature: k.report_signature!.toString('hex'),
        fileSha256: k.report_sha256!.toString('hex'),
        byteSize: k.report_byte_size,
      } : null,
      items: rows.map((i) => ({
        id: i.id,
        userId: i.user_id,
        user: i.user_name,
        email: i.email,
        userStatus: i.user_status,
        role: i.role_code,
        roleName: i.role_name,
        grantedAt: i.granted_at,
        lastLoginAt: i.last_login_at,
        reviewerRole: i.reviewer_role,
        decision: i.decision,
        reason: i.reason,
        reviewer: i.reviewer_name,
        decidedAt: i.decided_at,
        escalatedAt: i.escalated_at,
        roleLive: i.role_live,
        canDecide: k.status === 'OPEN' && !i.decision && this.mayDecide(actor, i).ok,
      })),
    };
  }

  // ------------------------------------------------------------------ deciding

  /** US-12-P1: keep or revoke one assignment. A revoke removes the role at once; the last decision closes the review. */
  async decide(actor: Actor, campaignId: string, itemId: string, input: { decision?: unknown; reason?: unknown }) {
    const decision = input.decision;
    if (decision !== 'KEEP' && decision !== 'REVOKE') throw new ApiError(400, 'INVALID_INPUT', 'decision must be KEEP or REVOKE.');
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null;
    if (decision === 'REVOKE' && (!reason || reason.length < 3)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Give a reason of at least 3 characters for revoking.');
    }

    const closed = await this.db.tx(async (c) => {
      // Decisions on one campaign are serialised, so exactly one of them closes it.
      const k = await this.campaign(c, campaignId, true);
      if (k.status !== 'OPEN') throw new ApiError(409, 'REVIEW_CLOSED', 'This access review is already complete.');
      const { rows: [item] } = await c.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1 AND i.campaign_id = $2 FOR UPDATE OF i`, [itemId, campaignId]);
      if (!item) throw new ApiError(404, 'NOT_FOUND', 'Review item not found.');
      if (item.decision) throw new ApiError(409, 'ALREADY_DECIDED', 'This assignment has already been reviewed.');
      const may = this.mayDecide(actor, item);
      if (!may.ok) throw may.error;
      if (decision === 'KEEP' && !item.role_live) {
        throw new ApiError(409, 'ROLE_ALREADY_REVOKED', 'This role has already been removed; record it as Revoke.');
      }

      const revoked = decision === 'REVOKE'
        ? await this.usersAdmin.revokeRole(c, actor, item.user_id, item.role_code, `Access review ${k.period_label}: ${reason}`)
        : false;
      await c.query(
        `UPDATE ecr.access_review_item SET decision = $2, reason = $3, reviewer_id = $4, decided_at = now() WHERE id = $1`,
        [itemId, decision, reason, actor.id],
      );
      await this.audit.record(c, {
        action: 'ACCESS_REVIEW_DECIDED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
        entityType: 'ACCESS_REVIEW', entityId: campaignId, reason: reason ?? undefined,
        after: { itemId, userId: item.user_id, role: item.role_code, decision, roleRevoked: revoked },
      });

      const { rows: [open] } = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ecr.access_review_item WHERE campaign_id = $1 AND decision IS NULL', [campaignId],
      );
      if (open.n === 0) {
        await this.close(c, actor, k);
        return true;
      }
      return false;
    });
    return { ...(await this.get(actor, campaignId)), closed };
  }

  /** SoD-3: not your own access. BR-IAM-02: administrators' assignments need a Super Admin. */
  private mayDecide(actor: Actor, item: Pick<ItemRow, 'user_id' | 'reviewer_role'>): { ok: true } | { ok: false; error: ApiError } {
    if (!actor.permissions.has('user.manage')) {
      return { ok: false, error: new ApiError(403, 'FORBIDDEN', "You don't have access to this function.") };
    }
    if (item.user_id === actor.id) {
      return { ok: false, error: new ApiError(403, 'SOD_VIOLATION', 'You cannot review your own access (SoD-3); another administrator must.') };
    }
    if (item.reviewer_role === 'SUPER_ADMIN' && !actor.permissions.has('user.invite_admin')) {
      return { ok: false, error: new ApiError(403, 'FORBIDDEN', "Only a Super Admin can review an administrator's access.") };
    }
    return { ok: true };
  }

  /** US-12-P1 AC1: the completed review produces a signed report, stored with the campaign. */
  private async close(c: PoolClient, actor: Actor, k: CampaignRow) {
    const { rows: [meta] } = await c.query<{ now: Date; closer: string; closer_email: string; starter: string | null }>(
      `SELECT now() AS now, a.full_name AS closer, a.email AS closer_email, s.full_name AS starter
         FROM ecr.app_user a LEFT JOIN ecr.app_user s ON s.id = $2 WHERE a.id = $1`,
      [actor.id, k.started_by],
    );
    const { rows } = await c.query<ItemRow>(`${ITEM_SELECT} WHERE i.campaign_id = $1 ORDER BY u.full_name, r.code`, [k.id]);
    const payload: ReviewReportPayload = {
      campaignId: k.id,
      periodLabel: k.period_label,
      startedAt: k.started_at.toISOString(),
      startedBy: meta.starter ?? 'the quarterly job',
      dueAt: k.due_at.toISOString(),
      closedAt: meta.now.toISOString(),
      closedBy: { name: meta.closer, email: meta.closer_email },
      totals: {
        items: rows.length,
        kept: rows.filter((i) => i.decision === 'KEEP').length,
        revoked: rows.filter((i) => i.decision === 'REVOKE').length,
        escalated: rows.filter((i) => i.escalated_at).length,
      },
      items: rows.map((i) => ({
        user: i.user_name,
        email: i.email,
        userStatus: i.user_status,
        role: i.role_name,
        grantedAt: i.granted_at.toISOString(),
        lastLoginAt: i.last_login_at?.toISOString() ?? null,
        reviewerRole: i.reviewer_role,
        decision: i.decision!,
        reason: i.reason,
        reviewer: i.reviewer_name!,
        decidedAt: i.decided_at!.toISOString(),
        escalatedAt: i.escalated_at?.toISOString() ?? null,
      })),
    };
    const content = canonicalHash(payload);
    const signature = this.sign(k.id, content);
    const pdf = renderReviewReport(payload, content.toString('hex'), signature.toString('hex'));
    const key = `access-reviews/${k.period_label.toLowerCase()}-${k.id}.pdf`;
    await this.store.put(key, pdf);
    await c.query(
      `UPDATE ecr.access_review_campaign
          SET status = 'CLOSED', closed_at = $2, closed_by = $3, report_payload = $4, report_content_sha256 = $5,
              report_signature = $6, report_object_key = $7, report_sha256 = $8, report_byte_size = $9
        WHERE id = $1`,
      [k.id, meta.now, actor.id, JSON.stringify(payload), content, signature, key, sha256(pdf), pdf.length],
    );
    await this.audit.record(c, {
      action: 'ACCESS_REVIEW_COMPLETED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'ACCESS_REVIEW', entityId: k.id,
      after: { ...payload.totals, contentSha256: content.toString('hex'), signature: signature.toString('hex'), fileSha256: sha256(pdf).toString('hex') },
    });
    await this.notifications.alert(c, { roles: ['AUDITOR', 'SUPER_ADMIN'] }, {
      kind: 'ACCESS_REVIEW_COMPLETED',
      title: `Access review ${k.period_label} is complete`,
      body: `${payload.totals.kept} assignment(s) kept and ${payload.totals.revoked} revoked. The signed report can be downloaded.`,
      link: `/admin/reviews/${k.id}`,
      dedupeKey: `access-review-completed:${k.id}`,
    });
  }

  // ------------------------------------------------------------------ the report

  async reportFile(actor: Actor, id: string): Promise<{ body: Buffer; filename: string }> {
    const k = await this.campaign(this.db.pool, id);
    if (!k.report_object_key) throw new ApiError(409, 'REPORT_NOT_READY', 'The report is produced when every assignment has been reviewed.');
    const body = await this.store.get(k.report_object_key);
    if (!sha256(body).equals(k.report_sha256!)) {
      throw new ApiError(409, 'REPORT_INTEGRITY', 'The stored report does not match its recorded checksum.');
    }
    await this.audit.record(this.db.pool, {
      action: 'ACCESS_REVIEW_REPORT_DOWNLOADED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'ACCESS_REVIEW', entityId: k.id,
    });
    return { body, filename: `ECR-access-review-${k.period_label}.pdf` };
  }

  /** The stored file still matches its hash, the stored content still matches the printed hash, and the signature holds. */
  async verifyReport(id: string) {
    const k = await this.campaign(this.db.pool, id);
    if (!k.report_object_key) throw new ApiError(409, 'REPORT_NOT_READY', 'The report is produced when every assignment has been reviewed.');
    let fileIntact = false;
    try {
      fileIntact = sha256(await this.store.get(k.report_object_key)).equals(k.report_sha256!);
    } catch {
      fileIntact = false;
    }
    const contentIntact = canonicalHash(k.report_payload).equals(k.report_content_sha256!);
    const expected = this.sign(k.id, k.report_content_sha256!);
    const signatureValid = expected.length === k.report_signature!.length && timingSafeEqual(expected, k.report_signature!);
    return {
      valid: fileIntact && contentIntact && signatureValid,
      fileIntact,
      contentIntact,
      signatureValid,
      contentSha256: k.report_content_sha256!.toString('hex'),
      signature: k.report_signature!.toString('hex'),
    };
  }

  private sign(campaignId: string, contentSha256: Buffer): Buffer {
    return createHmac('sha256', this.config.encryptionKey).update(`ecr-access-review:${campaignId}:${contentSha256.toString('hex')}`).digest();
  }

  private async campaign(q: PoolClient | DbService['pool'], id: string, lock = false): Promise<CampaignRow> {
    const { rows: [k] } = await q.query<CampaignRow>(
      `SELECT * FROM ecr.access_review_campaign WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id],
    );
    if (!k) throw new ApiError(404, 'NOT_FOUND', 'Access review not found.');
    return k;
  }
}
