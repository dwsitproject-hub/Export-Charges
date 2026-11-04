import { isIP } from 'node:net';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { FieldError } from '../common/fields';
import { ipAllowed, networkList } from '../common/http';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';

/** The settings a Super Admin may change; each key is the AppConfig field it overrides. */
type SettingKey =
  | 'sessionIdleMinutes' | 'privilegedIdleMinutes' | 'sessionAbsoluteHours' | 'maxSessionsPerUser' | 'stepUpWindowMinutes'
  | 'jitDefaultRoles' | 'allowedNetworks' | 'disclaimer';
type SettingValue = number | string | string[];

interface SettingDef {
  key: SettingKey;
  group: 'Sessions' | 'Access' | 'Network' | 'Wording';
  label: string;
  help: string;
  kind: 'integer' | 'roles' | 'networks' | 'text';
  unit?: string;
  /** US-52-N1 AC1: the allowed range (integers), or the text length. */
  min: number;
  max: number;
}

export const SETTINGS: SettingDef[] = [
  { key: 'sessionIdleMinutes', group: 'Sessions', label: 'Idle timeout', unit: 'minutes', kind: 'integer', min: 5, max: 60,
    help: 'A session with no request for this long ends (BR-IAM-08).' },
  { key: 'privilegedIdleMinutes', group: 'Sessions', label: 'Idle timeout for privileged roles', unit: 'minutes', kind: 'integer', min: 5, max: 60,
    help: 'For Makers, Checkers, User Admins, Auditors and Super Admins; at most the general idle timeout.' },
  { key: 'sessionAbsoluteHours', group: 'Sessions', label: 'Absolute session limit', unit: 'hours', kind: 'integer', min: 1, max: 12,
    help: 'A session ends this long after sign-in, whatever the activity.' },
  { key: 'maxSessionsPerUser', group: 'Sessions', label: 'Sessions per person', unit: 'sessions', kind: 'integer', min: 1, max: 5,
    help: 'A new sign-in beyond this ends the oldest session.' },
  { key: 'stepUpWindowMinutes', group: 'Sessions', label: 'Authenticator confirmation valid for', unit: 'minutes', kind: 'integer', min: 1, max: 15,
    help: 'How long one authenticator code covers sensitive actions (step-up).' },
  { key: 'jitDefaultRoles', group: 'Access', label: 'Roles at first sign-in', kind: 'roles', min: 0, max: 10,
    help: 'Given to an account created at its first DWS Hub sign-in. Privileged roles cannot be given this way (US-52-N1 AC2); none means a User Admin assigns roles.' },
  { key: 'allowedNetworks', group: 'Network', label: 'Office and VPN networks', kind: 'networks', min: 1, max: 50,
    help: 'Addresses or ranges (CIDR) allowed to reach ECR, one per line; mirrors the cloud security groups and WAF (US-14). Must include your own address.' },
  { key: 'disclaimer', group: 'Wording', label: 'Disclaimer', kind: 'text', min: 20, max: 1000,
    help: 'Printed on calculations, exports and evidence packs. Saved calculations keep the wording they were made with.' },
];

const CIDR = (s: string) => {
  const [address, prefix, extra] = s.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32);
};

