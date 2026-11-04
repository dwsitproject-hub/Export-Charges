import { applyDecorators, CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { clientIp } from '../common/http';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { EcrRequest, SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

export const AUTHZ_RULE = 'ecr:authz-rule';

export interface AuthzRule {
  /** Every listed permission is required (deny by default). */
  permissions?: string[];
  /** Sensitive action: a TOTP step-up within the last few minutes is required (Technical Design §4.1.6). */
  stepUp?: boolean;
}

export interface AccessInfo {
  roles: string[];
  permissions: Set<string>;
  privileged: boolean;
}

export interface AuthorizedRequest extends EcrRequest {
  access?: AccessInfo;
}

/** Session + permission + step-up check for one route (Technical Design §4.1.5). */
export const Authorize = (rule: AuthzRule = {}) => applyDecorators(SetMetadata(AUTHZ_RULE, rule), UseGuards(SessionGuard, AuthzGuard));

@Injectable()
export class AuthzGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly totp: TotpService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AuthzRule>(AUTHZ_RULE, [context.getHandler(), context.getClass()]) ?? {};
    const req = context.switchToHttp().getRequest<AuthorizedRequest>();
    const { session, user } = req.ecr!;

    const access = await this.sessions.access(user.id);
    req.access = { roles: access.roles, permissions: new Set(access.permissions), privileged: access.privileged };

    const missing = (rule.permissions ?? []).filter((p) => !req.access!.permissions.has(p));
    if (missing.length) {
      // Attempts to reach functions outside one's role are recorded (PRD US-11-N2).
      await this.audit.record(this.db.pool, {
        action: 'AUTHZ_DENIED',
        actorKind: 'USER',
        actorUserId: user.id,
        sessionId: session.id,
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
        after: { method: req.method, path: req.path, missing },
      });
      throw new ApiError(403, 'FORBIDDEN', "You don't have access to this function.", { missing });
    }

    // Privileged roles must have an ECR authenticator before using any protected function (PRD US-13-P1 AC2),
    // except roles in TOTP_EXEMPT_ROLES (default Super Admin), which neither enrol nor step up.
    if (access.totpRequired && rule.permissions?.length) {
      const { enrolled } = await this.totp.status(this.db.pool, user.id);
      if (!enrolled) {
        throw new ApiError(403, 'TOTP_ENROLLMENT_REQUIRED', 'Set up an authenticator app to use privileged functions.');
      }
    }

    if (rule.stepUp && access.totpRequired) {
      const windowMs = this.config.stepUpWindowMinutes * 60_000;
      const fresh = session.stepped_up_at && Date.now() - session.stepped_up_at.getTime() < windowMs;
      if (!fresh) {
        const { enrolled } = await this.totp.status(this.db.pool, user.id);
        throw new ApiError(403, 'STEP_UP_REQUIRED', 'Confirm with your authenticator code to continue.', { enrolled });
      }
    }
    return true;
  }
}
