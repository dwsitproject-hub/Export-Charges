import type { Actor } from '../auth/actor';

/**
 * The account ECR's own changes are recorded under (migration 0017): values it publishes by itself and drafts it
 * prepares for a Checker. It is deactivated and has no DWS Hub identity, so nobody can sign in as it — and because it
 * is the creator of those change sets, any Checker may review them (SoD-1).
 */
export const AUTO_UPDATE_USER_ID = '00000000-0000-0000-0000-00000000ec01';

export const AUTO_UPDATE_ACTOR: Actor = {
  id: AUTO_UPDATE_USER_ID,
  permissions: new Set(),
  sessionId: '00000000-0000-0000-0000-000000000000',
  ip: '127.0.0.1',
  userAgent: 'ecr-auto-update/1.0',
};
