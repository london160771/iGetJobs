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
  insert(lead: Lead): Promise<Lead>;
  link(id: string, provenance: LeadProvenance[]): Promise<Lead>;
}
export class SupabaseLeadRepository implements LeadRepository {
  constructor(private client: SupabaseClient, private ownerId: string) {}
  async identities(): Promise<LeadIdentity[]> {
    const rows: LeadIdentity[] = [];
    for (let offset = 0; offset <= 2000; offset += 200) {
      const result = await this.client.from('leads').select('id,business_name,domain,phone,address,city,country,source,source_id').eq('owner_id', this.ownerId).order('id').range(offset, offset + 199);
      if (result.error) throw new RequestError(503, 'Saved leads could not be checked. Please try again.');
      rows.push(...result.data.map(row => leadFromRow(row) as LeadIdentity));
      if (rows.length > 2000) throw new RequestError(409, 'This workspace exceeds the Phase 1 duplicate-check limit of 2,000 leads.');
      if (result.data.length < 200) break;
    }
    return rows;
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
    const provenance = all.filter(item => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
    if (provenance.length > 100) throw new RequestError(409, 'The saved lead has reached its source-history limit. Save separately after review.');
    const updated = await this.client.from('leads').update({ provenance }).eq('owner_id', this.ownerId).eq('id', id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (updated.error || !updated.data) throw new RequestError(409, 'The saved lead changed. Refresh the preview before adding source metadata.');
    return leadFromRow(updated.data);
  }
}
