import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { asObject, Fields, UUID_RE, wibMidnight, wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Queryable } from '../db/db.service';
import { ENTITY_DEFS, entityDef, EntityData, EntityType, loadCurrent, regulationLabel, RegulationData } from './entities';
import { NotificationsService } from '../notifications/notifications.service';
import { impactPreview } from '../tariffs/impact';
import { Finding, validateItems } from './validation';

/** What a Maker can ask for; WITHDRAW only comes from rollback. */
const OPERATIONS = ['CREATE', 'UPDATE', 'END_DATE'] as const;
type Operation = (typeof OPERATIONS)[number] | 'WITHDRAW';
const EDITABLE = ['DRAFT', 'REJECTED'];

interface SetRow {
  id: string;
  title: string;
  justification: string;
  status: string;
  kind: string;
  created_by: string;
  submitted_at: Date | null;
  reviewed_by: string | null;
  review_started_at: Date | null;
  decision_comment: string | null;
  approved_at: Date | null;
  effective_at: Date | null;
  version_no: number | null;
  rollback_of_version: number | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  change_set_id: string;
  entity_type: EntityType;
  entity_id: string;
  operation: Operation;
  base_row_id: string | null;
  before: EntityData | null;
  after: EntityData;
  edited_by: string[];
  is_open: boolean;
  item_comment: string | null;
  import_row: string | null;
}

/**
 * Ids of other records and documents in item data (`…Id` fields, `productIds`, and ids inside lists such as
 * relations and documents), used to label references in the diff. HS codes are labelled by their own code.
 */
function collectReferences(value: unknown, into: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    if ((key.endsWith('Id') || key === 'productIds') && key !== 'hsCodeId' && UUID_RE.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectReferences(v, into, key);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectReferences(v, into, k);
  }
}

/**
 * Maker-checker change sets (PRD L2-5, F-29; Technical Design §4.2). Makers never write published tables:
 * items hold before/after snapshots, and only the publish transaction turns them into new row versions.
 */
