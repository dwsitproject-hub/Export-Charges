import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AccessReviewsService } from '../access-reviews/access-reviews.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { OidcService } from '../auth/oidc.service';
import { ApiError } from '../common/api-error';
import { addDays, wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { wibDateTime } from '../exports/present';
import { NotificationsService } from '../notifications/notifications.service';
import { SourceWatchService } from '../source-watch/source-watch.service';
import { CandidateState } from '../registry/candidate';
import { ENTITY_DEFS, EntityType } from '../registry/entities';
import { validateItems } from '../registry/validation';
import { valueOn } from '../tariffs/charge-engine';
import type { RefSeriesData, RefValueData, ScheduleLineData } from '../tariffs/tariff-entities';

type Schedule = { daily: string } | { everyMinutes: number };

interface JobDef {
  name: string;
  description: string;
  schedule: Schedule;
  run: (runId: string) => Promise<Record<string, unknown>>;
}

/** A job that ran but found a problem it has already alerted about (the run is recorded as FAILED). */
class JobFinding extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
  }
}

/** BR-IAM-11: no sign-in for 90 days disables the account; a warning goes out at day 80. */
export const DORMANT_DAYS = 90;
export const WARN_DAYS = 80;
/** Revoked or expired sessions are kept this long for investigation, then deleted. */
const SESSION_KEEP_DAYS = 30;
/** Nightly findings are kept this long; change-set findings are kept with their set. */
const NIGHTLY_KEEP_DAYS = 30;
/** A run still RUNNING after this long died with its process. */
const STALE_RUN_HOURS = 2;

/** WIB moment of `hh:mm` on business date `date`. */
const wibAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

