import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir,writeFile } from 'node:fs/promises';
import { createApp } from '../apps/api/dist/app.js';
import { readServerEnv } from '../apps/api/dist/env.js';
import { createServerSupabase } from '../apps/api/dist/supabase.js';
import { createManagementService } from '../apps/api/dist/management.js';
import { createAuditService,SupabaseAuditRepository } from '../apps/api/dist/audit/service.js';
import { auditLead } from '../apps/api/dist/audit/engine.js';
import { OutreachService,SupabaseOutreachRepository,createOutreachService } from '../apps/api/dist/outreach/service.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { leadToRow } from '../apps/api/dist/discovery/repository.js';
import { defaultScoring,evaluateLead } from '../apps/api/dist/audit/policy.js';

config({ path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true });
config({ path:fileURLToPath(new URL('../apps/api/.env',import.meta.url)),quiet:true });
const clients = [], created = []; let server, checkpoint = 'Phase 4 configuration', hunterCalls = 0, hunterMode = 'found';
function check(condition,label) { checkpoint = label; if (!condition) throw new Error('Verification failed'); console.log('PASS: ' + label); }
try {
  const settings = readServerEnv(process.env), accounts = [];
  for (const suffix of ['A','B']) {
    const client = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } }); clients.push(client);
    checkpoint = 'Phase 4 disposable account sign-in ' + suffix;
    const result = await client.auth.signInWithPassword({ email:process.env['SUPABASE_TEST_EMAIL_' + suffix] || '',password:process.env['SUPABASE_TEST_PASSWORD_' + suffix] || '' }); check(!result.error && Boolean(result.data.session),checkpoint);
    const user = await client.auth.getUser(); check(!user.error && Boolean(user.data.user),'Verified identity ' + suffix);
    const schema = await client.from('leads').select('id,contact_enrichment').limit(1); check(!schema.error,'Applied outreach migration ' + suffix);
    accounts.push({ client,token:result.data.session.access_token,owner:user.data.user.id,suffix });
  }
  const [a,b] = accounts;
  // Explicit provider fixture; it verifies API/remote persistence without consuming credits.
  const outreach = new OutreachService((owner,token) => new SupabaseOutreachRepository(createServerSupabase(settings,token),owner),{ configured:true,lookup:async () => { hunterCalls++; return hunterMode === 'found' ? { state:'found',email:'info@clinic.com',confidence:90 } : { state:'no_result' }; } });
  const productionConfig = createOutreachService(process.env).hunter.configured;
  check(typeof productionConfig === 'boolean','Hunter configuration exposes presence only, without credentials');
  check(!createOutreachService({ ...process.env,HUNTER_API_KEY:'' }).hunter.configured,'Missing Hunter credential disables the production adapter');
  server = createApp(createServerSupabase(settings),undefined,createAuditService(process.env),createManagementService(process.env),outreach,undefined,new Set([a.owner])).listen(0,'127.0.0.1'); await once(server,'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path,account = a,body,method = 'POST') {
    const response = await fetch(base + path,{ method:body === undefined ? 'GET' : method,headers:{ 'Content-Type':'application/json',...(account ? { Authorization:'Bearer ' + account.token } : {}) },...(body === undefined ? {} : { body:JSON.stringify(body) }),signal:AbortSignal.timeout(35000) });
    return { status:response.status,data:await response.json() };
  }
  check((await request('/api/outreach',null)).status === 401,'Outreach routes require authentication');
  const missing = normalizeLead({ businessName:'Disposable outreach ' + randomUUID(),city:'London',niche:'Dentists',sourceId:randomUUID(),metadata:{} },'CSV').lead;
  const poor = normalizeLead({ businessName:'Disposable enrichment ' + randomUUID(),city:'London',website:'https://clinic.com/',sourceId:randomUUID(),metadata:{} },'CSV').lead;
  for (const lead of [missing,poor]) {
    lead.status = 'Qualified'; created.push(lead.id);
    await mkdir(fileURLToPath(new URL('../.local',import.meta.url)),{ recursive:true }); await writeFile(fileURLToPath(new URL('../.local/phase4-verification-ids.json',import.meta.url)),JSON.stringify(created));
    const inserted = await a.client.from('leads').insert(leadToRow(lead,a.owner)); check(!inserted.error,'Disposable owner fixture inserted');
  }
  let result = await request('/api/leads/' + missing.id + '/audit',a,{}); check(result.status === 200 && result.data.lead.classification === 'NO_WEBSITE','Real missing-website assessment persists');
  let lead = result.data.lead;
  async function action(name,body = {}) { const response = await request('/api/outreach/' + lead.id + '/' + name,a,{ expectedUpdatedAt:lead.updatedAt,...body }); check(response.status === 200,'Authenticated ' + name + ' action'); lead = response.data.lead; return response; }
  await action('generate'); check(lead.outreachDraft.approval === 'pending' && !lead.outreachDraft.stale,'Generated draft persists awaiting human review');
  check((await request('/api/outreach/' + lead.id + '/copy',a,{ expectedUpdatedAt:lead.updatedAt })).status === 409,'Unapproved draft cannot be copied');
  await action('save',{ subject:'Reviewed website question',body:'Disposable user-edited draft',approve:true }); check(lead.outreachDraft.edited && lead.outreachDraft.approval === 'approved','User edits and explicit approval persist');
  await action('copy');
  const historyLength = lead.activity.length; await action('save',{ subject:lead.outreachDraft.subject,body:lead.outreachDraft.body,approve:true }); check(lead.activity.length === historyLength,'Identical saved draft retry does not duplicate history');
  check((await request('/api/outreach/' + lead.id + '/generate',a,{ expectedUpdatedAt:lead.updatedAt })).status === 409,'Regeneration protects user edits');
  const ready = await request('/api/outreach?tab=Ready'); check(ready.status === 200 && ready.data.items.some(item => item.lead.id === lead.id && item.current),'Ready tab reflects a current assessed draft');
  const foreign = await request('/api/outreach/' + lead.id + '/save',b,{ expectedUpdatedAt:lead.updatedAt,subject:'Forbidden',body:'Forbidden',approve:true }); check(foreign.status === 404,'Foreign draft editing is denied');
  const old = lead.updatedAt; await action('contacted'); check(lead.status === 'Contacted' && lead.activity.at(-1).statusTo === 'Contacted','Manual Contacted persists with activity');
  const contactedHistory = lead.activity.length, contactedAt = lead.updatedAt;
  await action('contacted'); check(lead.activity.length === contactedHistory && lead.updatedAt === contactedAt,'Repeated Contacted action creates no duplicate activity');
  check((await request('/api/outreach/' + lead.id + '/contacted',a,{ expectedUpdatedAt:old })).status === 409,'Stale status write is rejected');
  const contacted = await request('/api/outreach?tab=Contacted'); check(contacted.data.items.some(item => item.lead.id === lead.id),'Contacted tab reflects actual state');
  const follow = await request('/api/management/leads/' + lead.id,a,{ expectedUpdatedAt:lead.updatedAt,followUpAt:'2026-10-02T12:00:00Z' },'PATCH'); check(follow.status === 200,'Existing follow-up management persists'); lead = follow.data.lead;
  check((await request('/api/outreach?' + new URLSearchParams({ tab:'Follow-up Due',today:'2026-10-02' }))).data.items.some(item => item.lead.id === lead.id),'Follow-up Due uses calendar-day semantics');
  const snapshotB = await b.client.rpc('lead_outreach_snapshot'); check(!snapshotB.error && !snapshotB.data.some(row => created.includes(row.id)),'Owner snapshot excludes foreign drafts');
  const anonymous = await createServerSupabase(settings).rpc('lead_outreach_snapshot'); check(Boolean(anonymous.error),'Anonymous snapshot execution denied');
  const loaded = lead.updatedAt, edited = await request('/api/management/leads/' + lead.id,a,{ expectedUpdatedAt:lead.updatedAt,city:'Oxford' },'PATCH'); check(edited.status === 200,'Management evidence change succeeds'); lead = edited.data.lead;
  check(lead.audit === null && lead.classification === null && lead.score === null && lead.scoreReasons.length === 0 && lead.outreachDraft.stale && lead.outreachDraft.approval === 'pending' && lead.outreachDraft.body === 'Disposable user-edited draft','Atomic invalidation preserves written text but revokes draft approval');
  check((await request('/api/outreach/' + lead.id + '/copy',a,{ expectedUpdatedAt:loaded })).status === 409,'Older browser copy cannot use invalidated evidence');
  const checks = [{ key:'website_present',label:'Website',outcome:'pass',evidence:'Fixture website' },{ key:'https',label:'HTTPS',outcome:'fail',evidence:'Fixture HTTP' },{ key:'viewport',label:'Viewport',outcome:'fail',evidence:'Fixture missing meta' }];
  const scored = evaluateLead(poor,checks,defaultScoring);
  const audited = await a.client.from('leads').update({ audit:{ checks,state:'reachable',scoring:defaultScoring,requestedWebsite:poor.website,website:poor.website,auditedAt:'2026-10-02T12:00:00Z' },classification:scored.classification,score:scored.score,score_reasons:scored.scoreReasons }).eq('id',poor.id).select('*').single(); check(!audited.error,'Explicit deterministic poor-site fixture persists');
  lead = (await request('/api/leads/' + poor.id)).data.lead;
  await action('generate'); await action('enrich'); check(lead.email === null && lead.contactEnrichment.state === 'found' && hunterCalls === 1,'Explicit provider fixture yields a saved candidate without overwriting contact data');
  check((await request('/api/outreach/' + lead.id + '/enrich',a,{ expectedUpdatedAt:lead.updatedAt })).status === 409 && hunterCalls === 1,'Unchanged lookup is blocked after persisted result');
  const lostResponseLead = (await request('/api/leads/' + lead.id)).data.lead; check(lostResponseLead.contactEnrichment.state === 'found','Enrichment outcome survives fresh owner read');
  await action('acceptEmail'); check(lead.email === 'info@clinic.com' && lead.audit === null && lead.outreachDraft.stale,'Explicit email acceptance atomically invalidates scoring/draft');
  const direct = await a.client.from('leads').update({ email:'other@clinic.com',outreach_draft:{ forged:true } }).eq('id',lead.id).select('*').single(); check(!direct.error && direct.data.outreach_draft.stale && direct.data.outreach_draft.body,'Direct owner evidence writes cannot retain or forge current outreach');
  const leak = await b.client.from('leads').select('id,outreach_draft,contact_enrichment').in('id',created); check(!leak.error && leak.data.length === 0,'Remote RLS hides draft and enrichment data');
  check((await b.client.from('leads').update({ outreach_draft:{} }).eq('id',lead.id).select('id')).data.length === 0,'Remote RLS blocks foreign outreach mutation');
  // Explicit HTTP fixture: exercise engine -> real JSONB persistence -> draft API,
  // without claiming a live website returned an error or consuming provider credits.
  const auditRepository = new SupabaseAuditRepository(createServerSupabase(settings,a.token),a.owner);
  const current = await auditRepository.findById(lead.id);
  const failedAssessment = await auditLead(current,undefined,defaultScoring,async url => ({ url,status:500,headers:{},body:'',bytes:0,durationMs:1,redirects:0 }));
  lead = await auditRepository.saveAudit(current,failedAssessment);
  const persistedFailure = (await request('/api/leads/' + lead.id)).data.lead;
  check(persistedFailure.audit.failure === 'http' && persistedFailure.audit.metrics.status === 500,'Recorded HTTP failure survives remote JSONB reload');
  await action('generate');
  check(lead.outreachDraft.body.includes('responded, but the requested page could not be loaded') && !lead.outreachDraft.body.includes('did not respond'),'Persisted HTTP response generates only supported outreach wording');
  check(hunterCalls === 1,'No silent provider lookup or automated sending occurred');
} catch { console.error('FAIL: ' + checkpoint); process.exitCode = 1; }
finally {
  if (clients[0] && created.length) try { const result = await clients[0].from('leads').delete().in('id',created); if (result.error) { console.error('FAIL: Phase 4 fixture cleanup'); process.exitCode = 1; } } catch { console.error('FAIL: Phase 4 fixture cleanup'); process.exitCode = 1; }
  for (const client of clients) try { await client.auth.signOut({ scope:'local' }); } catch { /* Local disposable sessions only. */ }
  if (server) await new Promise(resolve => server.close(resolve));
}
