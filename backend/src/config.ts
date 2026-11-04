import { resolve } from 'node:path';
import { databaseUrl } from './db/database-url';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Origin users open in the browser; the OIDC redirect URI is derived from it. */
  publicBaseUrl: string;
  hubIssuer: string;
  hubDiscoveryUrl: string;
  oidcClientId: string;
  hubDashboardUrl: string;
  hubTimeoutMs: number;
  cookieSecure: boolean;
  /** 32-byte key for AES-256-GCM field encryption (PKCE verifiers, TOTP seeds). From KMS outside development. */
  encryptionKey: Buffer;
  allowedNetworks: string[];
  trustProxy: number;
  loginStateMinutes: number;
  sessionAbsoluteHours: number;
  sessionIdleMinutes: number;
  privilegedIdleMinutes: number;
  maxSessionsPerUser: number;
  /** Roles given to an account created just-in-time on first DWS Hub sign-in (may be empty). */
  jitDefaultRoles: string[];
  /** How long a TOTP step-up stays valid for sensitive actions (Technical Design §4.1.6). */
  /** Roles that never need the ECR authenticator (enrolment or step-up), even though privileged. */
  totpExemptRoles: string[];
  stepUpWindowMinutes: number;
  totpIssuer: string;
  /** Directory standing in for the OSS bucket of source documents (local development and tests). */
  storageDir: string;
  /** ClamAV daemon for upload scanning; required when malwareScanRequired (UAT and production). */
  clamdHost: string | null;
  clamdPort: number;
  malwareScanRequired: boolean;
  /** How often the publish-due job looks for scheduled change sets; 0 disables it (tests call it directly). */
  publishDueIntervalMs: number;
  /**
   * How notification emails leave ECR: corporate SMTP in UAT and production; `log` writes them to the application log
   * (local development); `memory` keeps them for tests.
   */
  mailTransport: 'smtp' | 'log' | 'memory';
  smtp: { host: string; port: number; secure: boolean; requireTls: boolean; user: string | null; password: string | null } | null;
  mailFrom: string;
  /** How often the email-outbox job sends pending emails; 0 disables it (tests call it directly). */
  emailOutboxIntervalMs: number;
  /** Catalogue exports above this many rows run as a job (US-47-N1 AC3). */
  exportAsyncThreshold: number;
  /** How often the export job runner looks for queued exports and expired files; 0 disables it. */
  exportJobIntervalMs: number;
  /** How often the scheduler checks which scheduled jobs are due; 0 disables it (tests run jobs directly). */
  schedulerTickMs: number;
  /** Printed on calculations, exports and evidence packs; a Super Admin can change it (F-52). */
  disclaimer: string;
  /** How often each API instance reloads the settings saved on the Configuration screen; 0 disables it. */
  settingsRefreshMs: number;
}

