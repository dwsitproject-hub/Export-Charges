import { Injectable } from '@nestjs/common';
import type { Queryable } from '../db/db.service';

export interface AuditInput {
  action: string;
  actorKind: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  actorUserId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Writes to the append-only, hash-chained audit trail. Call it with the same client as the business
 * change so both commit or roll back together (US-50-N1 AC4). Never pass secrets or tokens.
 */
@Injectable()
export class AuditService {
  async record(q: Queryable, e: AuditInput): Promise<void> {
    await q.query(
      `INSERT INTO ecr.audit_event
         (actor_kind, actor_user_id, session_id, ip, user_agent, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.actorKind,
        e.actorUserId ?? null,
        e.sessionId ?? null,
        e.ip || null,
        e.userAgent ?? null,
        e.action,
        e.entityType ?? null,
        e.entityId ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.reason ?? null,
      ],
    );
  }
}
