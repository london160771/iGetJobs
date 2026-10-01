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

export type AuditChanges = Awaited<ReturnType<typeof auditLead>>;
export interface AuditRepository { findById(id: string): Promise<Lead | null>; saveAudit(lead: Lead, changes: AuditChanges): Promise<Lead> }
export class SupabaseAuditRepository implements AuditRepository {
  constructor(private client: SupabaseClient, private ownerId: string) {}
  findById(id: string) { return new SupabaseLeadRepository(this.client, this.ownerId).findById(id); }
  async saveAudit(lead: Lead, changes: AuditChanges) {
    const response = await this.client.from('leads').update({ audit: changes.audit, classification: changes.classification, score: changes.score, score_reasons: changes.scoreReasons })
      .eq('owner_id', this.ownerId).eq('id', lead.id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (response.error) throw new RequestError(503, 'Audit results could not be saved. Please try again.');
    if (!response.data) throw new RequestError(409, 'Lead evidence changed during this audit. Reload before auditing again.');
    return leadFromRow(response.data);
  }
}
export class AuditService {
  private busy = new Set<string>();
  private lastRun = new Map<string, number>();
  constructor(private repository: (ownerId: string, token: string) => AuditRepository, readonly scoring: ScoringConfig, private fetcher = fetchWebsite) {}
  async detail(ownerId: string, token: string, id: string): Promise<AuditDetail> {
    const lead = await this.repository(ownerId, token).findById(id);
    if (!lead) throw new RequestError(404, 'Lead not found.');
    return { lead, resolution: resolveWebsiteEvidence(lead), scoring: this.scoring };
  }
  async run(ownerId: string, token: string, id: string, input: Record<string, unknown>) {
    if (this.busy.has(ownerId) || this.busy.size >= 2) throw new RequestError(429, 'Another website audit is running. Please wait.');
    if (Date.now() - (this.lastRun.get(ownerId) || 0) < 5000) throw new RequestError(429, 'Wait five seconds before another website audit.');
    if (Object.keys(input).some(key => key !== 'website')) throw new RequestError(400, 'Only a website evidence choice is accepted.');
    this.busy.add(ownerId);
    try {
      const repository = this.repository(ownerId, token);
      const lead = await repository.findById(id);
      if (!lead) throw new RequestError(404, 'Lead not found.');
      // Validate evidence before charging/cooling down or opening a connection.
      chooseWebsite(resolveWebsiteEvidence(lead), input.website);
      this.lastRun.set(ownerId, Date.now());
      if (this.lastRun.size > 1000) this.lastRun.delete(this.lastRun.keys().next().value!);
      const changes = await auditLead(lead, input.website, this.scoring, this.fetcher);
      return await repository.saveAudit(lead, changes);
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