@Injectable()
export class ChangeSetsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ChangeSets');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ scheduler

  onModuleInit(): void {
    if (this.config.publishDueIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.publishDue().catch((err) => this.logger.error(`publish-due failed: ${(err as Error).message}`));
      }, this.config.publishDueIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Job publish-due (Technical Design §4.2.7): publishes SCHEDULED sets whose effective moment has passed. */
  async publishDue(now = new Date()): Promise<{ published: string[]; failed: string[] }> {
    const published: string[] = [];
    const failed: string[] = [];
    for (;;) {
      let picked: string | null = null;
      try {
        picked = await this.db.tx(async (client) => {
          const { rows } = await client.query<SetRow>(
            `SELECT * FROM ecr.change_set
              WHERE status = 'SCHEDULED' AND effective_at <= $1 AND NOT (id = ANY($2::uuid[]))
              ORDER BY approved_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [now, failed],
          );
          if (!rows[0]) return null;
          await this.publish(client, rows[0], null);
          return rows[0].id;
        });
      } catch (err) {
        // The set stays SCHEDULED; Checkers see the failure in the audit log (alerting comes with notifications).
        const id = (err as { changeSetId?: string }).changeSetId;
        if (!id) throw err;
        failed.push(id);
        await this.audit.record(this.db.pool, {
          action: 'CHANGESET_PUBLISH_FAILED',
          actorKind: 'SYSTEM',
          entityType: 'CHANGE_SET',
          entityId: id,
          after: { code: (err as ApiError).code ?? 'INTERNAL', message: (err as Error).message },
        });
        await this.notifications.publishFailed(this.db.pool, await this.findSet(this.db.pool, id), (err as Error).message);
        continue;
      }
      if (!picked) break;
      published.push(picked);
    }
    return { published, failed };
  }

  // ------------------------------------------------------------------ reads

  async list(filter: { status?: string; mine?: string; limit: number }) {
    const { rows } = await this.db.query(
      `SELECT cs.id, cs.title, cs.status, cs.kind, cs.created_at AS "createdAt", cs.updated_at AS "updatedAt",
              cs.submitted_at AS "submittedAt", cs.effective_at AS "effectiveAt", cs.version_no AS "versionNo",
              cs.created_by AS "createdBy", u.full_name AS "createdByName", r.full_name AS "reviewedByName",
              (SELECT count(*)::int FROM ecr.change_item i WHERE i.change_set_id = cs.id) AS "itemCount"
         FROM ecr.change_set cs
         JOIN ecr.app_user u ON u.id = cs.created_by
         LEFT JOIN ecr.app_user r ON r.id = cs.reviewed_by
        WHERE ($1::text IS NULL OR cs.status = ANY(string_to_array($1, ',')))
          AND ($2::uuid IS NULL OR cs.created_by = $2)
        ORDER BY cs.updated_at DESC
        LIMIT $3`,
      [filter.status ?? null, filter.mine ?? null, filter.limit],
    );
    return rows;
  }

  async get(id: string) {
    const set = await this.findSet(this.db.pool, id);
    const items = await this.loadItems(this.db.pool, id);
    const { rows: people } = await this.db.query<{ id: string; full_name: string }>(
      'SELECT id, full_name FROM ecr.app_user WHERE id = ANY($1::uuid[])',
      [[set.created_by, set.reviewed_by, ...items.flatMap((i) => i.edited_by)].filter(Boolean)],
    );
    const nameOf = new Map(people.map((p) => [p.id, p.full_name]));
    const { rows: [context] } = await this.db.query<{ rolled_back_by_version: number | null; import_id: string | null; import_file: string | null }>(
      `SELECT (SELECT rolled_back_by_version FROM ecr.data_version WHERE version_no = $2) AS rolled_back_by_version,
              j.id AS import_id, j.file_name AS import_file
         FROM (SELECT 1) one LEFT JOIN ecr.import_job j ON j.change_set_id = $1`,
      [id, set.version_no],
    );
    const { rows: findings } = await this.db.query(
      `SELECT id, rule_code AS "ruleCode", severity, entity_type AS "entityType", entity_id AS "entityId", field, message,
              acknowledged_by IS NOT NULL AS acknowledged
         FROM ecr.dq_finding WHERE change_set_id = $1
        ORDER BY CASE severity WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at`,
      [id],
    );
    return {
      id: set.id,
      title: set.title,
      justification: set.justification,
      status: set.status,
      kind: set.kind,
      createdBy: { id: set.created_by, name: nameOf.get(set.created_by) },
      reviewedBy: set.reviewed_by ? { id: set.reviewed_by, name: nameOf.get(set.reviewed_by) } : null,
      submittedAt: set.submitted_at,
      reviewStartedAt: set.review_started_at,
      decisionComment: set.decision_comment,
      approvedAt: set.approved_at,
      effectiveAt: set.effective_at,
      versionNo: set.version_no,
      /** PUBLISHED sets whose version was later rolled back (US-30-P2 AC1). */
      rolledBackByVersion: context.rolled_back_by_version,
      rollbackOfVersion: set.rollback_of_version,
      importJob: context.import_id ? { id: context.import_id, fileName: context.import_file } : null,
      createdAt: set.created_at,
      updatedAt: set.updated_at,
      /** Everyone who created or edited the set; none of them may review it (SoD-1). */
      editors: [...new Set([set.created_by, ...items.flatMap((i) => i.edited_by)])],
      items: items.map((i) => ({
        id: i.id,
        entityType: i.entity_type,
        entityId: i.entity_id,
        operation: i.operation,
        label: ENTITY_DEFS[i.entity_type].label(i.after),
        before: i.before,
        after: i.after,
        changes: diff(i.before, i.after, ENTITY_DEFS[i.entity_type].fields),
        editedBy: i.edited_by.map((u) => nameOf.get(u) ?? u),
        itemComment: i.item_comment,
        importRow: i.import_row,
      })),
      references: await this.referenceLabels(this.db.pool, items),
      findings,
    };
  }

  /** Duty and levy per tonne before and after the set, for every product it touches (US-25-P1 AC2). */
  async impact(id: string, date: string) {
    await this.findSet(this.db.pool, id);
    const items = await this.loadItems(this.db.pool, id);
    return { date, rows: await impactPreview(this.db.pool, items.map((i) => ({ ...toValidationItem(i), before: i.before })), date) };
  }

  // ------------------------------------------------------------------ Maker actions

  async create(actor: Actor, input: unknown) {
    const f = new Fields(asObject(input));
    const title = f.text('title', 200);
    const justification = f.text('justification', 4000);
    if (title && title.length < 3) f.fail('title', 'At least 3 characters.');
    f.throwIfAny();
    const id = await this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO ecr.change_set (title, justification, created_by) VALUES ($1, $2, $3) RETURNING id',
        [title, justification, actor.id],
      );
      await this.record(client, actor, 'CHANGESET_CREATED', rows[0].id, { after: { title } });
      return rows[0].id;
    });
    return this.get(id);
  }

  /** Adds or replaces the set's item for one record (Technical Design §4.2.1 steps 2–3). */
  async saveItem(actor: Actor, setId: string, input: unknown) {
    const body = asObject(input);
    const def = entityDef(String(body.entityType ?? ''));
    const operation = body.operation as Operation;
    if (!(OPERATIONS as readonly string[]).includes(operation)) throw new ApiError(400, 'INVALID_INPUT', `operation must be one of ${OPERATIONS.join(', ')}.`);
    const itemId = typeof body.itemId === 'string' && UUID_RE.test(body.itemId) ? body.itemId : null;

    try {
      await this.db.tx(async (client) => {
        const set = await this.lockEditable(client, actor, setId);
        let entityId: string;
        let baseRowId: string | null = null;
        let before: EntityData | null = null;
        let after: EntityData;

        if (operation === 'CREATE') {
          const existing = itemId ? (await this.loadItems(client, setId)).find((i) => i.id === itemId) : undefined;
          if (itemId && (!existing || existing.operation !== 'CREATE' || existing.entity_type !== def.type)) {
            throw new ApiError(404, 'NOT_FOUND', 'Change item not found.');
          }
          entityId = existing?.entity_id ?? (await client.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0].id;
          after = await def.parse(asObject(body.after), client);
        } else {
          if (typeof body.entityId !== 'string' || !UUID_RE.test(body.entityId)) throw new ApiError(400, 'INVALID_INPUT', 'entityId is required.');
          entityId = body.entityId.toLowerCase();
          const current = (await loadCurrent(client, def.type, [entityId])).get(entityId);
          if (!current) throw new ApiError(404, 'NOT_FOUND', 'Only published records can be changed or ended.');
          baseRowId = current.rowId;
          before = current.data;
          if (operation === 'UPDATE') {
            after = await def.parse(asObject(body.after), client);
          } else {
            const f = new Fields(body);
            const end = f.optDate('validTo');
            if (!end) f.fail('validTo', 'Enter the last day the record applies.');
            const { validFrom } = def.validity(before);
            if (end && validFrom && end < validFrom) f.fail('validTo', 'The end date is before the start date.');
            f.throwIfAny();
            after = def.withEndDate(before, end!);
          }
        }

        if (def.type === 'REGULATION') await this.assertRegulationUnique(client, setId, entityId, after as RegulationData);

        const { rows: open } = await client.query<{ id: string; change_set_id: string; title: string; holder: string }>(
          `SELECT i.id, i.change_set_id, cs.title, u.full_name AS holder
             FROM ecr.change_item i JOIN ecr.change_set cs ON cs.id = i.change_set_id JOIN ecr.app_user u ON u.id = cs.created_by
            WHERE i.entity_type = $1 AND i.entity_id = $2 AND i.is_open`,
          [def.type, entityId],
        );
        if (open[0] && open[0].change_set_id !== setId) throw lockedError(open[0]);

        if (open[0]) {
          await client.query(
            `UPDATE ecr.change_item
                SET operation = $2, base_row_id = $3, before = $4, after = $5, item_comment = NULL, updated_at = now(),
                    edited_by = ARRAY(SELECT DISTINCT unnest(edited_by || $6::uuid))
              WHERE id = $1`,
            [open[0].id, operation, baseRowId, json(before), json(after), actor.id],
          );
        } else {
          await client.query(
            `INSERT INTO ecr.change_item (change_set_id, entity_type, entity_id, operation, base_row_id, before, after, edited_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[$8::uuid])`,
            [setId, def.type, entityId, operation, baseRowId, json(before), json(after), actor.id],
          );
        }
        await this.touchDraft(client, set);
        await this.record(client, actor, 'CHANGE_ITEM_SAVED', setId, {
          after: { entityType: def.type, entityId, operation, label: def.label(after) },
        });
      });
    } catch (err) {
      // Two Makers racing for the same record: the unique index decides (US-23-N2).
      if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'change_item_one_open_edit') {
        throw new ApiError(409, 'ENTITY_LOCKED', 'This record is being edited in another change set.');
      }
      throw err;
    }
    return this.get(setId);
  }

  async removeItem(actor: Actor, setId: string, itemId: string) {
    await this.db.tx(async (client) => {
      const set = await this.lockEditable(client, actor, setId);
      const { rows } = await client.query<ItemRow>('DELETE FROM ecr.change_item WHERE id = $1 AND change_set_id = $2 RETURNING *', [itemId, setId]);
      if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Change item not found.');
      await this.touchDraft(client, set);
      await this.record(client, actor, 'CHANGE_ITEM_REMOVED', setId, {
        before: { entityType: rows[0].entity_type, entityId: rows[0].entity_id, operation: rows[0].operation },
      });
    });
    return this.get(setId);
  }

  /** Validates and hands the set to Checkers (US-29-P1). Errors block; warnings need acknowledgement. */
  async submit(actor: Actor, setId: string, input: unknown) {
    const acknowledge = asObject(input).acknowledgeWarnings === true;
    const blocked = await this.db.tx(async (client) => {
      const set = await this.lockEditable(client, actor, setId);
      const findings = await this.runValidation(client, setId);
      const errors = findings.filter((f) => f.severity === 'ERROR');
      const warnings = findings.filter((f) => f.severity === 'WARNING');
      await this.storeFindings(client, setId, findings, acknowledge ? actor.id : null);

      if (errors.length || (warnings.length && !acknowledge)) {
        if (set.status !== 'DRAFT') await client.query(`UPDATE ecr.change_set SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [setId]);
        await this.record(client, actor, 'CHANGESET_SUBMIT_BLOCKED', setId, { after: { errors: errors.length, warnings: warnings.length } });
        return errors.length
          ? new ApiError(422, 'VALIDATION_FAILED', `Fix ${errors.length} error(s) before submitting.`, { findings })
          : new ApiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', 'Review and acknowledge the warnings to submit.', { findings });
      }
      await client.query(
        `UPDATE ecr.change_set SET status = 'SUBMITTED', submitted_at = now(), reviewed_by = NULL, review_started_at = NULL,
                updated_at = now() WHERE id = $1`,
        [setId],
      );
      await this.record(client, actor, 'CHANGESET_SUBMITTED', setId, { after: { warningsAcknowledged: warnings.length } });
      const editors = [set.created_by, ...(await this.loadItems(client, setId)).flatMap((i) => i.edited_by)];
      await this.notifications.submitted(client, set, editors);
      return null;
    });
    // Findings are committed even when submission is refused, so the Maker sees them (the throw comes after commit).
    if (blocked) throw blocked;
    return this.get(setId);
  }

  /** Before review starts the Maker can take the set back (US-29-P1 AC2). */
  async withdraw(actor: Actor, setId: string) {
    await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      this.requireOwner(actor, set);
      requireStatus(set, ['SUBMITTED'], 'Only a submitted change set that is not yet in review can be withdrawn.');
      await client.query(`UPDATE ecr.change_set SET status = 'DRAFT', submitted_at = NULL, updated_at = now() WHERE id = $1`, [setId]);
      await this.record(client, actor, 'CHANGESET_WITHDRAWN', setId, {});
    });
    return this.get(setId);
  }

  /** The Maker abandons a draft; its records are released for others to edit. Nothing is deleted. */
  async discard(actor: Actor, setId: string) {
    await this.db.tx(async (client) => {
      await this.lockEditable(client, actor, setId);
      await client.query('UPDATE ecr.change_item SET is_open = false, updated_at = now() WHERE change_set_id = $1', [setId]);
      await client.query(`UPDATE ecr.change_set SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [setId]);
      await this.record(client, actor, 'CHANGESET_DISCARDED', setId, {});
    });
    return this.get(setId);
  }

  // ------------------------------------------------------------------ Checker actions

  /** A Checker takes the set into review; it is validated again against today's published data (US-29-N1 AC2). */
  async startReview(actor: Actor, setId: string) {
    const blocked = await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      requireStatus(set, ['SUBMITTED'], 'Only a submitted change set can be taken into review.');
      await this.requireIndependent(client, actor, set);
      const findings = await this.runValidation(client, setId);
      const errors = findings.filter((f) => f.severity === 'ERROR');
      if (errors.length) {
        await this.storeFindings(client, setId, findings, null);
        await client.query(`UPDATE ecr.change_set SET status = 'DRAFT', submitted_at = NULL, updated_at = now() WHERE id = $1`, [setId]);
        await this.record(client, actor, 'CHANGESET_REVIEW_BLOCKED', setId, { after: { errors: errors.length } });
        await this.notifications.returned(client, set);
        return new ApiError(422, 'VALIDATION_FAILED', 'The change set no longer passes validation and was returned to the Maker.', { findings });
      }
      await client.query(
        `UPDATE ecr.change_set SET status = 'IN_REVIEW', reviewed_by = $2, review_started_at = now(), updated_at = now() WHERE id = $1`,
        [setId, actor.id],
      );
      await this.record(client, actor, 'CHANGESET_REVIEW_STARTED', setId, {});
      return null;
    });
    if (blocked) throw blocked;
    return this.get(setId);
  }

  /** Approve with an effective date: today or earlier publishes now, later schedules (US-29-P2 AC2). */
  async approve(actor: Actor, setId: string, input: unknown) {
    const f = new Fields(asObject(input));
    const effectiveDate = f.optDate('effectiveDate') ?? wibToday();
    f.throwIfAny();
    const effectiveAt = wibMidnight(effectiveDate);

    await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      requireStatus(set, ['IN_REVIEW'], 'Start the review before approving.');
      await this.requireIndependent(client, actor, set);
      await client.query(
        `UPDATE ecr.change_set SET status = 'APPROVED', reviewed_by = $2, approved_at = now(), effective_at = $3, updated_at = now()
          WHERE id = $1`,
        [setId, actor.id, effectiveAt],
      );
      await this.record(client, actor, 'CHANGESET_APPROVED', setId, { after: { effectiveDate } });
      if (effectiveAt.getTime() <= Date.now()) {
        await this.publish(client, { ...set, effective_at: effectiveAt }, actor.id);
      } else {
        const errors = (await this.runValidation(client, setId)).filter((x) => x.severity === 'ERROR');
        if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', 'The change set no longer passes validation.', { findings: errors });
        await this.assertNotStale(client, setId);
        await client.query(`UPDATE ecr.change_set SET status = 'SCHEDULED' WHERE id = $1`, [setId]);
        await this.record(client, actor, 'CHANGESET_SCHEDULED', setId, { after: { effectiveAt } });
        await this.notifications.scheduled(client, set, effectiveDate);
      }
    });
    return this.get(setId);
  }

  /** Reject with a mandatory comment, optionally per item (US-29-N2). The Maker reworks it into a draft. */
  async reject(actor: Actor, setId: string, input: unknown) {
    const body = asObject(input);
    const f = new Fields(body);
    const comment = f.text('comment', 4000);
    if (comment && comment.length < 3) f.fail('comment', 'At least 3 characters.');
    f.throwIfAny();
    const itemComments = asObject(body.itemComments);

    await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      requireStatus(set, ['IN_REVIEW'], 'Only a change set in review can be rejected.');
      await this.requireIndependent(client, actor, set);
      for (const [itemId, text] of Object.entries(itemComments)) {
        if (!UUID_RE.test(itemId) || typeof text !== 'string' || !text.trim()) continue;
        await client.query('UPDATE ecr.change_item SET item_comment = $3 WHERE id = $1 AND change_set_id = $2', [itemId, setId, text.trim().slice(0, 2000)]);
      }
      await client.query(
        `UPDATE ecr.change_set SET status = 'REJECTED', reviewed_by = $2, decision_comment = $3, updated_at = now() WHERE id = $1`,
        [setId, actor.id, comment],
      );
      await this.record(client, actor, 'CHANGESET_REJECTED', setId, { reason: comment });
      await this.notifications.rejected(client, set);
    });
    return this.get(setId);
  }

  /** Stop a scheduled set before its effective date, e.g. the regulation was postponed (US-29-N3). */
  async cancelSchedule(actor: Actor, setId: string, input: unknown) {
    const f = new Fields(asObject(input));
    const reason = f.text('reason', 2000);
    if (reason && reason.length < 3) f.fail('reason', 'At least 3 characters.');
    f.throwIfAny();

    await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      requireStatus(set, ['SCHEDULED'], 'Only a scheduled change set can be cancelled; after publishing use rollback.');
      if (set.effective_at && set.effective_at.getTime() <= Date.now()) {
        throw new ApiError(409, 'INVALID_STATE', 'The effective date has been reached; the change set is being published.');
      }
      await this.requireIndependent(client, actor, set);
      await client.query(
        `UPDATE ecr.change_set SET status = 'DRAFT', submitted_at = NULL, reviewed_by = NULL, review_started_at = NULL,
                approved_at = NULL, effective_at = NULL, updated_at = now() WHERE id = $1`,
        [setId],
      );
      await this.record(client, actor, 'CHANGESET_SCHEDULE_CANCELLED', setId, { reason });
      await this.notifications.scheduleCancelled(client, set);
    });
    return this.get(setId);
  }

  // ------------------------------------------------------------------ rollback

  /**
   * Rollback of data version v (US-30-P2, Technical Design §4.2.6): a ROLLBACK change set whose items restore every
   * record v changed to its state before v, withdraw the records v created and re-create those v withdrew. It goes
   * straight to SUBMITTED; a different Checker reviews and approves it (US-30-N1 AC2). Refused when a later version
   * changed one of the records (ROLLBACK_CONFLICT) or the result would break validation.
   */
  async rollback(actor: Actor, versionNo: number, input: unknown) {
    const f = new Fields(asObject(input));
    const reason = f.text('reason', 2000);
    if (reason && reason.length < 3) f.fail('reason', 'At least 3 characters.');
    f.throwIfAny();

    let setId: string;
    try {
      setId = await this.db.tx(async (client) => {
        // Same lock as publishing: version v and its successors cannot move while the rollback is built.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('ecr.publish'))`);
        const { rows: [version] } = await client.query<{ change_set_id: string; rolled_back_by_version: number | null; title: string }>(
          `SELECT v.change_set_id, v.rolled_back_by_version, cs.title
             FROM ecr.data_version v JOIN ecr.change_set cs ON cs.id = v.change_set_id WHERE v.version_no = $1`,
          [versionNo],
        );
        if (!version) throw new ApiError(404, 'NOT_FOUND', `Data version ${versionNo} does not exist.`);
        if (version.rolled_back_by_version) {
          throw new ApiError(409, 'ALREADY_ROLLED_BACK', `Version ${versionNo} was already rolled back by version ${version.rolled_back_by_version}.`);
        }
        const { rows: [pending] } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM ecr.change_set WHERE rollback_of_version = $1 AND status NOT IN ('CANCELLED', 'PUBLISHED')`,
          [versionNo],
        );
        if (pending) {
          throw new ApiError(409, 'ROLLBACK_PENDING', `A rollback of version ${versionNo} is already open (${pending.status}).`, { changeSetId: pending.id });
        }

        const items: { type: EntityType; entityId: string; operation: Operation; baseRowId: string | null; before: EntityData | null; after: EntityData }[] = [];
        const conflicts: { entityType: EntityType; entityId: string; label: string; laterVersion: number | null }[] = [];
        for (const def of Object.values(ENTITY_DEFS)) {
          const { rows } = await client.query<{ row_id: string; entity_id: string; version_from: number; version_to: number | null; data: EntityData }>(
            `${def.select}
              WHERE t.entity_id IN (SELECT entity_id FROM ecr.${def.table} WHERE version_from = $1 OR version_to = $1)
                AND (t.version_from = $1 OR t.version_to = $1 OR t.version_to IS NULL)`,
            [versionNo],
          );
          for (const entityId of new Set(rows.map((r) => r.entity_id))) {
            const mine = rows.filter((r) => r.entity_id === entityId);
            const made = mine.find((r) => r.version_from === versionNo);
            const replaced = mine.find((r) => r.version_to === versionNo);
            const current = mine.find((r) => r.version_to === null);
            if (made ? current?.row_id !== made.row_id : current) {
              conflicts.push({ entityType: def.type, entityId, label: def.label((current ?? made)!.data), laterVersion: current?.version_from ?? made?.version_to ?? null });
              continue;
            }
            if (made && replaced) items.push({ type: def.type, entityId, operation: 'UPDATE', baseRowId: made.row_id, before: made.data, after: replaced.data });
            else if (made) items.push({ type: def.type, entityId, operation: 'WITHDRAW', baseRowId: made.row_id, before: made.data, after: made.data });
            else if (replaced) items.push({ type: def.type, entityId, operation: 'CREATE', baseRowId: null, before: null, after: replaced.data });
          }
        }
        if (conflicts.length) {
          throw new ApiError(409, 'ROLLBACK_CONFLICT',
            `A later version changed ${conflicts.length} of the records in version ${versionNo}; roll back the later version first or correct the data with a normal change set.`,
            { conflicts });
        }

        const findings = await validateItems(client, items.map((i) => ({ entityType: i.type, entityId: i.entityId, operation: i.operation, after: i.after })), wibToday());
        const errors = findings.filter((x) => x.severity === 'ERROR');
        if (errors.length) {
          throw new ApiError(422, 'ROLLBACK_INVALID', `Rolling back version ${versionNo} would leave the data invalid.`, { findings: errors });
        }

        const { rows: [created] } = await client.query<{ id: string }>(
          `INSERT INTO ecr.change_set (title, justification, status, kind, created_by, submitted_at, rollback_of_version)
           VALUES ($1, $2, 'SUBMITTED', 'ROLLBACK', $3, now(), $4) RETURNING id`,
          [`Rollback of version ${versionNo}: ${version.title}`.slice(0, 200), reason, actor.id, versionNo],
        );
        for (const i of items) {
          await client.query(
            `INSERT INTO ecr.change_item (change_set_id, entity_type, entity_id, operation, base_row_id, before, after, edited_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[$8::uuid])`,
            [created.id, i.type, i.entityId, i.operation, i.baseRowId, json(i.before), json(i.after), actor.id],
          );
        }
        // The initiator asked for exactly this state, so its warnings count as acknowledged.
        await this.storeFindings(client, created.id, findings, actor.id);
        await this.record(client, actor, 'CHANGESET_ROLLBACK_CREATED', created.id, { reason, after: { rollbackOfVersion: versionNo, items: items.length } });
        await this.notifications.submitted(client, { id: created.id, title: `Rollback of version ${versionNo}: ${version.title}`.slice(0, 200), kind: 'ROLLBACK', created_by: actor.id }, [actor.id]);
        return created.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'change_item_one_open_edit') {
        throw new ApiError(409, 'ENTITY_LOCKED', 'A record of this version is being edited in another change set; finish or discard that set first.');
      }
      throw err;
    }
    return this.get(setId);
  }

  /** The initiating Checker abandons an open rollback, e.g. after it was rejected. Its records are released. */
  async cancelRollback(actor: Actor, setId: string) {
    await this.db.tx(async (client) => {
      const set = await this.lockSet(client, setId);
      if (set.kind !== 'ROLLBACK') throw new ApiError(409, 'INVALID_STATE', 'Only a rollback change set can be cancelled this way.');
      this.requireOwner(actor, set);
      requireStatus(set, ['DRAFT', 'SUBMITTED', 'REJECTED'], 'Only a rollback that is not in review, approved or published can be cancelled.');
      await client.query('UPDATE ecr.change_item SET is_open = false, updated_at = now() WHERE change_set_id = $1', [setId]);
      await client.query(`UPDATE ecr.change_set SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [setId]);
      await this.record(client, actor, 'CHANGESET_ROLLBACK_CANCELLED', setId, {});
    });
    return this.get(setId);
  }

  // ------------------------------------------------------------------ publish

  /**
   * One publisher at a time (advisory lock), gap-free version numbers, staleness check per item
   * (Technical Design §4.2.6). Throws ApiError tagged with the set id; the caller's transaction rolls back.
   */
  private async publish(client: PoolClient, set: SetRow, publishedBy: string | null): Promise<number> {
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ecr.publish'))`);
      const items = await this.loadItems(client, set.id);
      const errors = (await validateItems(client, items.map(toValidationItem), wibToday())).filter((x) => x.severity === 'ERROR');
      if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', 'The change set no longer passes validation.', { findings: errors });

      const { rows } = await client.query<{ v: number }>('SELECT COALESCE(max(version_no), 0) + 1 AS v FROM ecr.data_version');
      const v = rows[0].v;
      const bulletin = {
        changeSetId: set.id,
        title: set.title,
        items: items.map((i) => ({ entityType: i.entity_type, entityId: i.entity_id, operation: i.operation, label: ENTITY_DEFS[i.entity_type].label(i.after) })),
      };
      await client.query('INSERT INTO ecr.data_version (version_no, change_set_id, published_by, bulletin) VALUES ($1, $2, $3, $4)',
        [v, set.id, publishedBy, JSON.stringify(bulletin)]);

      for (const i of items.filter((x) => x.operation === 'CREATE')) {
        // A rollback re-creates a record an earlier version withdrew under its existing key.
        await client.query(
          `INSERT INTO ecr.entity_key (entity_id, entity_type, natural_key) VALUES ($1, $2, $3)
           ON CONFLICT (entity_id) DO UPDATE SET natural_key = EXCLUDED.natural_key`,
          [i.entity_id, i.entity_type, ENTITY_DEFS[i.entity_type].naturalKey(i.after)]);
      }
      // Close every replaced version first, so unique keys can move between records within one set.
      for (const i of items.filter((x) => x.base_row_id)) {
        const closed = await client.query(
          `UPDATE ecr.${ENTITY_DEFS[i.entity_type].table} SET version_to = $2 WHERE id = $1 AND version_to IS NULL`,
          [i.base_row_id, v],
        );
        if (closed.rowCount === 0) {
          throw new ApiError(409, 'STALE_CHANGE_SET', 'Change set is stale — rebase required: a record it changes was published again meanwhile.', {
            entityType: i.entity_type,
            entityId: i.entity_id,
          });
        }
        if (i.operation !== 'WITHDRAW') {
          await client.query('UPDATE ecr.entity_key SET natural_key = $2 WHERE entity_id = $1', [i.entity_id, ENTITY_DEFS[i.entity_type].naturalKey(i.after)]);
        }
      }
      // A withdrawn record gets no successor row: it leaves the current data and stays in history.
      for (const i of items.filter((x) => x.operation !== 'WITHDRAW')) {
        await ENTITY_DEFS[i.entity_type].insertRow(client, { entityId: i.entity_id, versionNo: v, changeSetId: set.id }, i.after);
      }

      await client.query('UPDATE ecr.change_item SET is_open = false, updated_at = now() WHERE change_set_id = $1', [set.id]);
      await client.query(`UPDATE ecr.change_set SET status = 'PUBLISHED', version_no = $2, updated_at = now() WHERE id = $1`, [set.id, v]);
      if (set.kind === 'ROLLBACK' && set.rollback_of_version) {
        // The erroneous version stays in history, marked as rolled back (US-30-P2 AC1).
        await client.query('UPDATE ecr.data_version SET rolled_back_by_version = $2 WHERE version_no = $1 AND rolled_back_by_version IS NULL',
          [set.rollback_of_version, v]);
      }
      await this.audit.record(client, {
        action: 'CHANGESET_PUBLISHED',
        actorKind: publishedBy ? 'USER' : 'SYSTEM',
        actorUserId: publishedBy,
        entityType: 'CHANGE_SET',
        entityId: set.id,
        after: { versionNo: v, items: items.length },
      });
      // Same transaction: the Maker's notice and the subscribers' notices exist exactly when the version does.
      await this.notifications.published(client, set, v, items);
      return v;
    } catch (err) {
      Object.assign(err as object, { changeSetId: set.id });
      throw err;
    }
  }

  // ------------------------------------------------------------------ helpers

  private async findSet(q: Queryable, id: string): Promise<SetRow> {
    const { rows } = await q.query<SetRow>('SELECT * FROM ecr.change_set WHERE id = $1', [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Change set not found.');
    return rows[0];
  }

  private async lockSet(client: PoolClient, id: string): Promise<SetRow> {
    const { rows } = await client.query<SetRow>('SELECT * FROM ecr.change_set WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Change set not found.');
    return rows[0];
  }

  private async lockEditable(client: PoolClient, actor: Actor, id: string): Promise<SetRow> {
    const set = await this.lockSet(client, id);
    this.requireOwner(actor, set);
    requireStatus(set, EDITABLE, 'Only a draft or rejected change set can be changed.');
    return set;
  }

  private requireOwner(actor: Actor, set: SetRow): void {
    if (set.created_by !== actor.id) throw new ApiError(403, 'NOT_OWNER', 'Only the Maker who created this change set can change it.');
  }

  /** SoD-1: nobody reviews a set they created or edited (US-29-N1 AC1). Refusals are audited. */
  private async requireIndependent(client: PoolClient, actor: Actor, set: SetRow): Promise<void> {
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ecr.change_item WHERE change_set_id = $1 AND $2 = ANY(edited_by)',
      [set.id, actor.id],
    );
    if (set.created_by === actor.id || rows[0].n > 0) {
      // Separate connection: the caller's transaction rolls back, the refusal must stay recorded.
      await this.record(this.db.pool, actor, 'SOD_DENIED', set.id, { after: { rule: 'SoD-1' } });
      throw new ApiError(403, 'SOD_VIOLATION', 'You created or edited this change set, so another Checker must review it (SoD-1).');
    }
  }

  private async touchDraft(client: PoolClient, set: SetRow): Promise<void> {
    // Editing invalidates earlier findings; a rejected set goes back to draft for rework.
    await client.query('DELETE FROM ecr.dq_finding WHERE change_set_id = $1', [set.id]);
    await client.query(`UPDATE ecr.change_set SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [set.id]);
  }

  private async assertRegulationUnique(client: PoolClient, setId: string, entityId: string, d: RegulationData): Promise<void> {
    const { rows } = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM ecr.regulation
        WHERE version_to IS NULL AND reg_type = $1 AND upper(number) = upper($2) AND year = $3 AND entity_id <> $4
       UNION ALL
       SELECT entity_id FROM ecr.change_item
        WHERE change_set_id = $5 AND entity_type = 'REGULATION' AND entity_id <> $4
          AND after->>'regType' = $1 AND upper(after->>'number') = upper($2) AND (after->>'year')::int = $3`,
      [d.regType, d.number, d.year, entityId, setId],
    );
    if (rows[0]) {
      throw new ApiError(409, 'REGULATION_EXISTS', `${regulationLabel(d)} is already registered.`, { entityId: rows[0].entity_id });
    }
  }

  private async assertNotStale(client: PoolClient, setId: string): Promise<void> {
    for (const i of await this.loadItems(client, setId)) {
      if (!i.base_row_id) continue;
      const { rows } = await client.query(`SELECT 1 FROM ecr.${ENTITY_DEFS[i.entity_type].table} WHERE id = $1 AND version_to IS NULL`, [i.base_row_id]);
      if (!rows[0]) {
        throw new ApiError(409, 'STALE_CHANGE_SET', 'Change set is stale — rebase required: a record it changes was published again meanwhile.', {
          entityType: i.entity_type,
          entityId: i.entity_id,
        });
      }
    }
  }

  private async loadItems(q: Queryable, setId: string): Promise<ItemRow[]> {
    const { rows } = await q.query<ItemRow>('SELECT * FROM ecr.change_item WHERE change_set_id = $1 ORDER BY created_at, id', [setId]);
    return rows;
  }

  private async runValidation(client: PoolClient, setId: string): Promise<Finding[]> {
    return validateItems(client, (await this.loadItems(client, setId)).map(toValidationItem), wibToday());
  }

  private async storeFindings(client: PoolClient, setId: string, findings: Finding[], acknowledgedBy: string | null): Promise<void> {
    await client.query('DELETE FROM ecr.dq_finding WHERE change_set_id = $1', [setId]);
    const { rows } = await client.query<{ id: string }>('SELECT uuidv7() AS id');
    for (const x of findings) {
      const ack = x.severity === 'WARNING' && acknowledgedBy;
      await client.query(
        `INSERT INTO ecr.dq_finding (change_set_id, run_id, rule_code, severity, entity_type, entity_id, field, message, acknowledged_by, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END)`,
        [setId, rows[0].id, x.ruleCode, x.severity, x.entityType, x.entityId, x.field, x.message, ack ? acknowledgedBy : null],
      );
    }
  }

  /** Labels for every record or document an item refers to, from this set or the published data. */
  private async referenceLabels(q: Queryable, items: ItemRow[]): Promise<Record<string, string>> {
    const labels: Record<string, string> = {};
    for (const i of items) labels[i.entity_id] = ENTITY_DEFS[i.entity_type].label(i.after);
    const wanted = new Set<string>();
    for (const i of items) for (const data of [i.before, i.after]) if (data) collectReferences(data, wanted);
    const missing = [...wanted].filter((id) => !labels[id]);
    for (const type of Object.keys(ENTITY_DEFS) as EntityType[]) {
      if (!missing.length) break;
      for (const [id, row] of await loadCurrent(q, type, missing)) labels[id] = ENTITY_DEFS[type].label(row.data);
    }
    const docIds = missing.filter((id) => !labels[id]);
    if (docIds.length) {
      const { rows } = await q.query<{ id: string; title: string }>('SELECT id, title FROM ecr.source_document WHERE id = ANY($1::uuid[])', [docIds]);
      for (const r of rows) labels[r.id] = r.title;
    }
    return labels;
  }

  private record(q: Queryable, actor: Actor, action: string, setId: string, extra: { before?: unknown; after?: unknown; reason?: string }) {
    return this.audit.record(q, {
      action,
      actorKind: 'USER',
      actorUserId: actor.id,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      entityType: 'CHANGE_SET',
      entityId: setId,
      ...extra,
    });
  }
}

function requireStatus(set: SetRow, allowed: string[], message: string): void {
  if (!allowed.includes(set.status)) throw new ApiError(409, 'INVALID_STATE', message, { status: set.status });
}

function lockedError(holder: { change_set_id: string; title: string; holder: string }): ApiError {
  return new ApiError(409, 'ENTITY_LOCKED', `This record is being edited in change set “${holder.title}” by ${holder.holder}.`, {
    changeSetId: holder.change_set_id,
    holder: holder.holder,
  });
}

function toValidationItem(i: ItemRow) {
  return { entityType: i.entity_type, entityId: i.entity_id, operation: i.operation, after: i.after };
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Field-level differences between two snapshots in form order (US-29-P2 AC1); every filled field for a new record. */
export function diff(before: EntityData | null, after: EntityData, order: readonly string[]): { field: string; before: unknown; after: unknown }[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const fields = [...new Set([...order, ...Object.keys(b), ...Object.keys(a)])];
  const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  return fields
    .filter((k) => (before ? JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null) : !empty(a[k])))
    .map((k) => ({ field: k, before: before ? (b[k] ?? null) : null, after: a[k] ?? null }));
}