export const DEFAULT_DISCLAIMER =
  'Indicative calculation from the ECR published data version shown. The official amounts are those assessed by ' +
  'Customs (Bea Keluar) and BPDP (Pungutan Ekspor) on the export declaration.';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const encryptionKey = Buffer.from(required(env, 'ECR_ENCRYPTION_KEY'), 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('ECR_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }

  const hubIssuer = stripTrailingSlash(required(env, 'HUB_ISSUER'));
  const cookieSecure = (env.COOKIE_SECURE ?? 'true').toLowerCase() === 'true';
  const publicBaseUrl = stripTrailingSlash(required(env, 'PUBLIC_BASE_URL'));
  if (cookieSecure && !publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be https:// when COOKIE_SECURE=true');
  }

  const clamdHost = env.CLAMD_HOST?.trim() || null;
  const malwareScanRequired = (env.MALWARE_SCAN_REQUIRED ?? String(cookieSecure)).toLowerCase() === 'true';
  if (malwareScanRequired && !clamdHost) {
    throw new Error('CLAMD_HOST is required when MALWARE_SCAN_REQUIRED=true (uploads must be virus-scanned)');
  }

  const mailTransport = (env.MAIL_TRANSPORT?.trim() || (env.SMTP_HOST ? 'smtp' : 'log')) as AppConfig['mailTransport'];
  if (!['smtp', 'log', 'memory'].includes(mailTransport)) throw new Error('MAIL_TRANSPORT must be smtp, log or memory');
  if (mailTransport === 'smtp' && !env.SMTP_HOST?.trim()) throw new Error('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
  if (cookieSecure && mailTransport !== 'smtp') throw new Error('MAIL_TRANSPORT must be smtp when COOKIE_SECURE=true (notifications must reach people)');

  return {
    port: Number(env.PORT ?? 3100),
    databaseUrl: databaseUrl(env),
    publicBaseUrl,
    hubIssuer,
    hubDiscoveryUrl: env.HUB_DISCOVERY_URL?.trim() || `${hubIssuer}/api/sso/.well-known/openid-configuration`,
    oidcClientId: required(env, 'OIDC_CLIENT_ID'),
    hubDashboardUrl: required(env, 'HUB_DASHBOARD_URL'),
    hubTimeoutMs: Number(env.HUB_TIMEOUT_MS ?? 5000),
    cookieSecure,
    encryptionKey,
    allowedNetworks: required(env, 'ALLOWED_NETWORKS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: Number(env.TRUST_PROXY ?? 0),
    loginStateMinutes: 10,
    sessionAbsoluteHours: 8, // BR-IAM-08
    sessionIdleMinutes: 30,
    privilegedIdleMinutes: 15,
    maxSessionsPerUser: 3,
    jitDefaultRoles: (env.JIT_DEFAULT_ROLES ?? 'VIEWER')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    stepUpWindowMinutes: 5,
    // Default: Super Admins sign in through DWS Hub only. Set TOTP_EXEMPT_ROLES= (empty) to require it of every privileged role.
    totpExemptRoles: (env.TOTP_EXEMPT_ROLES ?? 'SUPER_ADMIN')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    totpIssuer: env.TOTP_ISSUER?.trim() || 'ECR',
    storageDir: resolve(env.STORAGE_DIR?.trim() || 'var/storage'),
    clamdHost,
    clamdPort: Number(env.CLAMD_PORT ?? 3310),
    malwareScanRequired,
    publishDueIntervalMs: Number(env.PUBLISH_DUE_INTERVAL_MS ?? 60_000),
    mailTransport,
    smtp: mailTransport === 'smtp'
      ? {
          host: env.SMTP_HOST!.trim(),
          port: Number(env.SMTP_PORT ?? 587),
          // true = TLS from the start (port 465); false = STARTTLS, which is then required.
          secure: (env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
          // Only a relay on the same host or network segment may be used without TLS.
          requireTls: (env.SMTP_REQUIRE_TLS ?? 'true').toLowerCase() !== 'false',
          user: env.SMTP_USER?.trim() || null,
          password: env.SMTP_PASSWORD || null,
        }
      : null,
    mailFrom: env.MAIL_FROM?.trim() || 'ECR <no-reply@ecr.local>',
    emailOutboxIntervalMs: Number(env.EMAIL_OUTBOX_INTERVAL_MS ?? 60_000),
    exportAsyncThreshold: Math.max(0, Number(env.EXPORT_ASYNC_THRESHOLD ?? 50_000)),
    exportJobIntervalMs: Number(env.EXPORT_JOB_INTERVAL_MS ?? 15_000),
    schedulerTickMs: Number(env.SCHEDULER_TICK_MS ?? 60_000),
    disclaimer: DEFAULT_DISCLAIMER,
    settingsRefreshMs: Number(env.SETTINGS_REFRESH_MS ?? 5_000),
  };
}

/** Loads the repository-root .env file when present (local development convenience). */
export function loadDotEnv(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file: rely on the real environment.
  }
}
