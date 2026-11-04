import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { catalogueQuery } from '../catalogue/catalogue.controller';
import type { CatalogueQuery } from '../catalogue/catalogue.service';
import { ApiError } from '../common/api-error';
import { asObject } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ObjectStore } from '../registry/file-handling';
import { OBJECT_STORE } from '../registry/source-documents.service';
import { ExportsService, Format, FORMATS, MAX_JOB_ROWS } from './exports.service';

/** How long a finished file can be downloaded (US-47-N1 AC3). */
export const LINK_HOURS = 24;
/** Open (queued or running) jobs per person, so one user cannot fill the queue. */
const MAX_OPEN_JOBS = 3;
/** A job still RUNNING after this long is assumed lost with its process and queued again. */
const STALE_MINUTES = 30;
const MAX_ATTEMPTS = 3;

interface JobRow {
  id: string;
  requested_by: string;
  kind: string;
  format: Format;
  query: CatalogueQuery;
  version_no: number;
  status: string;
  attempts: number;
  row_count: number | null;
  file_name: string | null;
  object_key: string | null;
  byte_size: number | null;
  sha256: Buffer | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
}

const CONTENT_TYPE: Record<Format, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Large catalogue exports (PRD US-47-N1 AC3; Technical Design §4.3.3 "Large export"). A request is queued with the
 * data version pinned; the in-process runner builds the file, stores it and notifies the requester, whose link
 * opens only through ECR after sign-in. Only the requester downloads it, for 24 hours; then the file is removed.
 */
