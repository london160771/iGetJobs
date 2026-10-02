import { randomUUID } from 'node:crypto';
import { usageFile } from '../production.js';
import { supabaseUsageStore } from '../quota.js';
import { leadLabelMaxLength, normalizedLeadLabel, validLeadLabel, type DiscoveryPreview, type Lead, type SaveResult, type SaveSelection } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabase } from '../supabase.js';
import { readServerEnv } from '../env.js';
import { discoveryOptions, validateQuery } from './config.js';
import { normalizeLead } from './normalize.js';
import { duplicateCheck, type LeadIdentity } from './dedupe.js';
import { SupabaseLeadRepository, type LeadRepository } from './repository.js';
import { ProviderGuard, fileUsageStore } from './usage.js';
import { CsvAdapter } from './adapters/csv.js';
import { OsmAdapter, osmEndpoints } from './adapters/osm.js';
import { SerpApiAdapter } from './adapters/serpapi.js';
import type { Collection, SourceAdapter } from './adapters/types.js';
import { RequestError } from './errors.js';

interface StoredPreview { ownerId: string; preview: DiscoveryPreview; bytes: number; completed: Map<string, SaveResult['results'][number]> }
export class DiscoveryService {
  readonly options;
  private previews = new Map<string, StoredPreview>();
  private saving = new Set<string>();
  private adapters: Record<'OSM' | 'SERPAPI', SourceAdapter>;
  constructor(env: NodeJS.ProcessEnv, private repository: (ownerId: string, token: string) => LeadRepository, private guard: ProviderGuard, adapters?: Record<'OSM' | 'SERPAPI', SourceAdapter>) {
    this.options = discoveryOptions(env);
    this.adapters = adapters || {
      OSM: new OsmAdapter(this.options.niches, fetch, osmEndpoints(env), { reserveRetry: () => guard.reserveOsmRetry() }),
      SERPAPI: new SerpApiAdapter(env.SERPAPI_API_KEY?.trim() || null, this.options.niches)
    };
  }
  async search(ownerId: string, token: string, input: Record<string, unknown>) {
    if (input.source !== 'OSM' && input.source !== 'SERPAPI') throw new RequestError(400, 'Choose a supported discovery source.');
    const source = input.source;
    if (!this.options.config.sources.find(item => item.id === source)?.available) throw new RequestError(503, 'This discovery source is not configured. Choose OpenStreetMap or CSV import.');
    const query = validateQuery(input, this.options.config);
    const key = JSON.stringify([source, query.country, query.city.toLowerCase(), query.niche]);
    const result = await this.guard.run(source, key, () => this.adapters[source].collect(query));
    return await this.preview(ownerId, token, source, result.value, result.cached);
  }
  async importCsv(ownerId: string, token: string, input: Record<string, unknown>) {
    if (typeof input.csv !== 'string') throw new RequestError(400, 'CSV text is required.');
    const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
    if (country && !this.options.config.markets.some(item => item.code === country)) throw new RequestError(400, 'Choose a configured country.');
    const niche = this.options.niches.find(item => item.id === input.niche)?.label || '';
    if (!validLeadLabel(input.city)) throw new RequestError(400, `City must not exceed ${leadLabelMaxLength} characters.`);
    const collection = new CsvAdapter().collect(input.csv, typeof input.filename === 'string' ? input.filename : 'import.csv', { country, city: normalizedLeadLabel(input.city) || '', niche });
    return await this.preview(ownerId, token, 'CSV', collection, false);
  }
  private async preview(ownerId: string, token: string, source: Lead['source'], collection: Collection, cached: boolean) {
    const existing = await this.repository(ownerId, token).identities();
    const persisted = new Set(existing.map(item => item.id));
    const candidates: LeadIdentity[] = [...existing];
    const preview: DiscoveryPreview = { id: randomUUID(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), rows: [], warnings: [...collection.warnings], attribution: collection.attribution, cached };
    collection.records.forEach((record, index) => {
      try {
        if (Buffer.byteLength(JSON.stringify(record.metadata)) > 32 * 1024) throw new RequestError(400, 'Source metadata exceeds 32KB; record was not imported.');
        const { lead, warnings } = normalizeLead(record, source);
        preview.rows.push({ lead, warnings, duplicate: duplicateCheck(lead, candidates, persisted) });
        candidates.push(lead);
      } catch (error) {
        preview.warnings.push(`Source row ${index + 1}: ${error instanceof RequestError ? error.message : 'Record could not be normalized.'}`);
      }
    });
    for (const [id, item] of this.previews) if (Date.parse(item.preview.expiresAt) <= Date.now()) this.previews.delete(id);
    const own = [...this.previews.entries()].filter(([, item]) => item.ownerId === ownerId);
    if (own.length >= 5) this.previews.delete(own[0]![0]);
    const bytes = Buffer.byteLength(JSON.stringify(preview));
    let total = [...this.previews.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.previews.size && (total + bytes > 16 * 1024 * 1024 || this.previews.size >= 100)) {
      const id = this.previews.keys().next().value!; total -= this.previews.get(id)!.bytes; this.previews.delete(id);
    }
    this.previews.set(preview.id, { ownerId, preview, bytes, completed: new Map() });
    return preview;
  }
  async save(ownerId: string, token: string, input: Record<string, unknown>): Promise<SaveResult> {
    const stored = typeof input.previewId === 'string' ? this.previews.get(input.previewId) : undefined;
    if (!stored || stored.ownerId !== ownerId || Date.parse(stored.preview.expiresAt) <= Date.now()) throw new RequestError(410, 'This preview is unavailable or expired. Run the search or import again.');
    if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 50) throw new RequestError(400, 'Select 1–50 results to save at a time.');
    const selections = input.selections as SaveSelection[];
    if (selections.some(item => !item || typeof item.id !== 'string' || !['save', 'link', 'separate'].includes(item.action) || !stored.preview.rows.some(row => row.lead.id === item.id))
      || new Set(selections.map(item => item.id)).size !== selections.length) throw new RequestError(400, 'Invalid preview selection.');
    if (this.saving.has(ownerId)) throw new RequestError(409, 'Another save is running. Please wait for it to finish.');
    this.saving.add(ownerId);
    try {
      const repository = this.repository(ownerId, token);
      const existing = await repository.identities();
      const results: SaveResult['results'] = [];
      for (const selection of selections) {
        const completed = stored.completed.get(selection.id);
        if (completed) { results.push(completed); continue; }
        const lead = stored.preview.rows.find(row => row.lead.id === selection.id)!.lead;
        const duplicate = duplicateCheck(lead, existing);
        try {
          // A previous insert may have committed even if its response was lost.
          // The ID is server-created in this owner-bound preview, never browser supplied.
          const persisted = selection.action !== 'link' ? await repository.findById(lead.id) : null;
          if (persisted) {
            const result = { rowId: lead.id, status: 'saved' as const, leadId: persisted.id };
            stored.completed.set(lead.id, result);
            results.push(result);
            if (!existing.some(item => item.id === persisted.id)) existing.push(persisted);
            continue;
          }
          if (selection.action === 'save' && duplicate.kind !== 'new') throw new RequestError(409, 'A matching lead now exists. Refresh the preview and review this duplicate.');
          if (selection.action === 'link' && !duplicate.canLink) throw new RequestError(409, 'Source metadata can only be added to one exact saved match. Refresh the preview.');
          const saved = selection.action === 'link' ? await repository.link(duplicate.matchIds[0]!, lead.provenance) : await repository.insert(lead);
          const result = { rowId: lead.id, status: selection.action === 'link' ? 'linked' as const : 'saved' as const, leadId: saved.id };
          stored.completed.set(lead.id, result);
          results.push(result);
          if (selection.action !== 'link') existing.push(saved);
        } catch (error) { results.push({ rowId: lead.id, status: 'failed', error: error instanceof RequestError ? error.message : 'This lead could not be saved. Please retry.' }); }
      }
      return { results };
    } finally { this.saving.delete(ownerId); }
  }
  async list(ownerId: string, token: string) { return await this.repository(ownerId, token).list(); }
}
export function createDiscoveryService(env: NodeJS.ProcessEnv) {
  const serverEnv = readServerEnv(env);
  const limit = Number(env.SERPAPI_MONTHLY_LIMIT || '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('SERPAPI_MONTHLY_LIMIT must be an integer between 1 and 1000.');
  const guard = new ProviderGuard(env.NODE_ENV === 'production' || env.SUPABASE_QUOTA_SERVICE_KEY ? supabaseUsageStore(env) : fileUsageStore(usageFile(env, 'provider')), limit);
  return new DiscoveryService(env, (ownerId, token) => {
    const client: SupabaseClient | null = createServerSupabase(serverEnv, token);
    if (!client) throw new RequestError(503, 'Supabase is not configured.');
    return new SupabaseLeadRepository(client, ownerId);
  }, guard);
}
