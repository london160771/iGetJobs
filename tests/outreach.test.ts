import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Lead } from '@igetjobs/shared';
import { copyOutreachDraft, currentDraft, outreachItems, templateText, worthPursuing } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { defaultScoring, evaluateLead } from '../apps/api/src/audit/policy.js';
import { OutreachService, draftIsCurrent, evidenceKey, hunterDomain } from '../apps/api/src/outreach/service.js';
import { HunterAdapter, usableEmail, type ContactAdapter } from '../apps/api/src/outreach/hunter.js';
import type { UsageStore } from '../apps/api/src/discovery/usage.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { auditLead } from '../apps/api/src/audit/engine.js';
import { WebsiteFetchError, type WebsiteFetchResult } from '../apps/api/src/audit/fetcher.js';

const conflict = (error: unknown) => error instanceof RequestError && error.status === 409;
function fixture(poor = false): Lead {
  const lead = normalizeLead({ businessName:'Fixture Dental',city:'London',niche:'Dentists',website:poor ? 'https://clinic.com/' : null,sourceId:'fixture',metadata:{} },'CSV').lead;
  const checks = poor ? [{ key:'website_present',label:'Website',outcome:'pass' as const,evidence:'Known website' },{ key:'https',label:'HTTPS',outcome:'fail' as const,evidence:'HTTP used' },{ key:'viewport',label:'Viewport',outcome:'fail' as const,evidence:'Meta absent' },{ key:'mobile_width',label:'Width',outcome:'unknown' as const,evidence:'Not rendered' }]
    : [{ key:'website_present',label:'Website',outcome:'fail' as const,evidence:'No canonical or linked website' }];
  const scored = evaluateLead(lead,checks,defaultScoring);
  return { ...lead,...scored,status:'Qualified',audit:{ checks,scoring:defaultScoring,state:poor ? 'reachable' : 'missing',website:lead.website,requestedWebsite:lead.website,auditedAt:'2026-10-02T12:00:00Z' } };
}
function memory(lead = fixture(), adapter: ContactAdapter = { configured:false,lookup:async () => { throw new Error('No implicit lookup'); } }) {
  let saved = structuredClone(lead), writes = 0;
  const service = new OutreachService(owner => ({
    findById:async id => owner === 'A' && id === saved.id ? structuredClone(saved) : null,
    all:async () => owner === 'A' ? [structuredClone(saved)] : [],
    update:async (loaded,changes) => {
      if (loaded.updatedAt !== saved.updatedAt) throw new RequestError(409,'Stale');
      const mapped = Object.fromEntries(Object.entries(changes).map(([key,value]) => [key.replace(/_([a-z])/g,(_m,c:string) => c.toUpperCase()),value]));
      saved = { ...saved,...mapped,updatedAt:new Date(Date.UTC(2026,9,2,12,0,++writes)).toISOString() };
      return structuredClone(saved);
    }
  }),adapter,() => '2026-10-02T12:00:00Z');
  return { service,get:() => saved,set:(next:Lead) => { saved = next; } };
}
test('NO_WEBSITE and POOR_WEBSITE templates use only bounded recorded/static evidence deterministically', () => {
  const missing = fixture(), poor = fixture(true);
  const text = templateText(missing)!;
  assert.match(text.body,/Fixture Dental/); assert.match(text.body,/Dentists · London/); assert.match(text.body,/If you already have one/);
  assert.deepEqual(templateText(missing),text);
  const quality = templateText(poor)!;
  assert.match(quality.body,/HTTP rather than HTTPS/); assert.match(quality.body,/rendered mobile behavior was not verified/);
  assert.doesNotMatch(quality.body,/not mobile.friendly|outdated|losing customers|slow on phones|great reviews/i);
  const unknown = { ...poor,audit:{ ...poor.audit!,checks:poor.audit!.checks.map(check => ({ ...check,outcome:'unknown' as const })) } };
  assert.equal(templateText(unknown),null);
  assert.equal(templateText({ ...poor,audit:null,classification:null,score:null }),null);
  assert.equal(templateText({ ...poor,classification:'ACCEPTABLE_WEBSITE' }),null);
  const unreachable = { ...poor,audit:{ ...poor.audit!,state:'unreachable' as const,checks:[{ key:'reachable',label:'Reachable',outcome:'fail' as const,evidence:'Timeout' }] } };
  assert.match(templateText(unreachable)!.body,/may be temporary; page quality was not verified/);
  assert.equal(worthPursuing({ ...poor,status:'Lost' }),false);
});
test('outreach failure findings reflect recorded HTTP, DNS, network, timeout and unknown evidence without invented causes', async () => {
  const base = fixture(true), now = () => '2026-10-02T12:00:00Z';
  const response = (status:number):WebsiteFetchResult => ({ url:base.website!,status,headers:{},body:'',bytes:0,durationMs:1,redirects:0 });
  const cases = [
    { kind:'http' as const,fetcher:async () => response(500),wording:/responded, but the requested page could not be loaded/ },
    { kind:'http' as const,fetcher:async () => response(404),wording:/responded, but the requested page could not be loaded/ },
    { kind:'dns' as const,fetcher:async () => { throw new WebsiteFetchError('dns','Website DNS lookup failed.'); },wording:/address could not be resolved/ },
    { kind:'network' as const,fetcher:async () => { throw new WebsiteFetchError('network','Website connection failed.'); },wording:/encountered a connection problem/ },
    { kind:'network' as const,fetcher:async () => { throw new WebsiteFetchError('network','Website response ended early.'); },wording:/encountered a connection problem/ },
    { kind:'timeout' as const,fetcher:async () => { throw new WebsiteFetchError('timeout','Website audit timed out.'); },wording:/check timed out before it could finish/ }
  ];
  for (const entry of cases) {
    const assessment = await auditLead(base,undefined,defaultScoring,entry.fetcher,now), lead = { ...base,...assessment };
    assert.equal(assessment.audit.failure,entry.kind); assert.equal(lead.classification,'POOR_WEBSITE');
    const draft = templateText(lead)!; assert.match(draft.body,entry.wording);
    assert.doesNotMatch(draft.body,/did not respond|No response was received|HTTP 500|HTTP 404|DNS|ECONN|not mobile.friendly/i);
    assert.deepEqual(templateText(lead),draft);
    assert.deepEqual(await auditLead(base,undefined,defaultScoring,entry.fetcher,now),assessment);
    // Existing stored audits without the new field use their measured status or
    // exact previously emitted evidence, never a guessed diagnosis.
    const { failure: _failure,...legacy } = assessment.audit; void _failure;
    assert.match(templateText({ ...lead,audit:legacy })!.body,entry.wording);
  }
  const unknown = { ...base,audit:{ ...base.audit!,state:'unreachable' as const,checks:[{ key:'reachable',label:'Reachable',outcome:'fail' as const,evidence:'Unknown historical failure' }] } };
  assert.match(templateText(unknown)!.body,/could not be checked successfully/);
  assert.doesNotMatch(templateText(unknown)!.body,/did not respond|No response|timed out|connection problem|resolved/);
  assert.match(templateText({ ...unknown,audit:{ ...unknown.audit,checks:[{ ...unknown.audit.checks[0]!,evidence:'No response received.' }] } })!.body,/No response was received/);
  const contradictory = { ...unknown,audit:{ ...unknown.audit,failure:'dns' as const,metrics:{ status:500,durationMs:1,bytes:0,redirects:0 } } };
  assert.match(templateText(contradictory)!.body,/responded, but/); assert.doesNotMatch(templateText(contradictory)!.body,/could not be resolved/);
});
test('old failure drafts require regeneration/review without overwriting saved text or invalidating unaffected drafts', async () => {
  const model = memory(fixture(true));
  let lead = await model.service.generate('A','token',model.get().id,{ expectedUpdatedAt:model.get().updatedAt });
  const legacy = { ...lead,outreachDraft:{ ...lead.outreachDraft!,version:'outreach-v1',edited:true,body:'Saved user text',approval:'approved' as const } };
  assert.ok(currentDraft(legacy));
  const failed = { ...legacy,audit:{ ...legacy.audit!,state:'unreachable' as const,checks:[{ key:'reachable',label:'Reachable',outcome:'fail' as const,evidence:'Audit request returned HTTP 500.' }],metrics:{ status:500,durationMs:1,bytes:0,redirects:0 } } };
  model.set(failed); assert.equal(currentDraft(failed),false);
  assert.equal(failed.outreachDraft.body,'Saved user text');
  await assert.rejects(model.service.copy('A','token',failed.id,{ expectedUpdatedAt:failed.updatedAt }),conflict);
  await assert.rejects(model.service.generate('A','token',failed.id,{ expectedUpdatedAt:failed.updatedAt }),conflict);
  lead = await model.service.generate('A','token',failed.id,{ expectedUpdatedAt:failed.updatedAt,replaceEdited:true });
  assert.ok(currentDraft(lead)); assert.equal(lead.outreachDraft?.approval,'pending');
  assert.match(lead.outreachDraft!.body,/responded, but/);
});
test('generation/edit/replacement/approval/copy use owner and timestamp guards and detect changed evidence', async () => {
  const model = memory(), id = model.get().id, service = model.service;
  let lead = await service.generate('A','token',id,{ expectedUpdatedAt:model.get().updatedAt });
  assert.equal(lead.outreachDraft?.approval,'pending'); assert.ok(draftIsCurrent(lead));
  await assert.rejects(service.copy('A','token',id,{ expectedUpdatedAt:lead.updatedAt }),conflict);
  lead = await service.save('A','token',id,{ expectedUpdatedAt:lead.updatedAt,subject:'My subject',body:'My own reviewed text',approve:true });
  assert.ok(lead.outreachDraft?.edited); assert.equal(lead.outreachDraft?.body,'My own reviewed text');
  assert.equal((await service.copy('A','token',id,{ expectedUpdatedAt:lead.updatedAt })).id,id);
  await assert.rejects(service.generate('A','token',id,{ expectedUpdatedAt:lead.updatedAt }),conflict);
  await assert.rejects(service.save('A','token',id,{ expectedUpdatedAt:'stale',subject:'Other',body:'Other',approve:true }),conflict);
  await assert.rejects(service.generate('B','token',id,{ expectedUpdatedAt:lead.updatedAt }),error => error instanceof RequestError && error.status === 404);
  model.set({ ...lead,city:'Paris' }); assert.equal(draftIsCurrent(model.get()),false);
  await assert.rejects(service.copy('A','token',id,{ expectedUpdatedAt:lead.updatedAt }),conflict);
  lead = await service.generate('A','token',id,{ expectedUpdatedAt:lead.updatedAt,replaceEdited:true });
  assert.equal(lead.outreachDraft?.edited,false); assert.equal(lead.outreachDraft?.approval,'pending');
  model.set({ ...lead,outreachDraft:{ ...lead.outreachDraft!,stale:true },audit:null,classification:null,score:null });
  assert.equal(currentDraft(model.get()),false);
  await assert.rejects(service.save('A','token',id,{ expectedUpdatedAt:lead.updatedAt,subject:'Old',body:'Old',approve:true }),conflict);
});
test('clipboard helper copies only approved current drafts and reports denial/unavailability', async () => {
  const model = memory(); let lead = await model.service.generate('A','token',model.get().id,{ expectedUpdatedAt:model.get().updatedAt });
  let copied = '';
  const clipboard = { writeText:async (value:string) => { copied = value; } };
  await assert.rejects(copyOutreachDraft(lead.outreachDraft,true,clipboard)); assert.equal(copied,'');
  lead = await model.service.save('A','token',lead.id,{ expectedUpdatedAt:lead.updatedAt,subject:'Approved',body:'Reviewed message',approve:true });
  await copyOutreachDraft(lead.outreachDraft,true,clipboard); assert.equal(copied,'Subject: Approved\n\nReviewed message');
  await assert.rejects(copyOutreachDraft(lead.outreachDraft,false,clipboard));
  await assert.rejects(copyOutreachDraft(lead.outreachDraft,true));
  await assert.rejects(copyOutreachDraft(lead.outreachDraft,true,{ writeText:async () => { throw new Error('Permission denied'); } }),/Clipboard access failed/);
});
test('manual Contacted transition and Ready/Contacted/Follow-up Due views are independent of sending', async () => {
  const model = memory(), old = model.get();
  assert.equal((await model.service.list('A','token','Ready','2026-10-02',1)).total,1);
  const contacted = await model.service.contacted('A','token',old.id,{ expectedUpdatedAt:old.updatedAt }); assert.equal(contacted.status,'Contacted');
  assert.equal((await model.service.list('A','token','Ready','2026-10-02',1)).total,0);
  assert.equal((await model.service.list('A','token','Contacted','2026-10-02',1)).total,1);
  assert.equal((await model.service.list('B','token','Contacted','2026-10-02',1)).total,0);
  assert.equal(outreachItems([{ ...contacted,followUpAt:'2026-10-02T12:00:00Z' }],'Follow-up Due','2026-10-02').length,1);
  assert.equal(outreachItems([{ ...contacted,followUpAt:'2026-10-03T12:00:00Z' }],'Follow-up Due','2026-10-02').length,0);
  await assert.rejects(model.service.contacted('A','token',old.id,{ expectedUpdatedAt:old.updatedAt }),conflict);
});
test('Hunter eligibility, persisted reservation, repeat/retry/no-result and contact acceptance safeguards', async () => {
  let calls = 0;
  const adapter:ContactAdapter = { configured:true,lookup:async () => { calls++; return { state:'found',email:'info@clinic.com',confidence:90 }; } };
  const model = memory(fixture(true),adapter), id = model.get().id;
  assert.equal(hunterDomain(model.get()),'clinic.com');
  let lead = await model.service.enrich('A','token',id,{ expectedUpdatedAt:model.get().updatedAt });
  assert.equal(calls,1); assert.equal(lead.contactEnrichment?.state,'found'); assert.equal(lead.email,null);
  await assert.rejects(model.service.enrich('A','token',id,{ expectedUpdatedAt:lead.updatedAt }),conflict); assert.equal(calls,1);
  lead = await model.service.enrich('A','token',id,{ expectedUpdatedAt:lead.updatedAt,retry:true }); assert.equal(calls,2);
  lead = await model.service.acceptEmail('A','token',id,{ expectedUpdatedAt:lead.updatedAt }); assert.equal(lead.email,'info@clinic.com'); assert.equal(lead.audit,null); assert.equal(lead.classification,null); assert.equal(lead.score,null); assert.deepEqual(lead.scoreReasons,[]);
  await assert.rejects(model.service.enrich('A','token',id,{ expectedUpdatedAt:lead.updatedAt }),conflict);
  for (const candidate of [fixture(),{ ...fixture(true),email:'exists@clinic.com' },{ ...fixture(true),status:'Lost' as const },{ ...fixture(true),score:1,status:'New' as const }]) {
    const blocked = memory(candidate,adapter); await assert.rejects(blocked.service.enrich('A','token',candidate.id,{ expectedUpdatedAt:candidate.updatedAt }),conflict);
  }
  const none = memory(fixture(true),{ configured:true,lookup:async () => ({ state:'no_result' }) });
  lead = await none.service.enrich('A','token',none.get().id,{ expectedUpdatedAt:none.get().updatedAt }); assert.equal(lead.contactEnrichment?.state,'no_result');
  const quota = memory(fixture(true),{ configured:true,lookup:async () => { throw new RequestError(429,'Quota'); } });
  lead = await quota.service.enrich('A','token',quota.get().id,{ expectedUpdatedAt:quota.get().updatedAt }); assert.equal(lead.contactEnrichment?.state,'quota');
  const lost = memory(fixture(true),{ configured:true,lookup:async () => { throw new Error('Lost response'); } });
  lead = await lost.service.enrich('A','token',lost.get().id,{ expectedUpdatedAt:lost.get().updatedAt }); assert.equal(lead.contactEnrichment?.state,'error');
  await assert.rejects(lost.service.enrich('A','token',lead.id,{ expectedUpdatedAt:lead.updatedAt }),conflict);
});
test('Hunter adapter fails closed on paid/unknown/quota accounts, reserves attempts and sanitizes provider responses', async () => {
  let rows = {}, requests = 0, now = Date.UTC(2026,9,2), plan = 'Free', remaining = 50;
  const store:UsageStore = { load:async () => structuredClone(rows),save:async value => { rows = structuredClone(value); } };
  const transport = (async (input,init) => {
    const url = new URL(String(input)); requests++; assert.equal(url.origin,'https://api.hunter.io'); assert.equal(url.searchParams.has('api_key'),false); assert.equal((init?.headers as Record<string,string>)['X-API-KEY'],'fixture-secret'); assert.equal(init?.redirect,'error');
    return new Response(JSON.stringify({ data:url.pathname.endsWith('/account') ? { plan_name:plan,plan_level:plan === 'Free' ? 0 : 1,requests:{ credits:{ remaining,available:50 } } } : { domain:'clinic.com',emails:[{ value:'info@clinic.com',type:'generic',confidence:90,api_key:'must-not-survive' }] } }));
  }) as typeof fetch;
  const adapter = new HunterAdapter('fixture-secret',store,2,transport,() => now);
  assert.deepEqual(await adapter.lookup('clinic.com'),{ state:'found',email:'info@clinic.com',confidence:90 }); assert.equal(requests,2);
  await assert.rejects(adapter.lookup('clinic.com'),error => error instanceof RequestError && error.status === 429); assert.equal(requests,2);
  now += 5000; remaining = 0;
  await assert.rejects(adapter.lookup('clinic.com'),error => error instanceof RequestError && error.status === 429); assert.equal(requests,3);
  now += 5000; await assert.rejects(adapter.lookup('clinic.com'),error => error instanceof RequestError && error.status === 429); assert.equal(requests,3);
  now = Date.UTC(2026,10,2); plan = 'Starter'; remaining = 50;
  await assert.rejects(adapter.lookup('clinic.com'),error => error instanceof RequestError && error.status === 403); assert.equal(requests,4);
  assert.equal(usableEmail('x'.repeat(255) + '@clinic.com'),false);
  assert.throws(() => new HunterAdapter('key',store,51));
  const noResult = new HunterAdapter('fixture', { load:async () => ({}),save:async () => {} },10,(async input => new Response(JSON.stringify({ data:String(input).endsWith('/account') ? { plan_name:'Free',requests:{ searches:{ remaining:25,available:25 } } } : { domain:'clinic.com',emails:[] } }))) as typeof fetch);
  assert.deepEqual(await noResult.lookup('clinic.com'),{ state:'no_result' });
});
test('slow enrichment results cannot overwrite concurrent edits and concurrent lookup waits are rejected', async () => {
  let signalStarted!: () => void, release!: (value: { state:'found'; email:string; confidence:number }) => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const result = new Promise<{ state:'found'; email:string; confidence:number }>(resolve => { release = resolve; });
  const model = memory(fixture(true),{ configured:true,lookup:async () => { signalStarted(); return result; } });
  const original = model.get(), pending = model.service.enrich('A','token',original.id,{ expectedUpdatedAt:original.updatedAt });
  await started;
  assert.equal(model.get().contactEnrichment?.state,'pending');
  await assert.rejects(model.service.enrich('A','token',original.id,{ expectedUpdatedAt:model.get().updatedAt,retry:true }),error => error instanceof RequestError && error.status === 429);
  model.set({ ...model.get(),notes:'Concurrent user note',updatedAt:'2026-10-02T13:00:00Z' });
  release({ state:'found',email:'info@clinic.com',confidence:90 });
  await assert.rejects(pending,conflict);
  assert.equal(model.get().notes,'Concurrent user note'); assert.equal(model.get().email,null);
  assert.equal(model.get().contactEnrichment?.state,'pending');
});
test('evidence fingerprint is insensitive to JSONB key order but changes on audit or scoring inputs', () => {
  const lead = fixture(), reordered = JSON.parse(JSON.stringify(lead)) as Lead;
  reordered.provenance = lead.provenance.map(row => ({ ...(row.metadata ? { metadata:row.metadata } : {}),sourceId:row.sourceId,source:row.source }));
  assert.equal(evidenceKey(lead),evidenceKey(reordered)); assert.notEqual(evidenceKey(lead),evidenceKey({ ...lead,score:99 }));
  assert.equal(evidenceKey(lead),evidenceKey({ ...lead,notes:'Private note',status:'Contacted' }));
});
test('actual outreach migration preserves edits but atomically revokes stale approval, records activity and obeys owner RLS', async () => {
  const db = new PGlite(), a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec("create role anon noinherit; create role authenticated noinherit; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to anon,authenticated;");
    await db.query('insert into auth.users values ($1),($2)',[a,b]);
    for (const file of ['202610010001_auth_and_leads.sql','202610010002_lead_management.sql','202610010003_management_snapshot.sql','202610020004_outreach.sql']) await db.exec(await readFile('supabase/migrations/' + file,'utf8'));
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a]);
    const id = (await db.query<{ id:string }>("insert into public.leads(business_name,source,notes) values ('Fixture','CSV','Keep notes') returning id")).rows[0]!.id;
    await db.query("update public.leads set audit='{}',classification='NO_WEBSITE',score=65 where id=$1",[id]);
    await db.query("update public.leads set outreach_draft='{\"subject\":\"Reviewed\",\"body\":\"User text\",\"approval\":\"approved\",\"stale\":false,\"edited\":true}' where id=$1",[id]);
    const same = (await db.query<{ outreach_draft:{ approval:string }; activity:unknown[] }>('update public.leads set status=\'Contacted\' where id=$1 returning outreach_draft,activity',[id])).rows[0]!;
    assert.equal(same.outreach_draft.approval,'approved');
    const changed = (await db.query<{ outreach_draft:{ approval:string; stale:boolean; body:string }; audit:unknown; classification:unknown; score:unknown; score_reasons:unknown[]; notes:string; activity:unknown[] }>("update public.leads set website='https://clinic.com/',outreach_draft='{\"forged\":true}' where id=$1 returning *",[id])).rows[0]!;
    assert.equal(changed.outreach_draft.body,'User text'); assert.equal(changed.outreach_draft.stale,true); assert.equal(changed.outreach_draft.approval,'pending'); assert.equal(changed.audit,null); assert.equal(changed.classification,null); assert.equal(changed.score,null); assert.deepEqual(changed.score_reasons,[]); assert.equal(changed.notes,'Keep notes');
    const read = await db.query<{ data:unknown[] }>('select public.lead_outreach_snapshot() as data'); assert.equal(read.rows[0]!.data.length,1);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b]); assert.equal((await db.query<{ data:unknown[] }>('select public.lead_outreach_snapshot() as data')).rows[0]!.data.length,0);
    assert.equal((await db.query('update public.leads set status=\'Lost\' where id=$1 returning id',[id])).rows.length,0);
    await db.exec('reset role; set role anon'); await assert.rejects(db.query('select public.lead_outreach_snapshot()'));
  } finally { await db.close(); }
});
