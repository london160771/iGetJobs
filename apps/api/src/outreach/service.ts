import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentDraft, draftLimits, outreachItems, outreachVersion, templateText, worthPursuing, type Lead, type OutreachDraft, type OutreachPage, type OutreachTab } from '@igetjobs/shared';
import { RequestError } from '../discovery/errors.js';
import { SupabaseLeadRepository, leadFromRow } from '../discovery/repository.js';
import { SupabaseManagementRepository } from '../management.js';
import { readServerEnv } from '../env.js';
import { createServerSupabase } from '../supabase.js';
import { fileUsageStore } from '../discovery/usage.js';
import { usageFile, verifiedHunterKey } from '../production.js';
import { supabaseUsageStore } from '../quota.js';
import { resolveWebsiteEvidence } from '../website-safety.js';
import { HunterAdapter, usableEmail, type ContactAdapter } from './hunter.js';

function canonical(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    return item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item;
  }
  return JSON.stringify(ordered(value));
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function evidenceKey(lead: Lead) {
  return hash(Object.fromEntries(['businessName','niche','country','city','address','phone','website','domain','email','socials','rating','reviewCount','source','sourceId','provenance','audit','classification','score','scoreReasons'].map(key => [key, lead[key as keyof Lead]])));
}
export function draftIsCurrent(lead: Lead) { return currentDraft(lead) && lead.outreachDraft?.sourceKey === evidenceKey(lead); }
export function hunterDomain(lead: Lead): string | null {
  const url = lead.audit?.requestedWebsite;
  if (!url || !resolveWebsiteEvidence(lead).candidates.includes(url)) return null;
  try {
    const domain = new URL(url).hostname.toLowerCase().replace(/^www\./,'');
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(domain) && !/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(domain) && !domain.endsWith('.home.arpa') ? domain : null;
  } catch { return null; }
}
const enrichmentKey = (lead: Lead, domain: string) => hash([lead.businessName,lead.country,lead.city,domain]);
export interface OutreachRepository { findById(id: string): Promise<Lead | null>; all(): Promise<Lead[]>; update(lead: Lead, changes: Record<string, unknown>): Promise<Lead> }
export class SupabaseOutreachRepository implements OutreachRepository {
  constructor(private client: SupabaseClient, private owner: string) {}
  findById(id: string) { return new SupabaseLeadRepository(this.client, this.owner).findById(id); }
  update(lead: Lead, changes: Record<string, unknown>) { return new SupabaseManagementRepository(this.client, this.owner).update(lead, changes); }
  async all() {
    const response = await this.client.rpc('lead_outreach_snapshot');
    if (response.error || !Array.isArray(response.data)) throw new RequestError(503, 'Outreach could not load. Check the outreach migration and retry.');
    if (response.data.length > 2000) throw new RequestError(409, 'Outreach supports up to 2,000 owner records; results were not truncated.');
    return response.data.map((row: Record<string, unknown>) => leadFromRow(row));
  }
}
export class OutreachService {
  private busy = new Set<string>();
  constructor(private repository: (owner: string, token: string) => OutreachRepository, readonly hunter: ContactAdapter, private now = () => new Date().toISOString()) {}
  async list(owner: string, token: string, tab: OutreachTab, today: string, page: number): Promise<OutreachPage> {
    const items = outreachItems(await this.repository(owner,token).all(),tab,today), pageSize = 20;
    page = Math.min(page,Math.max(1,Math.ceil(items.length/pageSize)));
    return { items: items.slice((page-1)*pageSize,page*pageSize), total: items.length, page, pageSize, hunterConfigured: this.hunter.configured };
  }
  private async loaded(owner: string, token: string, id: string, input: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(input).some(key => !['expectedUpdatedAt',...allowed].includes(key)) || typeof input.expectedUpdatedAt !== 'string') throw new RequestError(400, 'Only documented outreach fields and the last loaded timestamp are accepted.');
    const repository = this.repository(owner,token), lead = await repository.findById(id);
    if (!lead) throw new RequestError(404,'Lead not found.');
    if (input.expectedUpdatedAt !== lead.updatedAt) throw new RequestError(409,'This lead changed. Reload before continuing.');
    return { repository, lead };
  }
  async generate(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const { repository, lead } = await this.loaded(owner,token,id,input,['replaceEdited']);
    if (input.replaceEdited !== undefined && typeof input.replaceEdited !== 'boolean') throw new RequestError(400,'Replace-edited must be an explicit boolean.');
    const generated = templateText(lead), resolution = resolveWebsiteEvidence(lead);
    if (!generated || (lead.classification === 'NO_WEBSITE' && (resolution.candidates.length || resolution.invalidCount))) throw new RequestError(409,'A current, completed opportunity assessment is required. Review website evidence and audit first.');
    if (lead.outreachDraft?.edited && input.replaceEdited !== true) throw new RequestError(409,'Regeneration would replace your edits. Explicitly confirm replacement first.');
    const draft: OutreachDraft = { ...generated, approval: 'pending', updatedAt: this.now(), version: outreachVersion, sourceKey: evidenceKey(lead), stale: false, edited: false, generatedSubject: generated.subject, generatedBody: generated.body };
    return repository.update(lead,{ outreach_draft: draft });
  }
  async save(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const { repository, lead } = await this.loaded(owner,token,id,input,['subject','body','approve']);
    if (!draftIsCurrent(lead)) throw new RequestError(409,'Draft evidence is stale. Reaudit and regenerate before approving or copying.');
    if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > draftLimits.subject || /[\r\n\p{Cc}]/u.test(input.subject)
      || typeof input.body !== 'string' || !input.body.trim() || input.body.length > draftLimits.body || typeof input.approve !== 'boolean') throw new RequestError(400,'Enter a subject, bounded draft text and explicit review decision.');
    const draft: OutreachDraft = { ...lead.outreachDraft!, subject: input.subject, body: input.body, edited: input.subject !== lead.outreachDraft!.generatedSubject || input.body !== lead.outreachDraft!.generatedBody, approval: input.approve ? 'approved' : 'pending', updatedAt: this.now() };
    if (draft.subject === lead.outreachDraft!.subject && draft.body === lead.outreachDraft!.body && draft.approval === lead.outreachDraft!.approval) return lead;
    return repository.update(lead,{ outreach_draft: draft });
  }
  async contacted(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const { repository, lead } = await this.loaded(owner,token,id,input,[]);
    if (['Closed','Lost'].includes(lead.status)) throw new RequestError(409,'Reopen the lead manually before marking it Contacted.');
    return lead.status === 'Contacted' ? lead : repository.update(lead,{ status:'Contacted' });
  }
  async copy(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const { lead } = await this.loaded(owner,token,id,input,[]);
    if (!draftIsCurrent(lead) || lead.outreachDraft?.approval !== 'approved') throw new RequestError(409,'Review and approve a current draft before copying.');
    return lead; // Fresh read only. Clipboard access is performed by the user’s browser.
  }
  async enrich(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const lock = owner + ':' + id;
    if (this.busy.has(lock)) throw new RequestError(429,'A lookup for this lead is already running.');
    this.busy.add(lock);
    try {
      const { repository, lead } = await this.loaded(owner,token,id,input,['retry']);
      if (input.retry !== undefined && typeof input.retry !== 'boolean') throw new RequestError(400,'Retry must be an explicit boolean.');
      if (!this.hunter.configured) throw new RequestError(503,'Hunter is not configured. No lookup was made.');
      if (!worthPursuing(lead) || usableEmail(lead.email)) throw new RequestError(409,'Hunter requires a worthwhile assessed lead without a usable email.');
      const domain = hunterDomain(lead);
      if (!domain) throw new RequestError(409,'No recorded business domain is available for a safe lookup. Company-name guesses are not used.');
      const inputKey = enrichmentKey(lead,domain);
      if (lead.contactEnrichment?.inputKey === inputKey && input.retry !== true) throw new RequestError(409,'This unchanged lead was already attempted. Review the saved result or explicitly retry.');
      const pending = { provider:'HUNTER' as const, domain,inputKey,attemptedAt:this.now(),state:'pending' as const };
      const reserved = await repository.update(lead,{ contact_enrichment:pending });
      let result;
      try { result = await this.hunter.lookup(domain); }
      catch (failure) { result = { state: failure instanceof RequestError && [403,429].includes(failure.status) ? 'quota' as const : 'error' as const }; }
      return await repository.update(reserved,{ contact_enrichment:{ ...pending,...result } });
    } finally { this.busy.delete(lock); }
  }
  async acceptEmail(owner: string, token: string, id: string, input: Record<string, unknown>) {
    const { repository,lead } = await this.loaded(owner,token,id,input,[]), found = lead.contactEnrichment, domain = hunterDomain(lead);
    if (usableEmail(lead.email) || !found || found.state !== 'found' || !usableEmail(found.email) || !domain || found.inputKey !== enrichmentKey(lead,domain)) throw new RequestError(409,'Review a current Hunter candidate before accepting it. Existing emails are never overwritten.');
    return repository.update(lead,{ email:found.email,contact_enrichment:{ ...found,state:'accepted' },audit:null,classification:null,score:null,score_reasons:[] });
  }
}
export function createOutreachService(env: NodeJS.ProcessEnv) {
  const settings = readServerEnv(env);
  return new OutreachService((owner,token) => {
    const client = createServerSupabase(settings,token); if (!client) throw new RequestError(503,'Supabase is not configured.');
    return new SupabaseOutreachRepository(client,owner);
  },new HunterAdapter(verifiedHunterKey(env),env.NODE_ENV === 'production' || env.SUPABASE_QUOTA_SERVICE_KEY ? supabaseUsageStore(env) : fileUsageStore(usageFile(env, 'hunter')),Number(env.HUNTER_MONTHLY_LIMIT || '10')));
}
export function outreachRoutes(service?: OutreachService) {
  const router = Router();
  router.use((_req,_res,next) => { if (!service) throw new RequestError(503,'Outreach is not configured.'); next(); });
  router.get('/config',(_req,res) => res.json({ hunterConfigured:service!.hunter.configured }));
  router.get('/',async (req,res) => {
    const tab = req.query.tab || 'Ready', today = req.query.today || new Date().toISOString().slice(0,10), page = req.query.page || '1';
    if (Object.keys(req.query).some(key => !['tab','today','page'].includes(key)) || typeof tab !== 'string' || !['Ready','Contacted','Follow-up Due'].includes(tab)
      || typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(Date.parse(today)) || new Date(today).toISOString().slice(0,10) !== today
      || typeof page !== 'string' || !/^[1-9]\d{0,3}$/.test(page)) throw new RequestError(400,'Choose a valid outreach tab, calendar day and page.');
    res.json(await service!.list(res.locals.userId,res.locals.accessToken,tab as OutreachTab,today,Number(page)));
  });
  for (const action of ['generate','save','contacted','copy','enrich','acceptEmail'] as const) router.post('/:id/' + action,async (req,res) => {
    if (typeof req.params.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(req.params.id) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new RequestError(400,'A lead ID and JSON object are required.');
    res.json({ lead:await service![action](res.locals.userId,res.locals.accessToken,req.params.id,req.body) });
  });
  return router;
}
