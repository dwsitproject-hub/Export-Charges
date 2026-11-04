import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { addDays, isDate, UUID_RE, wibMidnight } from '../common/fields';
import { DbService } from '../db/db.service';
import { sendFile } from '../exports/exports.controller';
import { wibDateTime } from '../exports/present';
import { Cell, num, toCsv, toXlsx } from '../exports/tabular';
import { AuditService } from './audit.service';

interface AuditRow {
  chain_seq: string;
  occurred_at: Date;
  actor_kind: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  hash: Buffer;
}

/** More events than this are refused for export; narrow the dates (the audit log is kept 10 years). */
export const MAX_AUDIT_EXPORT = 50_000;

/** A business date (YYYY-MM-DD) is a WIB day: `from` starts at its 00:00 WIB, `to` includes the whole day. */
function boundary(value: string | undefined, name: string, end: boolean): Date | null {
  if (!value) return null;
  if (isDate(value)) return wibMidnight(end ? addDays(value, 1) : value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, 'INVALID_INPUT', `${name} must be a date (YYYY-MM-DD) or an ISO timestamp.`);
  return d;
}

/** The filters of US-50-P1 as SQL: actor (name, email or "system"), actions, entity, WIB dates. */
function filters(q: Record<string, string | undefined>) {
  if (q.actorUserId && !UUID_RE.test(q.actorUserId)) throw new ApiError(400, 'INVALID_INPUT', 'actorUserId must be a UUID.');
  const actions = (q.action ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const actor = q.actor?.trim().slice(0, 200) || null;
  const params = [
    actions.length ? actions : null,
    q.actorUserId || null,
    actor,
    q.entityType || null,
    q.entityId?.trim() || null,
    boundary(q.from, 'from', false),
    boundary(q.to, 'to', true),
  ];
  const where = `($1::text[] IS NULL OR e.action = ANY($1))
    AND ($2::uuid IS NULL OR e.actor_user_id = $2)
    AND ($3::text IS NULL OR u.email ILIKE '%' || $3 || '%' OR u.full_name ILIKE '%' || $3 || '%'
         OR (e.actor_kind <> 'USER' AND lower(e.actor_kind) = lower($3)))
    AND ($4::text IS NULL OR e.entity_type = $4)
    AND ($5::text IS NULL OR e.entity_id = $5)
    AND ($6::timestamptz IS NULL OR e.occurred_at >= $6)
    AND ($7::timestamptz IS NULL OR e.occurred_at < $7)`;
  return { where, params, described: [
    actions.length && `action ${actions.join(', ')}`,
    actor && `actor "${actor}"`,
    q.actorUserId && `actor id ${q.actorUserId}`,
    q.entityType && `entity ${q.entityType}${q.entityId ? ` ${q.entityId}` : ''}`,
    !q.entityType && q.entityId && `entity id ${q.entityId}`,
    q.from && `from ${q.from}`,
    q.to && `to ${q.to}`,
  ].filter(Boolean).join('; ') };
}

const SELECT = `SELECT e.chain_seq, e.occurred_at, e.actor_kind, e.actor_user_id, u.email AS actor_email, u.full_name AS actor_name,
         e.session_id, host(e.ip) AS ip, e.user_agent, e.action, e.entity_type, e.entity_id, e.before, e.after, e.reason, e.hash
    FROM ecr.audit_event e LEFT JOIN ecr.app_user u ON u.id = e.actor_user_id`;

/**
 * Audit log for Auditors and Super Admins (PRD F-50, US-50-P1; Technical Design §5.1 "Audit"). Read-only: no route edits
 * or deletes events (US-50-N1 AC1). Newest first, paged by chain sequence.
 */
@Controller('audit-events')
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** ?actor=&action=a,b&actorUserId=&entityType=&entityId=&from=&to=&before=&limit= */
  @Get()
  @Authorize({ permissions: ['audit.read'] })
  async search(@Query() q: Record<string, string | undefined>) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const before = q.before ? Number(q.before) : null;
    if (before !== null && !Number.isInteger(before)) throw new ApiError(400, 'INVALID_INPUT', 'before must be a chain sequence number.');
    const f = filters(q);
    const { rows } = await this.db.query<AuditRow>(
      `${SELECT} WHERE ${f.where} AND ($8::bigint IS NULL OR e.chain_seq < $8) ORDER BY e.chain_seq DESC LIMIT $9`,
      [...f.params, before, limit],
    );
    const items = rows.map((r) => ({
      chainSeq: Number(r.chain_seq),
      occurredAt: r.occurred_at,
      actorKind: r.actor_kind,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      actorName: r.actor_name,
      sessionId: r.session_id,
      ip: r.ip,
      userAgent: r.user_agent,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      reason: r.reason,
      hash: r.hash.toString('hex'),
    }));
    return { items, nextBefore: items.length === limit ? items[items.length - 1].chainSeq : null };
  }

  /** The actions and entity types present, with counts, for the filters. */
  @Get('facets')
  @Authorize({ permissions: ['audit.read'] })
  async facets() {
    const { rows: actions } = await this.db.query<{ value: string; count: number }>(
      'SELECT action AS value, count(*)::int AS count FROM ecr.audit_event GROUP BY action ORDER BY action',
    );
    const { rows: entityTypes } = await this.db.query<{ value: string; count: number }>(
      'SELECT entity_type AS value, count(*)::int AS count FROM ecr.audit_event WHERE entity_type IS NOT NULL GROUP BY entity_type ORDER BY entity_type',
    );
    return { actions, entityTypes };
  }

  /** Recomputes the whole hash chain (Technical Design §4.2.8). */
  @Get('verify')
  @Authorize({ permissions: ['audit.read'] })
  verify() {
    return this.verifyChain();
  }

  /**
   * US-50-P1 AC1: the filtered events as CSV or XLSX, with the hash-chain verification status in the header block.
   * The export itself is audited (AUDIT_EXPORTED).
   */
  @Get('export')
  @Authorize({ permissions: ['audit.export'] })
  async export(@Query() q: Record<string, string | undefined>, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const format = q.format;
    if (format !== 'csv' && format !== 'xlsx') throw new ApiError(400, 'INVALID_INPUT', 'format must be csv or xlsx.');
    const f = filters(q);
    const { rows: [count] } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ecr.audit_event e LEFT JOIN ecr.app_user u ON u.id = e.actor_user_id WHERE ${f.where}`, f.params,
    );
    if (count.n > MAX_AUDIT_EXPORT) {
      throw new ApiError(422, 'EXPORT_TOO_LARGE', `${count.n.toLocaleString('en')} events is more than ${MAX_AUDIT_EXPORT.toLocaleString('en')}; narrow the dates.`,
        { rows: count.n, limit: MAX_AUDIT_EXPORT });
    }
    const chain = await this.verifyChain();
    const { rows } = await this.db.query<AuditRow>(`${SELECT} WHERE ${f.where} ORDER BY e.chain_seq`, f.params);
    const actor = actorOf(req);
    const { rows: [me] } = await this.db.query<{ full_name: string; email: string }>('SELECT full_name, email FROM ecr.app_user WHERE id = $1', [actor.id]);
    const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
    const now = new Date();
    const sheet = {
      name: 'Audit log',
      title: 'ECR audit log',
      meta: [
        ['Hash chain', chain.intact
          ? `Intact: all ${chain.events.toLocaleString('en')} events verified ${wibDateTime(now)}`
          : `BROKEN at event ${chain.brokenAtChainSeq}: verified ${wibDateTime(now)}; treat as a security incident`],
        ['Filters', f.described || 'none'],
        ['Events', String(rows.length)],
        ['Exported', wibDateTime(now)],
        ['Exported by', `${me.full_name} <${me.email}>`],
        ['Note', 'Times are WIB. Before and After are the recorded values as JSON. Each event hash chains to the previous one.'],
      ] as [string, string][],
      header: ['Event', 'Time (WIB)', 'Actor kind', 'Actor', 'Actor email', 'Action', 'Entity type', 'Entity id', 'Reason', 'IP', 'User agent',
        'Session', 'Before', 'After', 'Hash'],
      rows: rows.map((r): Cell[] => [
        num(r.chain_seq), wibDateTime(r.occurred_at).replace(' WIB', ''), r.actor_kind, r.actor_name, r.actor_email, r.action, r.entity_type,
        r.entity_id, r.reason, r.ip, r.user_agent, r.session_id, json(r.before), json(r.after), r.hash.toString('hex'),
      ]),
      widths: [8, 17, 10, 22, 28, 28, 16, 38, 30, 14, 30, 38, 50, 50, 66],
    };
    await this.audit.record(this.db.pool, {
      action: 'AUDIT_EXPORTED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'AUDIT_LOG', after: { format, events: rows.length, filters: f.described || null, chainIntact: chain.intact },
    });
    const stamp = now.toISOString().slice(0, 10);
    sendFile(res, format === 'csv'
      ? { body: toCsv(sheet), filename: `ecr-audit-log-${stamp}.csv`, contentType: 'text/csv; charset=utf-8' }
      : { body: toXlsx(sheet), filename: `ecr-audit-log-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  private async verifyChain() {
    const { rows } = await this.db.query<{ broken_at: string | null; total: string }>(
      'SELECT ecr.audit_chain_verify() AS broken_at, (SELECT count(*) FROM ecr.audit_event) AS total',
    );
    return { intact: rows[0].broken_at === null, brokenAtChainSeq: rows[0].broken_at === null ? null : Number(rows[0].broken_at), events: Number(rows[0].total) };
  }
}