/**
 * Scheduled jobs (Technical Design §4.2.7), run in the API process. Every tick, each job that is due runs under a
 * PostgreSQL advisory lock, so with several API instances only one runs it; every run is recorded in job_run.
 * publish-due, email-outbox and the export runner keep their own short intervals.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private timer?: NodeJS.Timeout;
  private ticking = false;
  readonly jobs: JobDef[];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly oidc: OidcService,
    private readonly reviews: AccessReviewsService,
    private readonly sourceWatch: SourceWatchService,
  ) {
    this.jobs = [
      { name: 'dq-nightly', description: 'Data-quality rules on all published data (FR-DQ-01, US-51-P1)', schedule: { daily: '01:00' }, run: (id) => this.dqNightly(id) },
      { name: 'dormancy', description: 'Warn at day 80 and disable at day 90 without sign-in (BR-IAM-11)', schedule: { daily: '01:30' }, run: () => this.dormancy() },
      { name: 'audit-chain-verify', description: 'Recompute the audit hash chain; alert on a break (US-50-N1 AC2)', schedule: { daily: '03:30' }, run: () => this.auditChain() },
      { name: 'source-watch', description: 'Check BPK status of registered regulations and official listings for new documents (FR-SRC-03/04)', schedule: { daily: '06:00' }, run: (id) => this.sourceWatch.run(id) },
      { name: 'ref-gap-check', description: 'Warn when no reference price or KMK rate covers today (US-27-N2)', schedule: { daily: '07:00' }, run: () => this.refGapCheck() },
      { name: 'access-review', description: 'Open the quarterly access review; escalate assignments open 14 days (L2-1.9, US-12)', schedule: { daily: '08:00' }, run: (id) => this.accessReview(id) },
      { name: 'jwks-refresh', description: 'Reload the DWS Hub discovery document and signing keys', schedule: { everyMinutes: 360 }, run: () => this.oidc.refreshKeys() },
      { name: 'session-sweep', description: 'End expired sessions; delete old sessions and sign-in states', schedule: { everyMinutes: 15 }, run: () => this.sessionSweep() },
    ];
  }

  onModuleInit(): void {
    if (this.config.schedulerTickMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.config.schedulerTickMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ scheduling

  /** Runs every job that is due; one tick at a time per process. */
  async tick(now = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const ran: string[] = [];
    try {
      await this.db.query(
        `UPDATE ecr.job_run SET status = 'FAILED', finished_at = now(), error = 'Interrupted (the process stopped while it ran)'
          WHERE status = 'RUNNING' AND started_at < now() - make_interval(hours => $1)`,
        [STALE_RUN_HOURS],
      );
      for (const job of this.jobs) {
        if (await this.isDue(job, now)) {
          const run = await this.execute(job, null, now);
          if (run) ran.push(job.name);
        }
      }
    } catch (err) {
      this.logger.error(`scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  /** Daily jobs are due once their WIB time has passed today and they have not started since; others by interval. */
  private async isDue(job: JobDef, now: Date): Promise<boolean> {
    const { rows: [last] } = await this.db.query<{ started_at: Date }>(
      'SELECT started_at FROM ecr.job_run WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1', [job.name],
    );
    if ('daily' in job.schedule) {
      const today = wibToday(now);
      let slot = wibAt(today, job.schedule.daily);
      if (slot > now) slot = wibAt(addDays(today, -1), job.schedule.daily);
      return !last || last.started_at < slot;
    }
    return !last || now.getTime() - last.started_at.getTime() >= job.schedule.everyMinutes * 60_000;
  }

  /** Runs one job under its advisory lock; null when another instance holds it. */
  private async execute(job: JobDef, triggeredBy: string | null, now = new Date()) {
    const client = await this.db.pool.connect();
    try {
      const { rows: [lock] } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`ecr.job:${job.name}`]);
      if (!lock.ok) return null;
      try {
        // Another instance may have run it between the due check and the lock.
        if (!triggeredBy && !(await this.isDue(job, now))) return null;
        const { rows: [run] } = await client.query<{ id: string }>(
          'INSERT INTO ecr.job_run (job_name, triggered_by) VALUES ($1, $2) RETURNING id', [job.name, triggeredBy],
        );
        let status = 'OK';
        let details: Record<string, unknown> | null = null;
        let error: string | null = null;
        try {
          details = await job.run(run.id);
        } catch (err) {
          status = 'FAILED';
          error = (err as Error).message.slice(0, 1000);
          if (err instanceof JobFinding) details = err.details;
          else await this.jobFailed(job.name, error);
          this.logger.warn(`${job.name} failed: ${error}`);
        }
        await client.query('UPDATE ecr.job_run SET status = $2, details = $3, error = $4, finished_at = now() WHERE id = $1',
          [run.id, status, details ? JSON.stringify(details) : null, error]);
        return run.id;
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ecr.job:${job.name}`]);
      }
    } finally {
      client.release();
    }
  }

  /** "Run now" (Super Admin with a fresh authenticator code). */
  async runNow(actor: Actor, name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'No such job.');
    await this.audit.record(this.db.pool, {
      action: 'JOB_RUN_REQUESTED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'JOB', entityId: name,
    });
    const id = await this.execute(job, actor.id);
    if (!id) throw new ApiError(409, 'JOB_RUNNING', 'This job is running right now; try again when it has finished.');
    return this.run(id);
  }

  async list() {
    const { rows } = await this.db.query<{ job_name: string; id: string }>(
      'SELECT DISTINCT ON (job_name) job_name, id FROM ecr.job_run ORDER BY job_name, started_at DESC',
    );
    const last = new Map(rows.map((r) => [r.job_name, r.id]));
    return Promise.all(this.jobs.map(async (j) => ({
      name: j.name,
      description: j.description,
      schedule: 'daily' in j.schedule ? `Daily ${j.schedule.daily} WIB` : `Every ${j.schedule.everyMinutes >= 60 ? `${j.schedule.everyMinutes / 60} h` : `${j.schedule.everyMinutes} min`}`,
      lastRun: last.has(j.name) ? await this.run(last.get(j.name)!) : null,
    })));
  }

  async history(name: string) {
    if (!this.jobs.some((j) => j.name === name)) throw new ApiError(404, 'NOT_FOUND', 'No such job.');
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM ecr.job_run WHERE job_name = $1 ORDER BY started_at DESC LIMIT 30', [name]);
    return Promise.all(rows.map((r) => this.run(r.id)));
  }

  private async run(id: string) {
    const { rows: [r] } = await this.db.query(
      `SELECT r.id, r.job_name AS "jobName", r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.details, r.error,
              u.full_name AS "triggeredBy"
         FROM ecr.job_run r LEFT JOIN ecr.app_user u ON u.id = r.triggered_by WHERE r.id = $1`,
      [id],
    );
    return r;
  }

  private jobFailed(name: string, error: string) {
    return this.notifications.alert(this.db.pool, { roles: ['SUPER_ADMIN'] }, {
      kind: 'JOB_FAILED',
      title: `Scheduled job ${name} failed`,
      body: `The job will run again at its next time. Reason: ${error}`,
      link: '/admin/jobs',
      dedupeKey: `job-failed:${name}:${wibToday()}`,
    });
  }

  // ------------------------------------------------------------------ the jobs

  /**
   * dq-nightly (FR-DQ-01, US-51-P1): every published record goes through the same rules as a change set, so data
   * that became wrong over time (a price period ending, a regulation expiring) shows up before users see it.
   */
  private async dqNightly(runId: string) {
    const state = await CandidateState.load(this.db.pool);
    const items = [...state.records].map(([entityId, c]) => ({ entityType: c.type, entityId, operation: 'UPDATE' as const, after: c.data }));
    const findings = items.length ? await validateItems(this.db.pool, items, wibToday()) : [];
    const count = (s: string) => findings.filter((f) => f.severity === s).length;
    await this.db.tx(async (client) => {
      await client.query(`DELETE FROM ecr.dq_finding WHERE change_set_id IS NULL AND created_at < now() - make_interval(days => $1)`, [NIGHTLY_KEEP_DAYS]);
      for (const f of findings) {
        await client.query(
          `INSERT INTO ecr.dq_finding (change_set_id, run_id, rule_code, severity, entity_type, entity_id, field, message)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
          [runId, f.ruleCode, f.severity, f.entityType, f.entityId, f.field, f.message],
        );
      }
      if (count('ERROR')) {
        await this.notifications.alert(client, { permissions: ['changeset.approve', 'changeset.create'] }, {
          kind: 'DQ_ERRORS',
          title: `Data quality: ${count('ERROR')} error(s) in the published data`,
          body: 'The nightly check found published records that break a rule. Correct them with a change set.',
          link: '/data-quality',
          dedupeKey: `dq-nightly:${wibToday()}`,
        });
      }
    });
    return { records: items.length, errors: count('ERROR'), warnings: count('WARNING'), info: count('INFO') };
  }

  /** dormancy (BR-IAM-11, US-12): warn at day 80, disable at day 90; never below two active Super Admins (SoD-4). */
  private async dormancy() {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string; email: string; last_activity: Date; warned: boolean; super_admin: boolean }>(
        `SELECT u.id, u.email, GREATEST(u.last_login_at, u.reactivated_at, u.created_at) AS last_activity,
                u.dormancy_warned_at IS NOT NULL AND u.dormancy_warned_at > GREATEST(u.last_login_at, u.reactivated_at, u.created_at) AS warned,
                EXISTS (SELECT 1 FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
                         WHERE ur.user_id = u.id AND r.code = 'SUPER_ADMIN' AND ur.revoked_at IS NULL) AS super_admin
           FROM ecr.app_user u
          WHERE u.status = 'ACTIVE' AND NOT u.is_break_glass
            AND GREATEST(u.last_login_at, u.reactivated_at, u.created_at) < now() - make_interval(days => $1)
          FOR UPDATE OF u`,
        [WARN_DAYS],
      );
      const { rows: [admins] } = await client.query<{ n: number }>(
        `SELECT count(DISTINCT u.id)::int AS n FROM ecr.app_user u JOIN ecr.user_role ur ON ur.user_id = u.id JOIN ecr.role r ON r.id = ur.role_id
          WHERE u.status = 'ACTIVE' AND r.code = 'SUPER_ADMIN' AND ur.revoked_at IS NULL`,
      );
      let activeAdmins = admins.n;
      const cutoff = new Date(Date.now() - DORMANT_DAYS * 86_400_000);
      let warned = 0;
      let disabled = 0;
      const skipped: string[] = [];
      for (const u of rows) {
        if (u.last_activity < cutoff) {
          if (u.super_admin && activeAdmins <= 2) {
            skipped.push(u.email);
            continue;
          }
          await client.query(
            `UPDATE ecr.app_user SET status = 'DORMANT_DISABLED', deactivated_reason = $2, updated_at = now() WHERE id = $1`,
            [u.id, `No sign-in for ${DORMANT_DAYS} days`],
          );
          await client.query(`UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = 'USER_INACTIVE' WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
          await this.audit.record(client, {
            action: 'USER_DORMANT_DISABLED', actorKind: 'SYSTEM', entityType: 'USER', entityId: u.id,
            before: { status: 'ACTIVE' }, after: { status: 'DORMANT_DISABLED', lastActivity: u.last_activity }, reason: `No sign-in for ${DORMANT_DAYS} days (BR-IAM-11)`,
          });
          if (u.super_admin) activeAdmins -= 1;
          disabled += 1;
        } else if (!u.warned) {
          const disableOn = new Date(u.last_activity.getTime() + DORMANT_DAYS * 86_400_000);
          await this.notifications.alert(client, { userIds: [u.id] }, {
            kind: 'DORMANCY_WARNING',
            title: `Your ECR account will be disabled on ${wibDateTime(disableOn).slice(0, 10)}`,
            body: `You have not signed in to ECR for ${WARN_DAYS} days. Sign in through DWS Hub before ${wibDateTime(disableOn)} to keep your access.`,
            link: '/',
            dedupeKey: `dormancy:${u.id}:${u.last_activity.toISOString()}`,
          });
          await client.query('UPDATE ecr.app_user SET dormancy_warned_at = now() WHERE id = $1', [u.id]);
          warned += 1;
        }
      }
      if (skipped.length) {
        await this.notifications.alert(client, { roles: ['SUPER_ADMIN'] }, {
          kind: 'DORMANCY_SKIPPED',
          title: 'Dormant Super Admin accounts were kept active',
          body: `${skipped.join(', ')}: no sign-in for ${DORMANT_DAYS} days, but disabling would leave fewer than two active Super Admins (SoD-4).`,
          link: '/admin/users',
          dedupeKey: `dormancy-skipped:${wibToday()}`,
        });
      }
      return { checked: rows.length, warned, disabled, skippedSuperAdmins: skipped.length };
    });
  }

  /** audit-chain-verify (US-50-N1 AC2): a break is a critical alert to Super Admins and Auditors. */
  private async auditChain() {
    const { rows: [r] } = await this.db.query<{ broken_at: string | null; total: string }>(
      'SELECT ecr.audit_chain_verify() AS broken_at, (SELECT count(*) FROM ecr.audit_event) AS total',
    );
    const details = { events: Number(r.total), intact: r.broken_at === null, brokenAtChainSeq: r.broken_at === null ? null : Number(r.broken_at) };
    if (r.broken_at === null) return details;
    await this.db.tx(async (client) => {
      await this.audit.record(client, { action: 'AUDIT_CHAIN_BROKEN', actorKind: 'SYSTEM', entityType: 'AUDIT_CHAIN', entityId: r.broken_at, after: details });
      await this.notifications.alert(client, { roles: ['SUPER_ADMIN', 'AUDITOR'] }, {
        kind: 'AUDIT_CHAIN_BROKEN',
        title: `CRITICAL: the audit trail was altered at event ${r.broken_at}`,
        body: 'The nightly check found an audit event whose hash does not match. Treat this as a security incident.',
        link: '/admin/jobs',
        dedupeKey: `audit-chain:${wibToday()}`,
      });
    });
    throw new JobFinding(`Audit hash chain broken at event ${r.broken_at}`, details);
  }

  /** ref-gap-check (US-27-N2): each reference price and KMK series needs a value covering today. */
  private async refGapCheck() {
    const today = wibToday();
    const state = await CandidateState.load(this.db.pool);
    // Only series that charges or the IDR conversion actually use.
    const used = new Set(state.ofType<ScheduleLineData>('SCHEDULE_LINE').map((l) => l.data.refSeriesId).filter(Boolean));
    const series = state.ofType<RefSeriesData>('REF_SERIES')
      .filter((s) => (s.data.kind === 'REFERENCE_PRICE' && used.has(s.id)) || s.data.kind === 'FX_RATE');
    const missing = series.filter((s) => !valueOn(state, s.id, today)).map((s) => {
      const latest = state.ofType<RefValueData>('REF_VALUE').filter((v) => v.data.seriesId === s.id).map((v) => v.data.periodTo).sort().pop() ?? null;
      return { code: s.data.code, name: s.data.name, latestPeriodTo: latest };
    });
    if (missing.length) {
      await this.notifications.alert(this.db.pool, { permissions: ['changeset.create', 'changeset.approve'] }, {
        kind: 'REFERENCE_GAP',
        title: `No published value for today: ${missing.map((m) => m.code).join(', ')}`,
        body: `${missing.map((m) => `${m.code} (${m.name}) — last period ends ${m.latestPeriodTo ?? 'never published'}`).join('; ')}. Duty, levy or IDR for today cannot be calculated until the decree is entered and approved.`,
        link: '/prices',
        dedupeKey: `ref-gap:${today}`,
      });
    }
    return { date: today, checked: series.length, missing };
  }

  /** access-review: the review opens on the first run of each quarter (normally its first day at 08:00 WIB). */
  private async accessReview(runId: string) {
    const { rows: [run] } = await this.db.query<{ triggered_by: string | null }>('SELECT triggered_by FROM ecr.job_run WHERE id = $1', [runId]);
    return this.reviews.scheduled(run.triggered_by);
  }

  /** session-sweep: ends sessions past their limits and deletes old sessions and sign-in states. */
  private async sessionSweep() {
    const states = await this.db.query('DELETE FROM ecr.oidc_login_state WHERE expires_at < now()');
    const expired = await this.db.query(
      `UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = 'EXPIRED'
        WHERE revoked_at IS NULL AND (absolute_expires_at < now() OR last_seen_at + make_interval(mins => idle_timeout_minutes) < now())`,
    );
    const deleted = await this.db.query(
      `DELETE FROM ecr.user_session WHERE revoked_at < now() - make_interval(days => $1)`, [SESSION_KEEP_DAYS],
    );
    return { loginStatesDeleted: states.rowCount, sessionsEnded: expired.rowCount, sessionsDeleted: deleted.rowCount };
  }

  // ------------------------------------------------------------------ DQ dashboard

  /** US-51-P1: the findings of the latest nightly run, with a label and a page for each record. */
  async dqFindings() {
    const { rows: [run] } = await this.db.query<{ id: string; started_at: Date; details: Record<string, number> }>(
      `SELECT id, started_at, details FROM ecr.job_run WHERE job_name = 'dq-nightly' AND status = 'OK' ORDER BY started_at DESC LIMIT 1`,
    );
    if (!run) return { run: null, findings: [] };
    const { rows } = await this.db.query<{ rule_code: string; severity: string; entity_type: EntityType | null; entity_id: string | null; field: string | null; message: string }>(
      `SELECT rule_code, severity, entity_type, entity_id, field, message FROM ecr.dq_finding WHERE run_id = $1
        ORDER BY CASE severity WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, rule_code`,
      [run.id],
    );
    const state = await CandidateState.load(this.db.pool);
    const link = (type: EntityType | null, id: string | null): string | null => {
      if (!type || !id) return null;
      const c = state.records.get(id);
      if (type === 'PRODUCT') return `/products/${id}`;
      if (type === 'REGULATION') return `/regulations/${id}`;
      if (type === 'SCHEDULE') return `/schedules/${id}`;
      if (type === 'SCHEDULE_LINE') return c ? `/schedules/${(c.data as ScheduleLineData).scheduleId}` : null;
      if (type === 'REF_SERIES') return `/prices/${id}`;
      if (type === 'REF_VALUE') return c ? `/prices/${(c.data as RefValueData).seriesId}` : null;
      return null;
    };
    return {
      run: { id: run.id, at: run.started_at, ...run.details },
      findings: rows.map((f) => {
        const c = f.entity_id ? state.records.get(f.entity_id) : undefined;
        return {
          ruleCode: f.rule_code, severity: f.severity, entityType: f.entity_type, entityId: f.entity_id, field: f.field, message: f.message,
          label: c ? ENTITY_DEFS[c.type].label(c.data as never) : null,
          link: link(f.entity_type, f.entity_id),
        };
      }),
    };
  }
}
