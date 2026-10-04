import type { Lead, AuditDetail, ScoringConfig } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseLeadRepository, leadFromRow } from '../discovery/repository.js';
import { RequestError } from '../discovery/errors.js';
import { resolveWebsiteEvidence } from '../website-safety.js';
import { createServerSupabase } from '../supabase.js';
import { readServerEnv } from '../env.js';
import { auditLead, chooseWebsite } from './engine.js';
import { readScoring } from './policy.js';
import { fetchWebsite } from './fetcher.js';
import { AuditManualReviewError } from './manual-review.js';

export type AuditChanges = Awaited<ReturnType<typeof auditLead>>;
export interface AuditRepository {
  findById(id: string): Promise<Lead | null>;
  saveAudit(lead: Lead, changes: AuditChanges): Promise<Lead>;
  saveManualReview(lead: Lead, attempt: { reason: NonNullable<Lead['auditAttemptReason']>; attemptedAt: string; detail: NonNullable<Lead['auditAttemptDetail']> | null }): Promise<Lead>;
}
export class SupabaseAuditRepository implements AuditRepository {
  constructor(private client: SupabaseClient, private ownerId: string) {}
  findById(id: string) { return new SupabaseLeadRepository(this.client, this.ownerId).findById(id); }
  async saveAudit(lead: Lead, changes: AuditChanges) {
    const response = await this.client.from('leads').update({ audit: changes.audit, classification: changes.classification, score: changes.score, score_reasons: changes.scoreReasons,
      audit_attempt_status: changes.auditAttemptStatus, audit_attempt_reason: changes.auditAttemptReason, audit_attempted_at: changes.auditAttemptedAt, audit_attempt_detail: changes.auditAttemptDetail })
      .eq('owner_id', this.ownerId).eq('id', lead.id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (response.error) throw new RequestError(503, 'Audit results could not be saved. Please try again.');
    if (!response.data) throw new RequestError(409, 'Lead evidence changed during this audit. Reload before auditing again.');
    return leadFromRow(response.data);
  }
  async saveManualReview(lead: Lead, attempt: { reason: NonNullable<Lead['auditAttemptReason']>; attemptedAt: string; detail: NonNullable<Lead['auditAttemptDetail']> | null }) {
    // Preserve any earlier valid audit/classification/score. Only record that
    // this newer attempt could not establish a reliable result.
    const response = await this.client.from('leads').update({ audit_attempt_status: 'NEEDS_MANUAL_REVIEW', audit_attempt_reason: attempt.reason,
      audit_attempted_at: attempt.attemptedAt, audit_attempt_detail: attempt.detail })
      .eq('owner_id', this.ownerId).eq('id', lead.id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (response.error) throw new RequestError(503, 'The audit attempt could not be saved. Please try again.');
    if (!response.data) throw new RequestError(409, 'Lead evidence changed during this audit. Reload before auditing again.');
    return leadFromRow(response.data);
  }
}
export class AuditService {
  private busy = new Set<string>();
  private lastRun = new Map<string, number>();
  constructor(private repository: (ownerId: string, token: string) => AuditRepository, readonly scoring: ScoringConfig, private fetcher = fetchWebsite, private clock = () => new Date()) {}
  async detail(ownerId: string, token: string, id: string): Promise<AuditDetail> {
    const lead = await this.repository(ownerId, token).findById(id);
    if (!lead) throw new RequestError(404, 'Lead not found.');
    return { lead, resolution: resolveWebsiteEvidence(lead), scoring: this.scoring };
  }
  async run(ownerId: string, token: string, id: string, input: Record<string, unknown>) {
    if (this.busy.has(ownerId) || this.busy.size >= 2) throw new RequestError(429, 'Another website audit is running. Please wait.');
    if (this.clock().getTime() - (this.lastRun.get(ownerId) || 0) < 5000) throw new RequestError(429, 'Wait five seconds before another website audit.');
    if (Object.keys(input).some(key => key !== 'website')) throw new RequestError(400, 'Only a website evidence choice is accepted.');
    this.busy.add(ownerId);
    try {
      const repository = this.repository(ownerId, token);
      const lead = await repository.findById(id);
      if (!lead) throw new RequestError(404, 'Lead not found.');
      // Validate evidence before charging/cooling down or opening a connection.
      chooseWebsite(resolveWebsiteEvidence(lead), input.website);
      this.lastRun.set(ownerId, this.clock().getTime());
      if (this.lastRun.size > 1000) this.lastRun.delete(this.lastRun.keys().next().value!);
      try {
        const changes = await auditLead(lead, input.website, this.scoring, this.fetcher, () => this.clock().toISOString());
        return await repository.saveAudit(lead, changes);
      } catch (error) {
        if (!(error instanceof AuditManualReviewError)) throw error;
        return await repository.saveManualReview(lead, { reason: error.reason, attemptedAt: this.clock().toISOString(), detail: error.detail });
      }
    } finally { this.busy.delete(ownerId); }
  }
}
export function createAuditService(env: NodeJS.ProcessEnv) {
  const settings = readServerEnv(env);
  return new AuditService((ownerId, token) => {
    const client = createServerSupabase(settings, token);
    if (!client) throw new RequestError(503, 'Supabase is not configured.');
    return new SupabaseAuditRepository(client, ownerId);
  }, readScoring(env));
}
