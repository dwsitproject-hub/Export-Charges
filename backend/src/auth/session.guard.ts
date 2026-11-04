import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { safeEqual } from '../common/crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { cookieNames } from './cookies';
import { LookedUpSession, SessionService } from './session.service';

export interface EcrRequest extends Request {
  ecr?: LookedUpSession;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Requires a live session; state-changing requests must also carry the session's CSRF token. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<EcrRequest>();
    const found = await this.sessions.requireLive(req.cookies?.[cookieNames(this.config).session]);
    if (!SAFE_METHODS.has(req.method)) assertCsrf(req, found.session.csrf_token);
    req.ecr = found;
    return true;
  }
}

export function assertCsrf(req: Request, expected: string): void {
  const sent = req.get('X-CSRF-Token');
  if (!sent || !safeEqual(sent, expected)) {
    throw new ApiError(403, 'CSRF_INVALID', 'The request could not be verified. Reload the page and try again.');
  }
}
