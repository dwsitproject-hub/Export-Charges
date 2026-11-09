import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AUTO_UPDATE_USER_ID } from '../auto-update/system-account';
import { ApiError } from '../common/api-error';
import { safeEqual } from '../common/crypto';
import { asObject, UUID_RE, wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Queryable } from '../db/db.service';
import { wibDateTime } from '../exports/present';
import { CandidateState } from '../registry/candidate';
import { CommodityData, ENTITY_DEFS, EntityData, EntityType, GroupData, ProductData } from '../registry/entities';
import { affectedProducts, compareCharges } from '../tariffs/impact';
import { MAIL_SENDER, MailSender } from './mail';

const SCOPE_TYPES = ['COMMODITY', 'PRODUCT_GROUP', 'PRODUCT'] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];
const MAX_ATTEMPTS = 8;
/** Minutes before attempt n + 1 (n = attempts so far). */
const BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60, 120, 240];

interface Recipient {
  id: string;
  email: string;
}

interface Notice {
  kind: string;
  title: string;
  body: string;
  link: string;
  changeSetId?: string | null;
  versionNo?: number | null;
  dedupeKey: string;
  /** Extra email lines per recipient, e.g. unsubscribe links. */
  footer?: (userId: string) => string;
}

/** The change set fields notifications need. */
export interface SetInfo {
  id: string;
  title: string;
  kind: string;
  created_by: string;
}

/** A published change item, as stored. */
export interface PublishedItem {
  entity_type: EntityType;
  entity_id: string;
  operation: string;
  before: EntityData | null;
  after: EntityData;
}

const ACTIVE_ROLE = `ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())`;

