import { clientIp } from '../common/http';
import type { AuthorizedRequest } from './authorize';

/** The signed-in person performing an action, with what the audit trail needs about the request. */
export interface Actor {
  id: string;
  permissions: Set<string>;
  sessionId: string;
  ip: string;
  userAgent?: string;
}

export function actorOf(req: AuthorizedRequest): Actor {
  return {
    id: req.ecr!.user.id,
    permissions: req.access!.permissions,
    sessionId: req.ecr!.session.id,
    ip: clientIp(req),
    userAgent: req.get('user-agent'),
  };
}
