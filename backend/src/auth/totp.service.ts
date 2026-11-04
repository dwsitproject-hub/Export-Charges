import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { decrypt, encrypt, sha256 } from '../common/crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService, Queryable } from '../db/db.service';
import { generateRecoveryCodes, generateTotpSecret, normaliseRecoveryCode, otpauthUri, verifyTotp } from './totp';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

interface CredentialRow {
  totp_secret_enc: Buffer | null;
  totp_confirmed_at: Date | null;
  totp_last_step: string | null; // bigint arrives as string
  recovery_codes_hash: string[];
  failed_count: number;
  locked_until: Date | null;
}

export interface TotpStatus {
  enrolled: boolean;
  lockedUntil: Date | null;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; locked: Date | null };

interface Ctx {
  sessionId: string;
  ip: string;
  userAgent?: string;
}

/**
 * ECR TOTP for privileged roles: enrolment at first privileged sign-in and step-up before sensitive
 * actions, until DWS Hub reports MFA (Technical Design §4.1.6, T-01). Failed attempts are committed
 * before the error is returned, so the lockout cannot be bypassed by a rolled-back transaction.
 */
@Injectable()
export class TotpService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async status(q: Queryable, userId: string): Promise<TotpStatus> {
    const { rows } = await q.query<CredentialRow>('SELECT * FROM ecr.local_credential WHERE user_id = $1', [userId]);
    const row = rows[0];
    const locked = row?.locked_until && row.locked_until.getTime() > Date.now() ? row.locked_until : null;
    return { enrolled: !!row?.totp_confirmed_at, lockedUntil: locked };
  }

  async startEnrollment(userId: string, email: string, ctx: Ctx): Promise<{ secret: string; otpauthUri: string }> {
    return this.db.tx(async (c) => {
      const row = await this.lockRow(c, userId);
      if (row?.totp_confirmed_at) {
        throw new ApiError(409, 'TOTP_ALREADY_ENROLLED', 'An authenticator app is already set up. Ask an administrator to reset it.');
      }
      const secret = generateTotpSecret();
      await c.query(
        `INSERT INTO ecr.local_credential (user_id, totp_secret_enc)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET totp_secret_enc = EXCLUDED.totp_secret_enc, totp_confirmed_at = NULL, totp_last_step = NULL,
               recovery_codes_hash = '{}', failed_count = 0, locked_until = NULL, updated_at = now()`,
        [userId, encrypt(this.config.encryptionKey, secret)],
      );
      await this.audit.record(c, { action: 'TOTP_ENROLL_STARTED', actorKind: 'USER', actorUserId: userId, ...ctx, entityType: 'APP_USER', entityId: userId });
      return { secret, otpauthUri: otpauthUri(secret, email, this.config.totpIssuer) };
    });
  }

  /** Confirms the first code, issues recovery codes (shown once) and counts as a step-up. */
  async confirmEnrollment(userId: string, code: string, ctx: Ctx): Promise<{ recoveryCodes: string[] }> {
    const outcome = await this.db.tx(async (c): Promise<Outcome<string[]>> => {
      const row = await this.lockRow(c, userId);
      if (!row?.totp_secret_enc) throw new ApiError(409, 'TOTP_NOT_STARTED', 'Start authenticator setup first.');
      if (row.totp_confirmed_at) throw new ApiError(409, 'TOTP_ALREADY_ENROLLED', 'An authenticator app is already set up.');
      this.assertNotLocked(row);

      const step = verifyTotp(decrypt(this.config.encryptionKey, row.totp_secret_enc), code, null);
      if (step === null) return { ok: false, locked: await this.recordFailure(c, userId, row, 'TOTP_ENROLL_FAILED', ctx) };

      const recoveryCodes = generateRecoveryCodes();
      await c.query(
        `UPDATE ecr.local_credential
            SET totp_confirmed_at = now(), totp_last_step = $2, recovery_codes_hash = $3,
                failed_count = 0, locked_until = NULL, updated_at = now()
          WHERE user_id = $1`,
        [userId, step, recoveryCodes.map(hashRecoveryCode)],
      );
      await c.query('UPDATE ecr.user_session SET stepped_up_at = now() WHERE id = $1', [ctx.sessionId]);
      await this.audit.record(c, { action: 'TOTP_ENROLLED', actorKind: 'USER', actorUserId: userId, ...ctx, entityType: 'APP_USER', entityId: userId });
      return { ok: true, value: recoveryCodes };
    });
    if (!outcome.ok) throw failureError(outcome.locked);
    return { recoveryCodes: outcome.value };
  }

  /** Verifies a TOTP code or a recovery code and marks the session as stepped up. */
  async stepUp(userId: string, input: { code?: string; recoveryCode?: string }, ctx: Ctx): Promise<{ method: string; recoveryCodesLeft: number }> {
    const outcome = await this.db.tx(async (c): Promise<Outcome<{ method: string; recoveryCodesLeft: number }>> => {
      const row = await this.lockRow(c, userId);
      if (!row?.totp_confirmed_at || !row.totp_secret_enc) {
        throw new ApiError(403, 'TOTP_NOT_ENROLLED', 'Set up an authenticator app first.');
      }
      this.assertNotLocked(row);

      let method: string;
      let remaining = row.recovery_codes_hash;
      if (input.code) {
        const lastStep = row.totp_last_step === null ? null : Number(row.totp_last_step);
        const step = verifyTotp(decrypt(this.config.encryptionKey, row.totp_secret_enc), input.code, lastStep);
        if (step === null) return { ok: false, locked: await this.recordFailure(c, userId, row, 'STEP_UP_FAILED', ctx) };
        await c.query('UPDATE ecr.local_credential SET totp_last_step = $2 WHERE user_id = $1', [userId, step]);
        method = 'TOTP';
      } else if (input.recoveryCode) {
        const hash = hashRecoveryCode(input.recoveryCode);
        if (!remaining.includes(hash)) return { ok: false, locked: await this.recordFailure(c, userId, row, 'STEP_UP_FAILED', ctx) };
        remaining = remaining.filter((h) => h !== hash);
        await c.query('UPDATE ecr.local_credential SET recovery_codes_hash = $2 WHERE user_id = $1', [userId, remaining]);
        method = 'RECOVERY_CODE';
      } else {
        throw new ApiError(400, 'INVALID_INPUT', 'Enter a 6-digit code or a recovery code.');
      }

      await c.query('UPDATE ecr.local_credential SET failed_count = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1', [userId]);
      await c.query('UPDATE ecr.user_session SET stepped_up_at = now() WHERE id = $1', [ctx.sessionId]);
      await this.audit.record(c, {
        action: 'STEP_UP_SUCCESS',
        actorKind: 'USER',
        actorUserId: userId,
        ...ctx,
        entityType: 'USER_SESSION',
        entityId: ctx.sessionId,
        after: { method, recoveryCodesLeft: remaining.length },
      });
      return { ok: true, value: { method, recoveryCodesLeft: remaining.length } };
    });
    if (!outcome.ok) throw failureError(outcome.locked);
    return outcome.value;
  }

  /** Clears the authenticator so the user enrols again at next privileged use (admin action). */
  async reset(q: Queryable, userId: string): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE ecr.local_credential
          SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = NULL, recovery_codes_hash = '{}',
              failed_count = 0, locked_until = NULL, updated_at = now()
        WHERE user_id = $1 AND totp_secret_enc IS NOT NULL`,
      [userId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async lockRow(c: PoolClient, userId: string): Promise<CredentialRow | undefined> {
    const { rows } = await c.query<CredentialRow>('SELECT * FROM ecr.local_credential WHERE user_id = $1 FOR UPDATE', [userId]);
    return rows[0];
  }

  private assertNotLocked(row: CredentialRow): void {
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      throw new ApiError(429, 'TOTP_LOCKED', 'Too many wrong codes. Try again later.', { lockedUntil: row.locked_until });
    }
  }

  /** Counts a failure; after MAX_FAILURES the authenticator is locked for LOCK_MINUTES. Returns the lock end, if any. */
  private async recordFailure(c: PoolClient, userId: string, row: CredentialRow, action: string, ctx: Ctx): Promise<Date | null> {
    const failures = row.failed_count + 1;
    const lock = failures >= MAX_FAILURES;
    const { rows } = await c.query<{ locked_until: Date | null }>(
      `UPDATE ecr.local_credential
          SET failed_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END,
              updated_at = now()
        WHERE user_id = $1 RETURNING locked_until`,
      [userId, lock ? 0 : failures, lock, LOCK_MINUTES],
    );
    await this.audit.record(c, { action, actorKind: 'USER', actorUserId: userId, ...ctx, entityType: 'APP_USER', entityId: userId, after: { failures, locked: lock } });
    return lock ? rows[0].locked_until : null;
  }
}

function hashRecoveryCode(code: string): string {
  return sha256(normaliseRecoveryCode(code)).toString('hex');
}

function failureError(lockedUntil: Date | null): ApiError {
  return lockedUntil
    ? new ApiError(429, 'TOTP_LOCKED', 'Too many wrong codes. Try again later.', { lockedUntil })
    : new ApiError(400, 'TOTP_INVALID', 'That code is not valid. Check your authenticator app and try again.');
}