/**
 * Configuration (PRD F-52, FR-CFG-01; Technical Design §7 `system_config`). Saved values override the deployment's
 * environment values in the shared AppConfig, so every service reads the current value; other API instances pick a
 * change up within `settingsRefreshMs`. Deployment-only settings (DWS Hub client, mail, storage) are shown read-only.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Settings');
  private readonly defaults: Record<SettingKey, SettingValue>;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {
    this.defaults = Object.fromEntries(SETTINGS.map((s) => [s.key, structuredClone(config[s.key])])) as Record<SettingKey, SettingValue>;
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
    if (this.config.settingsRefreshMs > 0) {
      this.timer = setInterval(() => void this.reload().catch((e) => this.logger.error(`reload failed: ${(e as Error).message}`)), this.config.settingsRefreshMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Applies the saved values (or the defaults) to the shared config; a stored value that no longer passes is ignored. */
  async reload(): Promise<void> {
    const { rows } = await this.db.query<{ key: string; value: SettingValue }>('SELECT key, value FROM ecr.system_config');
    const saved = new Map(rows.map((r) => [r.key, r.value]));
    const roles = await this.roles();
    const values = {} as Record<SettingKey, SettingValue>;
    for (const s of SETTINGS) {
      values[s.key] = saved.has(s.key) ? saved.get(s.key)! : this.defaults[s.key];
    }
    const errors = this.check(values, roles);
    for (const s of SETTINGS) {
      const bad = errors.some((e) => e.field === s.key);
      if (bad && saved.has(s.key)) this.logger.warn(`Ignoring stored ${s.key}: ${errors.find((e) => e.field === s.key)!.message}`);
      this.set(s.key, bad ? this.defaults[s.key] : values[s.key]);
    }
  }

  /** Assigns only when the value changed, so readers that cache by reference (the network guard) keep their cache. */
  private set(key: SettingKey, value: SettingValue): void {
    const target = this.config as unknown as Record<SettingKey, SettingValue>;
    if (JSON.stringify(target[key]) !== JSON.stringify(value)) target[key] = structuredClone(value);
  }

  // ------------------------------------------------------------------ reading

  async list() {
    const { rows } = await this.db.query<{ key: string; updated_at: Date; updated_by: string }>(
      `SELECT c.key, c.updated_at, u.full_name AS updated_by FROM ecr.system_config c JOIN ecr.app_user u ON u.id = c.updated_by`,
    );
    const saved = new Map(rows.map((r) => [r.key, r]));
    const roles = await this.roles();
    return {
      settings: SETTINGS.map((s) => ({
        ...s,
        value: this.config[s.key],
        default: this.defaults[s.key],
        overridden: saved.has(s.key),
        updatedAt: saved.get(s.key)?.updated_at ?? null,
        updatedBy: saved.get(s.key)?.updated_by ?? null,
        options: s.kind === 'roles' ? roles.map((r) => ({ code: r.code, name: r.name, privileged: r.is_privileged })) : undefined,
      })),
      // Not changeable here: they need a deployment (secrets, redirect URIs registered at DWS Hub) or are policy.
      fixed: [
        {
          label: 'Authenticator for privileged roles',
          value: this.config.totpExemptRoles.length ? `Required, except ${this.config.totpExemptRoles.join(', ')}` : 'Always required',
          note: 'TOTP_EXEMPT_ROLES',
        },
        { label: 'DWS Hub issuer', value: this.config.hubIssuer, note: 'HUB_ISSUER' },
        { label: 'DWS Hub client id', value: this.config.oidcClientId, note: 'OIDC_CLIENT_ID' },
        { label: 'Sign-in redirect URI', value: `${this.config.publicBaseUrl}/api/auth/callback`, note: 'Registered at DWS Hub; from PUBLIC_BASE_URL' },
        { label: 'DWS Hub discovery document', value: this.config.hubDiscoveryUrl, note: 'HUB_DISCOVERY_URL' },
        { label: 'Email', value: this.config.mailTransport === 'smtp' ? `SMTP ${this.config.smtp?.host}:${this.config.smtp?.port}, from ${this.config.mailFrom}` : this.config.mailTransport, note: 'MAIL_TRANSPORT, SMTP_*' },
        { label: 'Virus scan of uploads', value: this.config.malwareScanRequired ? `Required (ClamAV ${this.config.clamdHost}:${this.config.clamdPort})` : 'Not required', note: 'MALWARE_SCAN_REQUIRED, CLAMD_HOST' },
        { label: 'Secure cookies (HTTPS only)', value: this.config.cookieSecure ? 'Yes' : 'No', note: 'COOKIE_SECURE' },
      ],
    };
  }

  // ------------------------------------------------------------------ saving

  /**
   * US-52-P1: saves several settings at once (null restores the default). The values are checked together against the
   * allowed ranges; a change is audited with before and after and applies at once, also to the sessions already open.
   */
  async save(actor: Actor, body: { values?: unknown; reason?: unknown }) {
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    const input = body.values;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'INVALID_INPUT', 'values must be an object of settings.');
    const unknown = Object.keys(input).filter((k) => !SETTINGS.some((s) => s.key === k));
    if (unknown.length) throw new ApiError(400, 'INVALID_INPUT', `Unknown setting(s): ${unknown.join(', ')}`);
    if (reason.length < 3) {
      throw new ApiError(400, 'INVALID_INPUT', 'A reason of at least 3 characters is required.', { fields: [{ field: 'reason', message: 'A reason of at least 3 characters is required.' }] });
    }

    const changes = input as Partial<Record<SettingKey, SettingValue | null>>;
    const next = {} as Record<SettingKey, SettingValue>;
    for (const s of SETTINGS) {
      const v = changes[s.key];
      next[s.key] = v === undefined ? this.config[s.key] : v === null ? this.defaults[s.key] : normalise(s, v);
    }
    // Only the settings being saved can block it, so a deployment default outside policy can still be corrected here.
    const touched = (field: string) => changes[field as SettingKey] !== undefined ||
      (field === 'privilegedIdleMinutes' && changes.sessionIdleMinutes !== undefined);
    const errors = this.check(next, await this.roles()).filter((e) => touched(e.field));
    if (changes.allowedNetworks !== undefined && !errors.some((e) => e.field === 'allowedNetworks') && !ipAllowed(networkList(next.allowedNetworks as string[]), actor.ip)) {
      errors.push({ field: 'allowedNetworks', message: `Your own address ${actor.ip} is not in the list; saving would lock you out.` });
    }
    if (errors.length) throw new ApiError(400, 'INVALID_INPUT', errors[0].message, { fields: errors });

    const { rows: savedRows } = await this.db.query<{ key: string }>('SELECT key FROM ecr.system_config');
    const saved = new Set(savedRows.map((r) => r.key));
    const changed = SETTINGS.filter((s) => changes[s.key] === null
      ? saved.has(s.key)
      : changes[s.key] !== undefined && JSON.stringify(next[s.key]) !== JSON.stringify(this.config[s.key]));
    if (changed.length) {
      await this.db.tx(async (c) => {
        // One change at a time, so two Super Admins saving together cannot interleave.
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('ecr.system_config', 0))`);
        for (const s of changed) {
          if (changes[s.key] === null) await c.query('DELETE FROM ecr.system_config WHERE key = $1', [s.key]);
          else {
            await c.query(
              `INSERT INTO ecr.system_config (key, value, updated_by) VALUES ($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
              [s.key, JSON.stringify(next[s.key]), actor.id],
            );
          }
        }
        const sessions = await this.reEvaluateSessions(c, next);
        await this.audit.record(c, {
          action: 'CONFIG_CHANGED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
          entityType: 'SYSTEM_CONFIG', entityId: changed.map((s) => s.key).join(','), reason,
          before: Object.fromEntries(changed.map((s) => [s.key, this.config[s.key]])),
          after: { ...Object.fromEntries(changed.map((s) => [s.key, changes[s.key] === null ? { default: next[s.key] } : next[s.key]])), sessions },
        });
      });
      for (const s of SETTINGS) this.set(s.key, next[s.key]);
    }
    return { ...(await this.list()), changed: changed.map((s) => s.key) };
  }

  /** US-52-P1 AC1 "takes effect immediately": open sessions get the new idle and absolute limits and the session cap. */
  private async reEvaluateSessions(c: PoolClient, next: Record<SettingKey, SettingValue>) {
    const idle = await c.query(
      `UPDATE ecr.user_session s
          SET idle_timeout_minutes = CASE WHEN EXISTS (
                SELECT 1 FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
                 WHERE ur.user_id = s.user_id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND r.is_privileged)
              THEN $1::int ELSE $2::int END,
              absolute_expires_at = s.created_at + make_interval(hours => $3::int)
        WHERE s.revoked_at IS NULL
          AND (s.idle_timeout_minutes IS DISTINCT FROM CASE WHEN EXISTS (
                SELECT 1 FROM ecr.user_role ur JOIN ecr.role r ON r.id = ur.role_id
                 WHERE ur.user_id = s.user_id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND r.is_privileged)
              THEN $1::int ELSE $2::int END
            OR s.absolute_expires_at IS DISTINCT FROM s.created_at + make_interval(hours => $3::int))`,
      [next.privilegedIdleMinutes, next.sessionIdleMinutes, next.sessionAbsoluteHours],
    );
    const capped = await c.query(
      `UPDATE ecr.user_session SET revoked_at = now(), revoke_reason = 'SESSION_LIMIT'
        WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS n
                                       FROM ecr.user_session WHERE revoked_at IS NULL) x WHERE x.n > $1)`,
      [next.maxSessionsPerUser],
    );
    return { updated: idle.rowCount ?? 0, endedBeyondLimit: capped.rowCount ?? 0 };
  }

  // ------------------------------------------------------------------ rules

  /** US-52-N1: every value within its range, privileged idle at most the general one, no privileged default role. */
  private check(v: Record<SettingKey, SettingValue>, roles: { code: string; is_privileged: boolean }[]): FieldError[] {
    const errors: FieldError[] = [];
    for (const s of SETTINGS) {
      const value = v[s.key];
      const fail = (message: string) => errors.push({ field: s.key, message: `${s.label}: ${message}` });
      if (s.kind === 'integer') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < s.min || value > s.max) {
          fail(`must be a whole number from ${s.min} to ${s.max} ${s.unit}.`);
        }
      } else if (s.kind === 'text') {
        if (typeof value !== 'string' || value.length < s.min || value.length > s.max) fail(`must be ${s.min} to ${s.max} characters.`);
      } else if (s.kind === 'networks') {
        if (!Array.isArray(value) || value.length < s.min || value.length > s.max) fail(`must list ${s.min} to ${s.max} addresses or ranges.`);
        else {
          const bad = value.filter((n) => typeof n !== 'string' || !CIDR(n));
          if (bad.length) fail(`not an address or CIDR range: ${bad.join(', ')}.`);
          else if (value.some((n) => /^(0\.0\.0\.0|::)\/0$/.test(n as string))) fail('a range covering every address is not a restriction.');
        }
      } else if (s.kind === 'roles') {
        if (!Array.isArray(value) || value.length > s.max) fail(`at most ${s.max} roles.`);
        else {
          const unknown = value.filter((r) => !roles.some((x) => x.code === r));
          const privileged = value.filter((r) => roles.some((x) => x.code === r && x.is_privileged));
          if (unknown.length) fail(`unknown role ${unknown.join(', ')}.`);
          else if (privileged.length) fail(`${privileged.join(', ')} is a privileged role and cannot be given at first sign-in (US-52-N1 AC2).`);
        }
      }
    }
    if (!errors.some((e) => e.field === 'privilegedIdleMinutes' || e.field === 'sessionIdleMinutes') &&
      (v.privilegedIdleMinutes as number) > (v.sessionIdleMinutes as number)) {
      errors.push({ field: 'privilegedIdleMinutes', message: 'Idle timeout for privileged roles: must not be longer than the general idle timeout.' });
    }
    return errors;
  }

  private async roles() {
    const { rows } = await this.db.query<{ code: string; name: string; is_privileged: boolean }>('SELECT code, name, is_privileged FROM ecr.role ORDER BY is_privileged, code');
    return rows;
  }
}

/** Accepts what a form sends: numbers as text, a role list, networks as lines or a list. */
function normalise(s: SettingDef, v: SettingValue): SettingValue {
  if (s.kind === 'integer' && typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  if (s.kind === 'networks' && typeof v === 'string') return v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  if (s.kind === 'networks' && Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '');
  if (s.kind === 'roles' && Array.isArray(v)) return [...new Set(v.map((x) => (typeof x === 'string' ? x.trim().toUpperCase() : x)))];
  if (s.kind === 'text' && typeof v === 'string') return v.trim();
  return v;
}
