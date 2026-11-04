import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { decrypt, encrypt, pkceChallenge, randomToken, safeEqual, sha256 } from '../common/crypto';
import { clientIp } from '../common/http';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { cookieNames, loginCookieClearOptions, loginCookieOptions, sessionCookieOptions } from './cookies';
import { OidcService } from './oidc.service';
import { assertCsrf, EcrRequest, SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { UserBindingService } from './user-binding.service';

interface LoginStateRow {
  browser_binding_hash: Buffer;
  nonce: string;
  code_verifier_enc: Buffer;
  return_to: string;
  fresh: boolean;
}

export interface LogoutResponse {
  loggedOut: true;
  /** CURRENT = this browser's session, ALL = every session of the user, NONE = there was no session. */
  scope: 'CURRENT' | 'ALL' | 'NONE';
  revokedSessions: number;
  /** DWS Hub has no end-session endpoint (Technical Design T-05), so the Hub session stays active. */
  hubSessionEnded: false;
  hubDashboardUrl: string;
  message: string;
}

/** Relative in-app path only; anything else becomes "/" (open-redirect protection, US-05-N4). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (value.length > 512 || /[\u0000-\u001f]/.test(value)) return '/';
  return value;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
    private readonly binding: UserBindingService,
    private readonly audit: AuditService,
    private readonly totp: TotpService,
  ) {}

  /** SF-1.1 step 1: start DWS Hub sign-in with PKCE. Also the launch URL to register in DWS Hub (T-03). */
  @Get('login')
  async login(@Query('returnTo') returnTo: unknown, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken(48);
      const browserBinding = randomToken();
      const url = await this.oidc.authorizeUrl({ state, nonce, codeChallenge: pkceChallenge(verifier) });

      await this.db.query(
        `INSERT INTO ecr.oidc_login_state
           (state_hash, browser_binding_hash, nonce, code_verifier_enc, return_to, purpose, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'LOGIN', now() + make_interval(mins => $6))`,
        [sha256(state), sha256(browserBinding), nonce, encrypt(this.config.encryptionKey, verifier),
          safeReturnTo(returnTo), this.config.loginStateMinutes],
      );
      res.cookie(cookieNames(this.config).login, browserBinding, loginCookieOptions(this.config));
      res.redirect(302, url);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'INTERNAL';
      if (!(err instanceof ApiError)) this.logger.error(err);
      res.redirect(302, `/signin-error?reason=${encodeURIComponent(code)}`);
    }
  }

  /** SF-1.1 steps 2–5: validate state, redeem the code, verify the ID token, bind the user, open a session. */
  @Get('callback')
  async callback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const names = cookieNames(this.config);
    res.clearCookie(names.login, loginCookieClearOptions(this.config));
    const ctx = { ip: clientIp(req), userAgent: req.get('user-agent') };

    try {
      if (typeof q.error === 'string') {
        throw new ApiError(401, 'LOGIN_HUB_ERROR', 'DWS Hub did not complete sign-in.', { hubError: q.error.slice(0, 100) });
      }
      if (typeof q.state !== 'string' || typeof q.code !== 'string') {
        throw new ApiError(400, 'LOGIN_STATE_INVALID', 'Sign-in expired, please try again.');
      }

      // Single use: the row is deleted whether or not the rest succeeds.
      const { rows } = await this.db.query<LoginStateRow>(
        `DELETE FROM ecr.oidc_login_state WHERE state_hash = $1
         RETURNING browser_binding_hash, nonce, code_verifier_enc, return_to, expires_at > now() AS fresh`,
        [sha256(q.state)],
      );
      const st = rows[0];
      const browserBinding = req.cookies?.[names.login];
      if (!st || !st.fresh || typeof browserBinding !== 'string' || !safeEqual(sha256(browserBinding), st.browser_binding_hash)) {
        throw new ApiError(400, 'LOGIN_STATE_INVALID', 'Sign-in expired, please try again.');
      }

      const idToken = await this.oidc.exchangeCode(q.code, decrypt(this.config.encryptionKey, st.code_verifier_enc));
      const claims = await this.oidc.verifyIdToken(idToken, st.nonce);
      const { issuer } = await this.oidc.getDiscovery();

      const { token } = await this.db.tx(async (client) => {
        const user = await this.binding.bind(client, claims, issuer, ctx);
        const created = await this.sessions.create(client, {
          userId: user.id,
          authMethod: 'DWS_HUB',
          idTokenHash: sha256(idToken),
          ...ctx,
        });
        await this.audit.record(client, {
          action: 'LOGIN_SUCCESS',
          actorKind: 'USER',
          actorUserId: user.id,
          sessionId: created.session.id,
          ...ctx,
          entityType: 'USER_SESSION',
          entityId: created.session.id,
          after: { provider: 'DWS_HUB', hubSubject: claims.sub, provisioned: user.provisioned },
        });
        return created;
      });

      res.cookie(names.session, token, sessionCookieOptions(this.config));
      res.redirect(302, st.return_to);
    } catch (err) {
      await this.failSignIn(err, ctx, res);
    }
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Req() req: EcrRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { session, user } = req.ecr!;
    const { roles, permissions, privileged } = await this.sessions.access(user.id);
    const { enrolled } = await this.totp.status(this.db.pool, user.id);
    // The DWS Hub user id (OIDC `sub`) for this Hub, which the web app reports to the Hub SDK (DwsHub.identify).
    const { rows: [hub] } = await this.db.query<{ subject: string }>(
      `SELECT subject FROM ecr.user_identity WHERE user_id = $1 AND provider = 'DWS_HUB' AND issuer = $2 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [user.id, this.config.hubIssuer],
    );
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name, roles, permissions, privileged, hubSubject: hub?.subject ?? null },
      totp: { enrolled, enrollmentRequired: privileged && !enrolled },
      session: {
        id: session.id,
        authMethod: session.auth_method,
        createdAt: session.created_at,
        absoluteExpiresAt: session.absolute_expires_at,
        idleTimeoutMinutes: session.idle_timeout_minutes,
        steppedUpAt: session.stepped_up_at,
      },
      csrfToken: session.csrf_token,
      hubDashboardUrl: this.config.hubDashboardUrl,
    };
  }

  /**
   * Ends the ECR session (Technical Design §4.1.4, US-09-P2). Idempotent: with no session it still
   * clears cookies and returns 200. A live session requires the CSRF token; `{"allSessions": true}`
   * signs the user out of every browser. DWS Hub offers no end-session endpoint, so the response
   * points the user to the Hub dashboard instead.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Body() body: { allSessions?: unknown } | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    res.setHeader('Cache-Control', 'no-store');
    const names = cookieNames(this.config);
    const found = await this.sessions.lookup(req.cookies?.[names.session]);

    let scope: LogoutResponse['scope'] = 'NONE';
    let revokedSessions = 0;

    if (found) {
      const live = !found.expired;
      // A live session can still act, so ending it must be a deliberate same-site request.
      if (live) assertCsrf(req, found.session.csrf_token);
      const all = live && body?.allSessions === true;
      scope = all ? 'ALL' : 'CURRENT';
      const ctx = { ip: clientIp(req), userAgent: req.get('user-agent') };

      revokedSessions = await this.db.tx(async (client) => {
        const n = all
          ? await this.sessions.revokeAllForUser(client, found.user.id, 'LOGOUT_ALL')
          : await this.sessions.revoke(client, found.session.id, live ? 'LOGOUT' : 'EXPIRED');
        await this.audit.record(client, {
          action: all ? 'LOGOUT_ALL' : 'LOGOUT',
          actorKind: 'USER',
          actorUserId: found.user.id,
          sessionId: found.session.id,
          ...ctx,
          entityType: 'USER_SESSION',
          entityId: found.session.id,
          after: { revokedSessions: n, sessionWasExpired: !live },
        });
        return n;
      });
    }

    res.setHeader('Clear-Site-Data', '"cache", "storage"');
    res.clearCookie(names.session, sessionCookieOptions(this.config));
    res.clearCookie(names.login, loginCookieClearOptions(this.config));

    return {
      loggedOut: true,
      scope,
      revokedSessions,
      hubSessionEnded: false,
      hubDashboardUrl: this.config.hubDashboardUrl,
      message:
        'You are signed out of ECR. Your DWS Hub session is still active; sign out of DWS Hub too if this is a shared computer.',
    };
  }

  private async failSignIn(err: unknown, ctx: { ip: string; userAgent?: string }, res: Response): Promise<void> {
    const code = err instanceof ApiError ? err.code : 'INTERNAL';
    if (!(err instanceof ApiError)) this.logger.error(err);
    try {
      await this.audit.record(this.db.pool, {
        action: code === 'INTERNAL' ? 'LOGIN_ERROR' : code,
        actorKind: 'ANONYMOUS',
        actorUserId: err instanceof ApiError && typeof err.details?.userId === 'string' ? err.details.userId : null,
        ...ctx,
        after: err instanceof ApiError ? (err.details ?? null) : null,
      });
    } catch (auditErr) {
      this.logger.error(auditErr);
    }
    res.redirect(302, `/signin-error?reason=${encodeURIComponent(code)}`);
  }
}