/**
 * In-app notifications and email (PRD L2-5 step 2, US-29-P1 AC1, US-29-N2 AC1, F-48; Technical Design §4.2.7).
 * Every notice is written in the caller's transaction, so it exists exactly when the workflow change does; the
 * email-outbox job sends the emails afterwards. Emails hold a title and a link, never draft data (US-48-N1 AC2), and
 * deactivated users receive nothing.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Notifications');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  onModuleInit(): void {
    if (this.config.emailOutboxIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.sendDue().catch((err) => this.logger.error(`email-outbox failed: ${(err as Error).message}`));
      }, this.config.emailOutboxIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ workflow events

  /** US-29-P1 AC1: a set waits for review; every active Checker except its editors (SoD-1) is told. */
  async submitted(q: Queryable, set: SetInfo, editors: string[]) {
    const rollback = set.kind === 'ROLLBACK';
    await this.deliver(q, await this.checkers(q, editors), {
      kind: rollback ? 'ROLLBACK_SUBMITTED' : 'CHANGESET_SUBMITTED',
      title: rollback ? `Rollback waiting for review: ${set.title}` : `Change set waiting for review: ${set.title}`,
      body: rollback
        ? 'A Checker asked to roll back a published version. Another Checker must review and approve it.'
        : set.created_by === AUTO_UPDATE_USER_ID
          ? 'ECR drafted this change by itself from the official source. Compare it with the PDF, then approve or reject it in ECR.'
          : 'A Maker submitted a change set. Start the review in ECR.',
      link: `/change-sets/${set.id}`,
      changeSetId: set.id,
      dedupeKey: `submitted:${set.id}:${Date.now()}`,
    });
  }

  /** US-29-N2 AC1: the Maker learns the set was rejected; the comments are read in ECR. */
  async rejected(q: Queryable, set: SetInfo) {
    await this.toMaker(q, set, 'CHANGESET_REJECTED', `Change set rejected: ${set.title}`,
      'A Checker rejected your change set. Open it to read the comments and rework it.');
  }

  /** Validation failed when the review started, so the set is back with the Maker. */
  async returned(q: Queryable, set: SetInfo) {
    await this.toMaker(q, set, 'CHANGESET_RETURNED', `Change set returned: ${set.title}`,
      'The change set no longer passed validation when the review started and is a draft again. Open it to see the findings.');
  }

  async scheduled(q: Queryable, set: SetInfo, effectiveDate: string) {
    await this.toMaker(q, set, 'CHANGESET_SCHEDULED', `Change set approved for ${effectiveDate}: ${set.title}`,
      `A Checker approved your change set. It will be published at 00:00 WIB on ${effectiveDate}.`);
  }

  async scheduleCancelled(q: Queryable, set: SetInfo) {
    await this.toMaker(q, set, 'CHANGESET_SCHEDULE_CANCELLED', `Schedule cancelled: ${set.title}`,
      'A Checker cancelled the scheduled publication. The change set is a draft again; the reason is in the audit log.');
  }

  /**
   * A version was published: its Maker is told, and so is everyone following a commodity, group or product the
   * version affects — one notice per person whatever the number of matching subscriptions (US-48-P1, US-48-N1 AC1).
   */
  async published(q: Queryable, set: SetInfo, versionNo: number, items: PublishedItem[], publishedBy: string | null = null) {
    await this.toMaker(q, set, 'CHANGESET_PUBLISHED', `Published as version ${versionNo}: ${set.title}`,
      `Your change set is now data version ${versionNo}.`, versionNo);
    // A change ECR drafted by itself and a Checker approved: everyone hears of it (after the followers' own notices).
    const announceToAll = set.created_by === AUTO_UPDATE_USER_ID && publishedBy !== AUTO_UPDATE_USER_ID;

    const scopes = await this.affectedScopes(q, versionNo, items);
    if (scopes.size) await this.notifyFollowers(q, set, versionNo, scopes);
    if (announceToAll) {
      const checker = publishedBy ? (await q.query<{ full_name: string }>('SELECT full_name FROM ecr.app_user WHERE id = $1', [publishedBy])).rows[0]?.full_name : null;
      await this.everyone(q, {
        kind: 'AUTO_UPDATE',
        title: `Updated: ${set.title.replace(/ — (automatic update|drafted by ECR for a Checker)$/, '')}`,
        body: `ECR prepared this change from the official source${checker ? ` and ${checker} checked and approved it` : ' and a Checker approved it'}. It is published as data version ${versionNo}.`,
        link: `/bulletins/${versionNo}`, versionNo, changeSetId: set.id, dedupeKey: `published:${versionNo}`,
      });
    }
  }

  /** Everyone following a commodity, group or product the version affects: one notice per person. */
  private async notifyFollowers(q: Queryable, set: SetInfo, versionNo: number, scopes: Awaited<ReturnType<NotificationsService['affectedScopes']>>) {
    const { rows } = await q.query<{ id: string; user_id: string; email: string; scope_entity_id: string }>(
      `SELECT s.id, s.user_id, u.email, s.scope_entity_id
         FROM ecr.subscription s JOIN ecr.app_user u ON u.id = s.user_id
        WHERE s.scope_entity_id = ANY($1::uuid[]) AND u.status = 'ACTIVE'
        ORDER BY s.created_at`,
      [[...scopes.keys()]],
    );
    const byUser = new Map<string, { email: string; subs: typeof rows }>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { email: r.email, subs: [] });
      byUser.get(r.user_id)!.subs.push(r);
    }
    for (const [userId, { email, subs }] of byUser) {
      const products = [...new Set(subs.flatMap((s) => scopes.get(s.scope_entity_id)!.products))].sort();
      const followed = subs.map((s) => scopes.get(s.scope_entity_id)!.label);
      const shown = products.slice(0, 5).join(', ') + (products.length > 5 ? ` and ${products.length - 5} more` : '');
      await this.deliver(q, [{ id: userId, email }], {
        kind: 'VERSION_PUBLISHED',
        title: `Version ${versionNo} published: ${set.title}`,
        body: products.length
          ? `Published changes affect ${products.length === 1 ? 'a product' : `${products.length} products`} you follow: ${shown}.`
          : `Published changes affect ${followed.join(', ')}, which you follow.`,
        link: `/bulletins/${versionNo}`,
        changeSetId: set.id,
        versionNo,
        dedupeKey: `published:${versionNo}`,
        footer: () => subs.map((s) =>
          `You follow ${scopes.get(s.scope_entity_id)!.label}. Stop following it: ${this.config.publicBaseUrl}/unsubscribe?token=${this.unsubscribeToken(s.id)}`).join('\n'),
      });
    }
  }

  /** A scheduled set could not be published by the job; Checkers and the Maker are alerted once a day. */
  async publishFailed(q: Queryable, set: SetInfo, message: string) {
    const maker = await this.activeUsers(q, [set.created_by]);
    const checkers = await this.checkers(q, []);
    const recipients = [...new Map([...checkers, ...maker].map((r) => [r.id, r])).values()];
    await this.deliver(q, recipients, {
      kind: 'CHANGESET_PUBLISH_FAILED',
      title: `Scheduled publication failed: ${set.title}`,
      body: `The change set stays scheduled and is retried every minute. Reason: ${message}`,
      link: `/change-sets/${set.id}`,
      changeSetId: set.id,
      dedupeKey: `publish-failed:${set.id}:${wibToday()}`,
    });
  }

  // ------------------------------------------------------------------ export jobs

  /** US-47-N1 AC3: a large export is ready; the link opens it in ECR, where only the requester can download it. */
  async exportReady(q: Queryable, userId: string, job: { id: string; rows: number; format: string; expiresAt: Date }) {
    await this.deliver(q, await this.activeUsers(q, [userId]), {
      kind: 'EXPORT_READY',
      title: `Your catalogue export is ready (${job.rows.toLocaleString('en')} ${job.rows === 1 ? 'row' : 'rows'})`,
      body: `The ${job.format.toUpperCase()} file can be downloaded in ECR until ${wibDateTime(job.expiresAt)}. Only you can download it, after signing in.`,
      link: `/exports/${job.id}`,
      dedupeKey: `export-ready:${job.id}`,
    });
  }

  async exportFailed(q: Queryable, userId: string, jobId: string, reason: string) {
    await this.deliver(q, await this.activeUsers(q, [userId]), {
      kind: 'EXPORT_FAILED',
      title: 'Your catalogue export could not be prepared',
      body: `${reason} Narrow the search or filters and try again, or ask the ECR administrators.`,
      link: `/exports/${jobId}`,
      dedupeKey: `export-failed:${jobId}`,
    });
  }

  // ------------------------------------------------------------------ in-app reads

  async list(userId: string, unreadOnly: boolean) {
    const { rows } = await this.db.query(
      `SELECT id, kind, title, body, link, version_no AS "versionNo", created_at AS "createdAt", read_at AS "readAt"
         FROM ecr.notification WHERE user_id = $1 AND ($2 = false OR read_at IS NULL)
        ORDER BY created_at DESC LIMIT 100`,
      [userId, unreadOnly],
    );
    return rows;
  }

  async unreadCount(userId: string) {
    const { rows } = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM ecr.notification WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return { unread: rows[0].n };
  }

  async markRead(userId: string, id: string | null) {
    await this.db.query(
      'UPDATE ecr.notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2)',
      [userId, id],
    );
    return this.unreadCount(userId);
  }

  // ------------------------------------------------------------------ subscriptions

  async subscriptions(userId: string) {
    const { rows } = await this.db.query<{ id: string; scope_type: ScopeType; scope_entity_id: string; created_at: Date }>(
      'SELECT id, scope_type, scope_entity_id, created_at FROM ecr.subscription WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    const state = await CandidateState.load(this.db.pool);
    return rows.map((r) => ({
      id: r.id,
      scopeType: r.scope_type,
      scopeEntityId: r.scope_entity_id,
      label: scopeLabel(state, r.scope_type, r.scope_entity_id) ?? 'No longer in the published data',
      createdAt: r.created_at,
    }));
  }

  async subscribe(actor: Actor, input: unknown) {
    const b = asObject(input);
    const scopeType = b.scopeType as ScopeType;
    const id = typeof b.scopeEntityId === 'string' ? b.scopeEntityId.toLowerCase() : '';
    if (!SCOPE_TYPES.includes(scopeType)) throw new ApiError(400, 'INVALID_INPUT', `scopeType must be one of ${SCOPE_TYPES.join(', ')}.`);
    const state = await CandidateState.load(this.db.pool);
    if (!UUID_RE.test(id) || !state.has(id, scopeType)) throw new ApiError(404, 'NOT_FOUND', 'Not found in the published data.');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO ecr.subscription (user_id, scope_type, scope_entity_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, scope_type, scope_entity_id) DO NOTHING RETURNING id`,
      [actor.id, scopeType, id],
    );
    if (rows[0]) await this.record(actor, 'SUBSCRIPTION_ADDED', rows[0].id, { scopeType, scopeEntityId: id });
    return this.subscriptions(actor.id);
  }

  async unsubscribe(actor: Actor, id: string) {
    const { rows } = await this.db.query<{ id: string }>('DELETE FROM ecr.subscription WHERE id = $1 AND user_id = $2 RETURNING id', [id, actor.id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Subscription not found.');
    await this.record(actor, 'SUBSCRIPTION_REMOVED', id, {});
    return this.subscriptions(actor.id);
  }

  /** One-click unsubscribe from an email link (US-48-N1 AC1); the signed token is the authorisation. */
  async unsubscribeByToken(token: unknown) {
    const [id, mac] = typeof token === 'string' ? token.split('.') : [];
    if (!id || !mac || !UUID_RE.test(id) || !safeEqual(Buffer.from(mac), Buffer.from(this.unsubscribeToken(id).split('.')[1]))) {
      throw new ApiError(400, 'INVALID_TOKEN', 'This unsubscribe link is not valid.');
    }
    const { rows } = await this.db.query<{ user_id: string; scope_type: ScopeType; scope_entity_id: string }>(
      'DELETE FROM ecr.subscription WHERE id = $1 RETURNING user_id, scope_type, scope_entity_id', [id],
    );
    if (!rows[0]) return { unsubscribed: true, label: null };
    await this.audit.record(this.db.pool, {
      action: 'SUBSCRIPTION_REMOVED', actorKind: 'USER', actorUserId: rows[0].user_id, entityType: 'SUBSCRIPTION', entityId: id,
      after: { via: 'email link' },
    });
    const state = await CandidateState.load(this.db.pool);
    return { unsubscribed: true, label: scopeLabel(state, rows[0].scope_type, rows[0].scope_entity_id) };
  }

  unsubscribeToken(subscriptionId: string): string {
    const mac = createHmac('sha256', this.config.encryptionKey).update(`ecr-unsubscribe:${subscriptionId}`).digest('base64url');
    return `${subscriptionId}.${mac}`;
  }

  // ------------------------------------------------------------------ change bulletin

  /**
   * The change bulletin of a version (US-29-P2 AC3, PRD 7.4): what it changed and the duty and levy per tonne of
   * every affected product before and after, on its publication date. Published data only.
   */
  async bulletin(versionNo: number) {
    const { rows: [v] } = await this.db.query<{
      version_no: number; published_at: Date; bulletin: { items: { entityType: string; operation: string; label: string }[] };
      rolled_back_by_version: number | null; change_set_id: string; title: string; kind: string; rollback_of_version: number | null;
    }>(
      `SELECT v.version_no, v.published_at, v.bulletin, v.rolled_back_by_version, v.change_set_id, cs.title, cs.kind, cs.rollback_of_version
         FROM ecr.data_version v JOIN ecr.change_set cs ON cs.id = v.change_set_id WHERE v.version_no = $1`,
      [versionNo],
    );
    if (!v) throw new ApiError(404, 'NOT_FOUND', `Data version ${versionNo} does not exist.`);
    const { rows: items } = await this.db.query<PublishedItem>(
      'SELECT entity_type, entity_id, operation, before, after FROM ecr.change_item WHERE change_set_id = $1', [v.change_set_id],
    );
    const before = await CandidateState.load(this.db.pool, [], versionNo - 1);
    const after = await CandidateState.load(this.db.pool, [], versionNo);
    const date = wibToday(v.published_at);
    const products = affectedProducts([before, after], items.map((i) => ({ entityType: i.entity_type, entityId: i.entity_id, before: i.before, after: i.after })));
    return {
      versionNo: v.version_no,
      publishedAt: v.published_at,
      title: v.title,
      kind: v.kind,
      rollbackOfVersion: v.rollback_of_version,
      rolledBackByVersion: v.rolled_back_by_version,
      items: v.bulletin.items.map(({ entityType, operation, label }) => ({ entityType, operation, label })),
      date,
      impact: compareCharges(before, after, products, date),
    };
  }

  // ------------------------------------------------------------------ email-outbox job

  /**
   * Sends due emails with retry and back-off; a person deactivated meanwhile receives nothing. "Due" is judged by the
   * database clock that stamped the rows, so a small clock difference with the API host cannot hold emails back.
   */
  async sendDue(now: Date | null = null): Promise<{ sent: number; failed: number }> {
    const { rows } = await this.db.query<{ id: string; to_email: string; subject: string; body_text: string; attempts: number; active: boolean }>(
      `UPDATE ecr.email_outbox o SET attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
        WHERE o.id IN (SELECT id FROM ecr.email_outbox WHERE status = 'PENDING' AND next_attempt_at <= COALESCE($1::timestamptz, now())
                        ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING o.id, o.to_email, o.subject, o.body_text, o.attempts,
                 (SELECT u.status = 'ACTIVE' FROM ecr.app_user u WHERE u.id = o.to_user_id) AS active`,
      [now],
    );
    let sent = 0;
    let failed = 0;
    for (const m of rows) {
      if (!m.active) {
        await this.db.query(`UPDATE ecr.email_outbox SET status = 'CANCELLED', last_error = 'Recipient not active' WHERE id = $1`, [m.id]);
        continue;
      }
      try {
        await this.mail.send({ to: m.to_email, subject: m.subject, text: m.body_text });
        await this.db.query(`UPDATE ecr.email_outbox SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = $1`, [m.id]);
        sent += 1;
      } catch (err) {
        failed += 1;
        const giveUp = m.attempts >= MAX_ATTEMPTS;
        await this.db.query(
          `UPDATE ecr.email_outbox SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
          [m.id, giveUp ? 'FAILED' : 'PENDING', (err as Error).message.slice(0, 500), BACKOFF_MINUTES[Math.min(m.attempts - 1, BACKOFF_MINUTES.length - 1)]],
        );
        this.logger.warn(`Email ${m.id} not sent (attempt ${m.attempts}): ${(err as Error).message}`);
      }
    }
    return { sent, failed };
  }

  // ------------------------------------------------------------------ scheduled-job alerts

  /**
   * Operational alerts from scheduled jobs (Technical Design §4.2.7) to everyone active who holds one of `roles` or
   * `permissions`, plus `userIds`. The dedupe key keeps a repeating condition to one notice per person per period.
   */
  async alert(q: Queryable, audience: { roles?: string[]; permissions?: string[]; userIds?: string[] },
    n: { kind: string; title: string; body: string; link: string; dedupeKey: string }) {
    const { rows } = await q.query<Recipient>(
      `SELECT DISTINCT u.id, u.email FROM ecr.app_user u
        WHERE u.status = 'ACTIVE' AND (
          u.id = ANY($3::uuid[]) OR EXISTS (
            SELECT 1 FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
              LEFT JOIN ecr.role_permission rp ON rp.role_id = ur.role_id
             WHERE ur.user_id = u.id AND ${ACTIVE_ROLE} AND (r.code = ANY($1::text[]) OR rp.permission_code = ANY($2::text[]))))`,
      [audience.roles ?? [], audience.permissions ?? [], audience.userIds ?? []],
    );
    await this.deliver(q, rows, n);
    return rows.length;
  }

  /**
   * A notice (in ECR and by email) to every active account, e.g. an automatic update of a reference price. Use the
   * dedupe key of the version's follower notice (`published:<version>`), so followers keep their own notice and
   * receive no second one.
   */
  async everyone(q: Queryable, n: { kind: string; title: string; body: string; link: string; versionNo: number | null; changeSetId: string | null; dedupeKey: string }) {
    const { rows } = await q.query<Recipient>(`SELECT id, email FROM ecr.app_user WHERE status = 'ACTIVE'`);
    await this.deliver(q, rows, n);
    return rows.length;
  }

  // ------------------------------------------------------------------ helpers

  private async toMaker(q: Queryable, set: SetInfo, kind: string, title: string, body: string, versionNo: number | null = null) {
    await this.deliver(q, await this.activeUsers(q, [set.created_by]), {
      kind, title, body, link: `/change-sets/${set.id}`, changeSetId: set.id, versionNo, dedupeKey: `${kind}:${set.id}:${Date.now()}`,
    });
  }

  private async deliver(q: Queryable, recipients: Recipient[], n: Notice) {
    for (const r of recipients) {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO ecr.notification (user_id, kind, title, body, link, change_set_id, version_no, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
        [r.id, n.kind, n.title.slice(0, 300), n.body, n.link, n.changeSetId ?? null, n.versionNo ?? null, n.dedupeKey],
      );
      if (!rows[0]) continue;
      const footer = n.footer?.(r.id);
      const text = `${n.body}\n\nOpen in ECR: ${this.config.publicBaseUrl}${n.link}\n\n${footer ? `${footer}\n\n` : ''}` +
        '— Export Charges Registry (ECR). This message was sent automatically; ECR is reachable from the office network or VPN.';
      await q.query(
        'INSERT INTO ecr.email_outbox (notification_id, to_user_id, to_email, subject, body_text) VALUES ($1, $2, $3, $4, $5)',
        [rows[0].id, r.id, r.email, `[ECR] ${n.title}`.slice(0, 300), text],
      );
    }
  }

  /** Active people holding changeset.approve through a live role, minus `exclude`. */
  private async checkers(q: Queryable, exclude: string[]): Promise<Recipient[]> {
    const { rows } = await q.query<Recipient>(
      `SELECT DISTINCT u.id, u.email FROM ecr.app_user u
         JOIN ecr.user_role ur ON ur.user_id = u.id AND ${ACTIVE_ROLE}
         JOIN ecr.role_permission rp ON rp.role_id = ur.role_id AND rp.permission_code = 'changeset.approve'
        WHERE u.status = 'ACTIVE' AND NOT (u.id = ANY($1::uuid[]))`,
      [exclude],
    );
    return rows;
  }

  private async activeUsers(q: Queryable, ids: string[]): Promise<Recipient[]> {
    const { rows } = await q.query<Recipient>(`SELECT id, email FROM ecr.app_user WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [ids]);
    return rows;
  }

  /** Commodities, groups and products a version touched, each with the affected product names under it. */
  private async affectedScopes(q: Queryable, versionNo: number, items: PublishedItem[]) {
    const before = await CandidateState.load(q, [], versionNo - 1);
    const after = await CandidateState.load(q);
    const scopes = new Map<string, { label: string; products: string[] }>();
    const add = (type: ScopeType, id: string | null | undefined, product?: string) => {
      if (!id) return;
      const label = scopeLabel(after, type, id) ?? scopeLabel(before, type, id);
      if (!label) return;
      if (!scopes.has(id)) scopes.set(id, { label, products: [] });
      if (product) scopes.get(id)!.products.push(product);
    };
    const groupOf = (id: string | null | undefined) => after.get<GroupData>(id, 'PRODUCT_GROUP') ?? before.get<GroupData>(id, 'PRODUCT_GROUP');
    const products = affectedProducts([before, after], items.map((i) => ({ entityType: i.entity_type, entityId: i.entity_id, before: i.before, after: i.after })));
    for (const id of products) {
      const p = after.get<ProductData>(id, 'PRODUCT') ?? before.get<ProductData>(id, 'PRODUCT');
      if (!p) continue;
      add('PRODUCT', id, p.nameId);
      add('PRODUCT_GROUP', p.groupId, p.nameId);
      add('COMMODITY', groupOf(p.groupId)?.commodityId, p.nameId);
    }
    for (const i of items) {
      if (i.entity_type === 'PRODUCT_GROUP') {
        add('PRODUCT_GROUP', i.entity_id);
        add('COMMODITY', groupOf(i.entity_id)?.commodityId);
      }
      if (i.entity_type === 'COMMODITY') add('COMMODITY', i.entity_id);
    }
    return scopes;
  }

  private record(actor: Actor, action: string, id: string, after: object) {
    return this.audit.record(this.db.pool, {
      action, actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'SUBSCRIPTION', entityId: id, after,
    });
  }
}

function scopeLabel(state: CandidateState, type: ScopeType, id: string): string | null {
  if (type === 'COMMODITY') {
    const c = state.get<CommodityData>(id, 'COMMODITY');
    return c ? `${c.nameId} (${c.code})` : null;
  }
  if (type === 'PRODUCT_GROUP') {
    const g = state.get<GroupData>(id, 'PRODUCT_GROUP');
    if (!g) return null;
    const c = state.get<CommodityData>(g.commodityId, 'COMMODITY');
    return `${c ? `${c.code} – ` : ''}${g.label}`;
  }
  const p = state.get<ProductData>(id, 'PRODUCT');
  return p ? ENTITY_DEFS.PRODUCT.label(p) : null;
}
