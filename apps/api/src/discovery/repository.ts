import type { Lead, LeadProvenance } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadIdentity } from './dedupe.js';
import { RequestError } from './errors.js';
const snake = (key: string) => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
export function leadToRow(lead: Lead, ownerId: string) {
  return { ...Object.fromEntries(Object.entries(lead).map(([key, value]) => [snake(key), value])), owner_id: ownerId };
}
export function leadFromRow(row: Record<string, unknown>): Lead {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'owner_id').map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value])) as unknown as Lead;
}
export interface LeadRepository {
  identities(): Promise<LeadIdentity[]>;
  list(): Promise<Lead[]>;
  findById(id: string): Promise<Lead | null>;
  insert(lead: Lead): Promise<Lead>;
  link(id: string, provenance: LeadProvenance[]): Promise<Lead>;
}
export class SupabaseLeadRepository implements LeadRepository {
  constructor(private client: SupabaseClient, private ownerId: string) {}
  async findById(id: string) {
    const result = await this.client.from('leads').select('*').eq('owner_id', this.ownerId).eq('id', id).maybeSingle();
    if (result.error) throw new RequestError(503, 'This lead could not be checked. Please retry.');
    return result.data ? leadFromRow(result.data) : null;
  }
  async identities(): Promise<LeadIdentity[]> {
    // One existing stable, security-invoker MVCC snapshot. Inserts after its
    // statement boundary appear next read; they cannot shift a later HTTP page.
    const result = await this.client.rpc('lead_management_snapshot');
    if (result.error || !Array.isArray(result.data)) throw new RequestError(503, 'Saved leads could not be checked. Please try again.');
    if (result.data.length > 2000) throw new RequestError(409, 'This workspace exceeds the duplicate-check limit of 2,000 leads.');
    return result.data.map((row: Record<string, unknown>) => leadFromRow(row) as LeadIdentity);
  }
  async list() {
    const result = await this.client.from('leads').select('*').eq('owner_id', this.ownerId).order('created_at', { ascending: false }).limit(100);
    if (result.error) throw new RequestError(503, 'Saved leads could not be loaded.');
    return result.data.map(row => leadFromRow(row));
  }
  async insert(lead: Lead) {
    const result = await this.client.from('leads').insert(leadToRow(lead, this.ownerId)).select('*').single();
    if (result.error || !result.data) throw new RequestError(503, 'This lead could not be saved. Please retry.');
    return leadFromRow(result.data);
  }
  async link(id: string, additions: LeadProvenance[]) {
    const existing = await this.client.from('leads').select('*').eq('owner_id', this.ownerId).eq('id', id).single();
    if (existing.error || !existing.data) throw new RequestError(409, 'The matching saved lead is no longer available. Refresh the preview.');
    const lead = leadFromRow(existing.data);
    const all = [...lead.provenance, ...additions];
    const seen = new Set<string>();
    const provenance = all.filter(item => { const key = canonicalJson(item); if (seen.has(key)) return false; seen.add(key); return true; });
    if (provenance.length > 100) throw new RequestError(409, 'The saved lead has reached its source-history limit. Save separately after review.');
    // New evidence can invalidate NO_WEBSITE or source-confidence scoring. A repeated
    // identical link retains the audit; genuinely changed history requires a new audit.
    const changed = canonicalJson(provenance) !== canonicalJson(lead.provenance);
    const updated = await this.client.from('leads').update({ provenance, ...(changed ? { audit: null, classification: null, score: null, score_reasons: [] } : {}) }).eq('owner_id', this.ownerId).eq('id', id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (updated.error || !updated.data) throw new RequestError(409, 'The saved lead changed. Refresh the preview before adding source metadata.');
    return leadFromRow(updated.data);
  }
}
// JSONB changes object key order; array order and genuinely different values matter.
function canonicalJson(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}
