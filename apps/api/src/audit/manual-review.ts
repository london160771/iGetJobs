import type { AuditAttemptDetail, AuditAttemptReason } from '@igetjobs/shared';

/** Expected bounded/reliability outcomes that need a human inspection rather than a score. */
export class AuditManualReviewError extends Error {
  constructor(readonly reason: AuditAttemptReason, message: string, readonly detail: AuditAttemptDetail | null = null) {
    super(message);
    this.name = 'AuditManualReviewError';
  }
}
