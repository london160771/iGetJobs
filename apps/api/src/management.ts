import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifications, dashboardCounts, filterAndSortLeads, leadLabelMaxLength, normalizedLeadLabel, validLeadLabel, leadSorts, leadStatuses, summarizeLead, type Lead, type LeadFilters, type LeadPage, type ManagedLead } from '@igetjobs/shared';
import { RequestError } from './discovery/errors.js';
import { leadFromRow, SupabaseLeadRepository } from './discovery/repository.js';
import { normalizeLead } from './discovery/normalize.js';
import { createServerSupabase } from './supabase.js';
import { readServerEnv } from './env.js';
import { resolveWebsiteEvidence } from './website-safety.js';

const editable = ['businessName', 'niche', 'country', 'city', 'address', 'phone', 'website', 'email', 'rating', 'reviewCount', 'status', 'notes', 'followUpAt'] as const;
const assessmentInputs = ['businessName', 'niche', 'country', 'city', 'address', 'phone', 'website', 'domain', 'email', 'socials', 'rating', 'reviewCount', 'source', 'sourceId', 'provenance'] as const;
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  return new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
};
export function parseLeadFilters(input: Record<string, unknown>): LeadFilters {
  const allowed = ['niche', 'country', 'city', 'classification', 'priority', 'status', 'source', 'hasEmail', 'hasPhone', 'minScore', 'maxScore', 'sort', 'page'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || Object.values(input).some(value => typeof value !== 'string' || value.length > leadLabelMaxLength)) throw new RequestError(400, 'Invalid lead filters.');
  const query: LeadFilters = { sort: 'newest', page: 1 };
  for (const key of ['niche', 'country', 'city', 'classification', 'priority', 'status', 'source', 'hasEmail', 'hasPhone'] as const) if (input[key]) query[key] = (input[key] as string).trim();
  for (const key of ['niche', 'city'] as const) {
    if (!validLeadLabel(input[key])) throw new RequestError(400, `City and niche must not exceed ${leadLabelMaxLength} characters.`);
    if (input[key]) query[key] = normalizedLeadLabel(input[key]) || '';
  }
  for (const [key, values] of Object.entries({ classification: [...classifications, 'UNAUDITED'], priority: ['High', 'Medium', 'Low'], status: leadStatuses, source: ['OSM', 'SERPAPI', 'CSV'], hasEmail: ['yes', 'no'], hasPhone: ['yes', 'no'] })) {
    if (input[key] && !values.includes(input[key] as never)) throw new RequestError(400, 'Invalid lead filters.');
  }
  for (const key of ['minScore', 'maxScore'] as const) if (input[key] !== undefined && input[key] !== '') {
    const value = Number(input[key]);
    if (!/^\d{1,3}$/.test(input[key] as string) || !Number.isInteger(value) || value < 0 || value > 100) throw new RequestError(400, 'Score filters must be between 0 and 100.');
    query[key] = value;
  }
  if (query.minScore !== undefined && query.maxScore !== undefined && query.minScore > query.maxScore) throw new RequestError(400, 'Minimum score must not exceed maximum score.');
  if (input.sort) { if (!leadSorts.includes(input.sort as never)) throw new RequestError(400, 'Invalid sort.'); query.sort = input.sort as LeadFilters['sort']; }
  if (input.page) { if (!/^[1-9]\d{0,3}$/.test(input.page as string)) throw new RequestError(400, 'Invalid page.'); query.page = Number(input.page); }
  return query;
}
export function managementChanges(lead: Lead, input: Record<string, unknown>): Record<string, unknown> {
  if (!timestamp(input.expectedUpdatedAt)) throw new RequestError(400, 'The last loaded update timestamp is required.');
  if (input.expectedUpdatedAt !== lead.updatedAt) throw new RequestError(409, 'This lead changed. Reload it before saving your edits.');
  if (Object.keys(input).some(key => key !== 'expectedUpdatedAt' && !editable.includes(key as never)) || Object.keys(input).length < 2) throw new RequestError(400, 'Only documented management fields may be edited.');
  const merged = { ...lead, ...input };
  for (const key of ['businessName', 'niche', 'country', 'city', 'address', 'phone', 'website', 'email'] as const) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || (input[key] as string).length > (key === 'businessName' ? 300 : key === 'city' || key === 'niche' ? leadLabelMaxLength : key === 'email' ? 254 : key === 'phone' ? 40 : 2000))) throw new RequestError(400, 'A contact field has an invalid type or length.');
  }
  if (input.country && (typeof input.country !== 'string' || !/^[a-z]{2}$/i.test(input.country))) throw new RequestError(400, 'Country must be a two-letter code.');
  for (const key of ['rating', 'reviewCount'] as const) if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || (key === 'rating' ? input[key] > 5 : !Number.isSafeInteger(input[key]) || input[key] > 2147483647))) throw new RequestError(400, 'Rating or review count is invalid.');
  if (input.status !== undefined && !leadStatuses.includes(input.status as never)) throw new RequestError(400, 'Invalid pipeline status.');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 10000)) throw new RequestError(400, 'Notes must be text up to 10,000 characters.');
  if (input.followUpAt !== undefined && input.followUpAt !== null && !timestamp(input.followUpAt)) throw new RequestError(400, 'Follow-up must be an ISO date/time or null.');
  // Validate labels that are actually edited. Historical overlong labels may be
  // corrected explicitly; they must not block an unrelated notes/status save.
  const normalized = normalizeLead({ ...merged,
    city: Object.hasOwn(input, 'city') ? merged.city : null,
    niche: Object.hasOwn(input, 'niche') ? merged.niche : null,
    sourceId: lead.sourceId, metadata: {} }, lead.source).lead;
  for (const key of ['website', 'phone', 'email'] as const) if (input[key] && !normalized[key]) throw new RequestError(400, `The ${key} could not be validated. Correct it or explicitly clear it.`);
  const changes: Record<string, unknown> = {};
  for (const key of editable) {
    if (!Object.hasOwn(input, key)) continue;
    const value = key === 'status' || key === 'notes' ? input[key] : key === 'followUpAt' ? input[key] === null ? null : new Date(input[key] as string).toISOString() : normalized[key];
    if (value !== lead[key]) changes[key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase())] = value;
  }
  if (Object.hasOwn(input, 'website') && normalized.domain !== lead.domain) changes.domain = normalized.domain;
  const next = { ...lead, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value])) };
  if (assessmentInputs.some(key => JSON.stringify(next[key]) !== JSON.stringify(lead[key]))) Object.assign(changes, { audit: null, classification: null, score: null, score_reasons: [] });
  return changes;
}
export interface ManagementRepository {
  all(): Promise<ManagedLead[]>; findById(id: string): Promise<Lead | null>; update(lead: Lead, changes: Record<string, unknown>): Promise<Lead>;
}
export class SupabaseManagementRepository implements ManagementRepository {
  constructor(private client: SupabaseClient, private ownerId: string) {}
  findById(id: string) { return new SupabaseLeadRepository(this.client, this.ownerId).findById(id); }
  async all() {
    // The invoker RPC derives ownership from Auth/RLS and returns one bounded MVCC
    // snapshot. Separate requests may see newer state; one response cannot mix pages.
    const response = await this.client.rpc('lead_management_snapshot');
    if (response.error || !Array.isArray(response.data)) throw new RequestError(503, 'Lead management could not load. Check the snapshot migration and retry.');
    if (response.data.length > 2000) throw new RequestError(409, 'Lead management supports up to 2,000 owner records. Counts and filters were not truncated.');
    return response.data.map((row: Record<string, unknown>) => summarizeLead(leadFromRow(row)));
  }
  async update(lead: Lead, changes: Record<string, unknown>) {
    const response = await this.client.from('leads').update(changes).eq('owner_id', this.ownerId).eq('id', lead.id).eq('updated_at', lead.updatedAt).select('*').maybeSingle();
    if (response.error) throw new RequestError(503, 'Changes could not be saved. Please reload before retrying.');
    if (!response.data) throw new RequestError(409, 'This lead changed. Reload it before saving your edits.');
    return leadFromRow(response.data);
  }
}
export class ManagementService {
  constructor(private repository: (owner: string, token: string) => ManagementRepository) {}
  async list(owner: string, token: string, query: LeadFilters): Promise<LeadPage> {
    const all = await this.repository(owner, token).all();
    const rows = filterAndSortLeads(all, query), pageSize = 25, page = Math.min(query.page, Math.max(1, Math.ceil(rows.length / pageSize)));
    const options = (key: 'niche' | 'country' | 'city') => [...new Set(all.flatMap(row => row[key] ? [row[key]!] : []))].sort();
    return { leads: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, options: { niches: options('niche'), countries: options('country'), cities: options('city') } };
  }
  async counts(owner: string, token: string) { return dashboardCounts(await this.repository(owner, token).all()); }
  async edit(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const repository = this.repository(owner, token), lead = await repository.findById(id);
    if (!lead) throw new RequestError(404, 'Lead not found.');
    const changes = managementChanges(lead, input);
    return Object.keys(changes).length ? repository.update(lead, changes) : lead;
  }
}
export function createManagementService(env: NodeJS.ProcessEnv) {
  const settings = readServerEnv(env);
  return new ManagementService((owner, token) => {
    const client = createServerSupabase(settings, token);
    if (!client) throw new RequestError(503, 'Supabase is not configured.');
    return new SupabaseManagementRepository(client, owner);
  });
}
export function managementRoutes(service?: ManagementService) {
  const router = Router();
  router.use((_req, _res, next) => { if (!service) throw new RequestError(503, 'Lead management is not configured.'); next(); });
  router.get('/leads', async (req, res) => res.json(await service!.list(res.locals.userId, res.locals.accessToken, parseLeadFilters(req.query))));
  router.get('/counts', async (_req, res) => res.json(await service!.counts(res.locals.userId, res.locals.accessToken)));
  router.patch('/leads/:id', async (req, res) => {
    if (typeof req.params.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(req.params.id)) throw new RequestError(400, 'Invalid lead ID.');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new RequestError(400, 'A JSON object is required.');
    const lead = await service!.edit(res.locals.userId, res.locals.accessToken, req.params.id, req.body as Record<string, unknown>);
    res.json({ lead, resolution: resolveWebsiteEvidence(lead) });
  });
  return router;
}
