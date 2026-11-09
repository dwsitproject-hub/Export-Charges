import { ApiError } from '../common/api-error';
import type { ChangeSetsService } from '../registry/change-sets.service';
import { AUTO_UPDATE_ACTOR } from './system-account';

/** Reads an official URL; null when it could not be read (the caller tries again on the next run). */
export type Reader = (url: string) => Promise<Buffer | null>;

export type Outcome = 'PUBLISHED' | 'SENT_TO_CHECKER' | 'ALREADY_PUBLISHED' | 'OLDER_PERIOD' | 'NOT_RELEVANT' | 'NEEDS_REVIEW';

export interface DraftOutcome {
  decree: string;
  outcome: Outcome;
  detail?: string;
  version?: number;
  changeSetId?: string;
}

/**
 * Submits a change set ECR drafted, which notifies the Checkers. Returns null when it is now waiting for review, or
 * the reasons it could not be submitted (it then stays a draft for a Maker to correct).
 */
export async function submitForChecker(sets: ChangeSetsService, setId: string): Promise<string | null> {
  try {
    await sets.submit(AUTO_UPDATE_ACTOR, setId, { acknowledgeWarnings: true });
    return null;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const findings = ((err.details?.findings ?? []) as { severity: string; message: string }[]).filter((f) => f.severity === 'ERROR').map((f) => f.message);
    return findings.slice(0, 5).join('; ') || err.message;
  }
}