@Injectable()
export class ExportJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ExportJobs');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  onModuleInit(): void {
    if (this.config.exportJobIntervalMs > 0) {
      this.timer = setInterval(() => this.kick(), this.config.exportJobIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs the queue now (after a request) without waiting for the next tick; one run at a time per process. */
  private kick(): void {
    if (this.running) return;
    this.running = true;
    Promise.all([this.runDue(), this.purgeExpired()])
      .catch((err) => this.logger.error(`export jobs failed: ${(err as Error).message}`))
      .finally(() => {
        this.running = false;
      });
  }

  /** Body: { format: csv | xlsx, query: the catalogue's query parameters }. */
  async request(actor: Actor, input: unknown) {
    const body = asObject(input);
    const format = body.format as Format;
    if (!FORMATS.includes(format)) throw new ApiError(400, 'INVALID_INPUT', 'format must be csv or xlsx.');
    const params = Object.fromEntries(Object.entries(asObject(body.query)).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const query = catalogueQuery(params);
    // The file shows the data as it was when asked for, however long the queue takes.
    const { rows: [latest] } = await this.db.query<{ v: number | null }>('SELECT max(version_no) AS v FROM ecr.data_version');
    const versionNo = query.versionNo ?? latest.v;
    if (!versionNo || versionNo > (latest.v ?? 0)) throw new ApiError(400, 'INVALID_INPUT', 'No such data version.');

    const id = await this.db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`export-jobs:${actor.id}`]);
      const { rows: [open] } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ecr.export_job WHERE requested_by = $1 AND status IN ('QUEUED', 'RUNNING')`, [actor.id],
      );
      if (open.n >= MAX_OPEN_JOBS) {
        throw new ApiError(429, 'EXPORT_QUEUE_FULL', `You already have ${open.n} exports being prepared; wait for one to finish.`);
      }
      const { rows: [job] } = await client.query<{ id: string }>(
        `INSERT INTO ecr.export_job (requested_by, kind, format, query, version_no) VALUES ($1, 'CATALOGUE', $2, $3, $4) RETURNING id`,
        [actor.id, format, JSON.stringify({ ...query, versionNo }), versionNo],
      );
      await this.audit.record(client, {
        action: 'EXPORT_REQUESTED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
        entityType: 'EXPORT_JOB', entityId: job.id, after: { format, versionNo, date: query.date, q: query.q ?? null },
      });
      return job.id;
    });
    if (this.config.exportJobIntervalMs > 0) setImmediate(() => this.kick());
    return this.get(actor.id, id);
  }

  async list(userId: string) {
    const { rows } = await this.db.query<JobRow>('SELECT * FROM ecr.export_job WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    return rows.map((r) => this.view(r));
  }

  /** Only the requester sees a job; for anyone else it does not exist (US-47-N1 AC3 "to the requesting user only"). */
  async get(userId: string, id: string) {
    return this.view(await this.own(userId, id));
  }

  async file(actor: Actor, id: string): Promise<{ body: Buffer; filename: string; contentType: string }> {
    const job = await this.own(actor.id, id);
    if (job.status === 'EXPIRED' || (job.status === 'READY' && job.expires_at! <= new Date())) {
      throw new ApiError(410, 'EXPORT_EXPIRED', 'This export has expired; request it again from the catalogue.');
    }
    if (job.status !== 'READY') throw new ApiError(409, 'EXPORT_NOT_READY', 'The export is not ready yet.', { status: job.status });
    const body = await this.store.get(job.object_key!);
    if (!createHash('sha256').update(body).digest().equals(job.sha256!)) {
      throw new ApiError(409, 'EXPORT_INTEGRITY', 'The stored export does not match its checksum; request it again.');
    }
    await this.audit.record(this.db.pool, {
      action: 'EXPORT_DOWNLOADED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'EXPORT_JOB', entityId: id, after: { format: job.format, rows: job.row_count, versionNo: job.version_no },
    });
    return { body, filename: job.file_name!, contentType: CONTENT_TYPE[job.format] };
  }

  // ------------------------------------------------------------------ runner

  /** Builds queued exports one by one; a run lost with its process is queued again after 30 minutes. */
  async runDue(): Promise<{ ready: string[]; failed: string[] }> {
    await this.db.query(
      `UPDATE ecr.export_job SET status = 'QUEUED' WHERE status = 'RUNNING' AND started_at < now() - make_interval(mins => $1)`,
      [STALE_MINUTES],
    );
    const ready: string[] = [];
    const failed: string[] = [];
    for (;;) {
      const { rows: [job] } = await this.db.query<JobRow>(
        `UPDATE ecr.export_job SET status = 'RUNNING', started_at = now(), attempts = attempts + 1
          WHERE id = (SELECT id FROM ecr.export_job WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
      );
      if (!job) break;
      try {
        await this.build(job);
        ready.push(job.id);
      } catch (err) {
        failed.push(job.id);
        await this.fail(job, err as Error);
      }
    }
    return { ready, failed };
  }

  private async build(job: JobRow) {
    const built = await this.exports.buildCatalogue(job.requested_by, job.query, job.format, MAX_JOB_ROWS);
    if ('tooLarge' in built) {
      throw new ApiError(422, 'EXPORT_TOO_LARGE', `${built.tooLarge.toLocaleString('en')} rows is more than the ${MAX_JOB_ROWS.toLocaleString('en')} an export can hold.`);
    }
    const sha = createHash('sha256').update(built.file.body).digest();
    const key = `exports/${new Date().getUTCFullYear()}/${job.id}.${job.format}`;
    await this.store.put(key, built.file.body);
    await this.db.tx(async (client) => {
      const { rows: [done] } = await client.query<{ expires_at: Date }>(
        `UPDATE ecr.export_job SET status = 'READY', row_count = $2, file_name = $3, object_key = $4, byte_size = $5, sha256 = $6,
                finished_at = now(), expires_at = now() + make_interval(hours => $7), error = NULL
          WHERE id = $1 AND status = 'RUNNING' RETURNING expires_at`,
        [job.id, built.rows, built.file.filename, key, built.file.body.length, sha, LINK_HOURS],
      );
      if (!done) return;
      await this.audit.record(client, {
        action: 'EXPORT_GENERATED', actorKind: 'SYSTEM', entityType: 'EXPORT_JOB', entityId: job.id,
        after: { ...built.audit, sha256: sha.toString('hex'), requestedBy: job.requested_by },
      });
      await this.notifications.exportReady(client, job.requested_by, { id: job.id, rows: built.rows, format: job.format, expiresAt: done.expires_at });
    });
  }

  /** A deterministic refusal (too many rows) fails at once; anything else is retried up to three attempts. */
  private async fail(job: JobRow, err: Error) {
    const final = err instanceof ApiError || job.attempts >= MAX_ATTEMPTS;
    this.logger.warn(`Export ${job.id} attempt ${job.attempts} failed: ${err.message}`);
    await this.db.tx(async (client) => {
      await client.query(`UPDATE ecr.export_job SET status = $2, error = $3, finished_at = CASE WHEN $2 = 'FAILED' THEN now() END WHERE id = $1`,
        [job.id, final ? 'FAILED' : 'QUEUED', err.message.slice(0, 500)]);
      if (!final) return;
      await this.audit.record(client, { action: 'EXPORT_FAILED', actorKind: 'SYSTEM', entityType: 'EXPORT_JOB', entityId: job.id, after: { error: err.message.slice(0, 500) } });
      await this.notifications.exportFailed(client, job.requested_by, job.id, err instanceof ApiError ? err.message : 'The export failed.');
    });
  }

  /** Files past their 24 hours are removed; the job stays as a record (status EXPIRED). */
  async purgeExpired(now = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM ecr.export_job WHERE status = 'READY' AND expires_at <= $1`, [now],
    );
    for (const r of rows) {
      await this.store.delete(r.object_key);
      await this.db.query(`UPDATE ecr.export_job SET status = 'EXPIRED' WHERE id = $1 AND status = 'READY'`, [r.id]);
    }
    return rows.length;
  }

  // ------------------------------------------------------------------ helpers

  private async own(userId: string, id: string): Promise<JobRow> {
    const { rows } = await this.db.query<JobRow>('SELECT * FROM ecr.export_job WHERE id = $1 AND requested_by = $2', [id, userId]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Export not found.');
    return rows[0];
  }

  private view(r: JobRow) {
    const expired = r.status === 'EXPIRED' || (r.status === 'READY' && r.expires_at! <= new Date());
    return {
      id: r.id,
      kind: r.kind,
      format: r.format,
      status: expired ? 'EXPIRED' : r.status,
      versionNo: r.version_no,
      date: r.query.date,
      search: r.query.q ?? null,
      rowCount: r.row_count,
      fileName: r.file_name,
      byteSize: r.byte_size,
      error: r.status === 'FAILED' ? r.error : null,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      expiresAt: r.expires_at,
    };
  }
}
