import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lead } from '@igetjobs/shared';
import { templateText } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { defaultScoring, evaluateLead } from '../apps/api/src/audit/policy.js';
import { AiService, AgentRouterGateway, validateAiResult, type AiGateway } from '../apps/api/src/ai/service.js';
import { createApp } from '../apps/api/src/app.js';
import { evidenceKey } from '../apps/api/src/outreach/service.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { quotaStore, type QuotaRpc } from '../apps/api/src/quota.js';
import type { UsageStore } from '../apps/api/src/discovery/usage.js';
import { managementChanges } from '../apps/api/src/management.js';
import { verifiedOutreachIssues } from '@igetjobs/shared';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
function leadFixture(): Lead {
  const base = normalizeLead({ businessName:'Fixture Dental',city:'London',niche:'Dentists',website:'http://fixture.example/',sourceId:'fixture',metadata:{} },'CSV').lead;
  const checks = [{ key:'website_present',label:'Website',outcome:'pass' as const,evidence:'Recorded website' },{ key:'https',label:'HTTPS',outcome:'fail' as const,evidence:'HTTP used' }];
  const scored = evaluateLead(base,checks,defaultScoring);
  const assessed: Lead = { ...base,...scored,classification:'POOR_WEBSITE',score:75,audit:{ state:'reachable',website:base.website,requestedWebsite:base.website,auditedAt:'2026-10-03T12:00:00Z',checks,scoring:defaultScoring } };
  const generated = templateText(assessed)!;
  return { ...assessed,outreachDraft:{ ...generated,approval:'pending',updatedAt:assessed.updatedAt,version:'outreach-v1.1',sourceKey:evidenceKey(assessed),stale:false,edited:false,generatedSubject:generated.subject,generatedBody:generated.body } };
}
function service(lead: Lead, gateway: AiGateway | null, usage?: UsageStore) {
  let reserves = 0;
  const store: UsageStore = usage || { load:async () => ({}),save:async () => {},reserve:async () => { reserves++; } };
  const ai = new AiService(owner => ({ findById:async id => owner === a && id === lead.id ? structuredClone(lead) : null }),gateway,store,35);
  return { ai,reserves:() => reserves };
}
const request = (lead: Lead) => ({ expectedUpdatedAt:lead.updatedAt,subject:lead.outreachDraft!.subject,body:lead.outreachDraft!.body });
test('AI polish starts from the editable draft and returns a suggestion without any lead write', async () => {
  const lead = leadFixture(), original = structuredClone(lead); let seen = '', calls = 0;
  const generated = templateText(lead)!;
  const { ai,reserves } = service(lead,{ complete:async (_instructions,facts,limit) => {
    calls++; seen = facts; assert.equal(limit,500);
    return JSON.stringify({ subject:generated.subject,body:generated.body });
  } });
  const result = await ai.run(a,'token',lead.id,'polish',request(lead));
  assert.deepEqual(result,{ subject:generated.subject,body:generated.body });
  assert.equal(JSON.parse(seen).currentDraft.body,lead.outreachDraft!.body);
  assert.equal(calls,1); assert.equal(reserves(),1); assert.deepEqual(lead,original);
  assert.equal(lead.classification,original.classification); assert.equal(lead.score,original.score);
});
test('failed, empty, malformed, timeout and budget responses leave deterministic draft untouched', async () => {
  const lead = leadFixture(), snapshot = structuredClone(lead);
  for (const raw of ['', '{}', 'not-json', JSON.stringify({ subject:'Other',body:'Unsupported claim' })]) {
    const { ai } = service(lead,{ complete:async () => raw });
    await assert.rejects(ai.run(a,'token',lead.id,'polish',request(lead)),RequestError);
    assert.deepEqual(lead,snapshot);
  }
  for (const error of [new RequestError(503,'timeout'),new RequestError(429,'budget exhausted')]) {
    const { ai } = service(lead,{ complete:async () => { throw error; } });
    await assert.rejects(ai.run(a,'token',lead.id,'polish',request(lead)),RequestError); assert.deepEqual(lead,snapshot);
  }
  const disabled = service(lead,null);
  await assert.rejects(disabled.ai.run(a,'token',lead.id,'polish',request(lead)),error => error instanceof RequestError && error.status === 503);
  assert.equal(disabled.reserves(),0);
});
test('summary and angle are bounded suggestions; no unsupported impact, claims or state mutation', async () => {
  const lead = leadFixture(), snapshot = structuredClone(lead);
  const { ai } = service(lead,{ complete:async (_instructions,_facts,max) => max === 250 ? 'The check recorded “HTTP used”, which may make a website conversation useful.' : 'Angle: Offer a clearer presentation after the check recorded “HTTP used”.' });
  assert.match((await ai.run(a,'token',lead.id,'summary',{ expectedUpdatedAt:lead.updatedAt }) as { text:string }).text,/HTTP/);
  assert.match((await ai.run(a,'token',lead.id,'angle',{ expectedUpdatedAt:lead.updatedAt }) as { text:string }).text,/^Angle:/);
  assert.deepEqual(lead,snapshot);
  assert.throws(() => validateAiResult('summary','This will boost revenue by 50%.','{}',lead),RequestError);
  assert.throws(() => validateAiResult('angle','Angle: Your customers are leaving.','{}',lead),RequestError);
  const facts = JSON.stringify({ businessName:lead.businessName });
  assert.throws(() => validateAiResult('polish',JSON.stringify({ subject:'Fixture Dental',body:'Hello Jane Smith, Fixture Dental. ' + verifiedOutreachIssues(lead)[0] }),facts,lead),RequestError);
});
test('invalid/denied requests do not reserve usage and mockup candidate remains user-controlled', async () => {
  const lead = leadFixture(); let calls = 0;
  const { ai,reserves } = service(lead,{ complete:async () => { calls++; return 'unused'; } });
  await assert.rejects(ai.run(b,'token',lead.id,'summary',{ expectedUpdatedAt:lead.updatedAt }),error => error instanceof RequestError && error.status === 404);
  await assert.rejects(ai.run(a,'token',lead.id,'summary',{ expectedUpdatedAt:'stale' }),error => error instanceof RequestError && error.status === 409);
  await assert.rejects(ai.run(a,'token',lead.id,'angle',{ expectedUpdatedAt:lead.updatedAt,extra:true }),error => error instanceof RequestError && error.status === 400);
  assert.equal(reserves(),0); assert.equal(calls,0);
  assert.deepEqual(managementChanges(lead,{ expectedUpdatedAt:lead.updatedAt,mockupCandidate:true }),{ mockup_candidate:true });
  assert.deepEqual(managementChanges({ ...lead,mockupCandidate:true },{ expectedUpdatedAt:lead.updatedAt,mockupCandidate:false }),{ mockup_candidate:false });
  assert.throws(() => managementChanges(lead,{ expectedUpdatedAt:lead.updatedAt,mockupCandidate:'yes' }),RequestError);
});
test('AgentRouter service stops at the configured 35 daily reservations before another model request', async () => {
  const lead = leadFixture(); let reserved = 0, requests = 0;
  const { ai } = service(lead,{ complete:async () => { requests++; return 'The check recorded HTTP used for the audited page.'; } },{
    load:async () => ({}),save:async () => {},reserve:async (_provider,limit) => {
      assert.equal(limit,35);
      if (reserved >= 35) throw new RequestError(429,'QUOTA_EXHAUSTED');
      reserved++;
    }
  });
  for (let i=0;i<35;i++) await ai.run(a,'token',lead.id,'summary',{ expectedUpdatedAt:lead.updatedAt });
  await assert.rejects(ai.run(a,'token',lead.id,'summary',{ expectedUpdatedAt:lead.updatedAt }),error => error instanceof RequestError && error.status === 429 && /daily AI limit/.test(error.message));
  assert.equal(reserved,35); assert.equal(requests,35);
});
test('AgentRouter transport is one bounded server request and never returns provider error detail', async () => {
  let requests = 0;
  const gateway = new AgentRouterGateway('fixture-secret','deepseek-v4-flash','https://agentrouter.org/v1',async (url,init) => {
    requests++; assert.equal(url,'https://agentrouter.org/v1/chat/completions');
    assert.equal((JSON.parse(init!.body as string) as { reasoning_effort:string }).reasoning_effort,'none');
    return new Response(JSON.stringify({ choices:[{ message:{ content:'Fixture suggestion' } }] }),{ status:200 });
  });
  assert.equal(await gateway.complete('instructions','facts',150),'Fixture suggestion'); assert.equal(requests,1);
  const failed = new AgentRouterGateway('fixture-secret','deepseek-v4-flash','https://agentrouter.org/v1',async () => new Response('fixture-private-provider-detail',{ status:500 }));
  await assert.rejects(failed.complete('instructions','facts',150),error => error instanceof RequestError && !error.message.includes('fixture-private-provider-detail'));
});
test('authenticated and approved users alone can invoke AI routes; denied users reserve nothing', async () => {
  let calls = 0;
  const client = { auth:{ getUser:async (token:string) => ({ data:{ user:{ id:token === 'approved' ? a : b } },error:null }) } } as unknown as SupabaseClient;
  const ai = { configured:true,run:async () => { calls++; return { text:'AI suggestion' }; } } as unknown as AiService;
  const server = createApp(client,undefined,undefined,undefined,undefined,undefined,new Set([a]),ai).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/api/ai/' + a + '/summary';
    const send = (token?:string) => fetch(url,{ method:'POST',headers:{ 'Content-Type':'application/json',...(token ? { Authorization:'Bearer ' + token } : {}) },body:'{}' });
    assert.equal((await send()).status,401); assert.equal((await send('unapproved')).status,403); assert.equal(calls,0);
    assert.equal((await send('approved')).status,200); assert.equal(calls,1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('actual migration enforces global 35/day across fresh services, role denial and manual flag RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon noinherit; create role authenticated noinherit; create role service_role noinherit; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting(\'request.jwt.claim.sub\',true),\'\')::uuid$$; grant usage on schema auth to anon,authenticated;');
    await db.query('insert into auth.users values ($1),($2)',[a,b]);
    for (const file of ['202610010001_auth_and_leads.sql','202610010002_lead_management.sql','202610010003_management_snapshot.sql','202610020004_outreach.sql','202610020005_provider_usage.sql','202610020006_geoapify.sql','202610030007_ai_assist.sql']) await db.exec(await readFile('supabase/migrations/' + file,'utf8'));
    const rpc: QuotaRpc = { async rpc(name,input) { try { const query = name === 'reserve_provider_usage' ? 'select public.reserve_provider_usage($1,$2) as data' : 'select public.provider_usage_status() as data'; return { data:(await db.query<{data:unknown}>(query,input ? [input.p_provider,input.p_limit] : [])).rows[0]!.data,error:null }; } catch (error) { return { data:null,error:{ code:(error as { code:string }).code,message:(error as Error).message } }; } } };
    await db.exec('set role service_role');
    for (let count = 0; count < 35; count++) await quotaStore(rpc).reserve!('AGENTROUTER',35);
    assert.equal((await quotaStore(rpc).load()).AGENTROUTER!.count,35);
    await assert.rejects(quotaStore(rpc).reserve!('AGENTROUTER',35),error => error instanceof RequestError && error.status === 429);
    await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a]);
    const own = (await db.query<{id:string}>("insert into public.leads(business_name,source) values ('Mine','CSV') returning id")).rows[0]!.id;
    assert.equal((await db.query<{mockup_candidate:boolean}>('update public.leads set mockup_candidate=true where id=$1 returning mockup_candidate',[own])).rows[0]!.mockup_candidate,true);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b]);
    assert.equal((await db.query('update public.leads set mockup_candidate=false where id=$1 returning id',[own])).rows.length,0);
    await assert.rejects(db.query("select public.reserve_provider_usage('AGENTROUTER',35)"));
  } finally { await db.close(); }
});
