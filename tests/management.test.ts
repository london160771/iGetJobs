import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { dashboardCounts, filterAndSortLeads, followUpState, summarizeLead, type Lead } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { managementChanges, ManagementService, parseLeadFilters, SupabaseManagementRepository } from '../apps/api/src/management.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { defaultScoring } from '../apps/api/src/audit/policy.js';
import { auditLead } from '../apps/api/src/audit/engine.js';

const fixture = (name = 'Clinic'): Lead => normalizeLead({ businessName: name, country: 'GB', city: 'London', niche: 'Dentists', email: 'public@clinic.com', phone: '+442079460958', sourceId: name, metadata: {} }, 'CSV').lead;
const invalid = (error: unknown) => error instanceof RequestError && error.status === 400;
const conflict = (error: unknown) => error instanceof RequestError && error.status === 409;

test('management filters combine all dimensions and exclude null scores from numeric ranges', () => {
  const a = { ...fixture(), score: 65, classification: 'NO_WEBSITE' as const, status: 'Qualified' as const };
  const b = { ...fixture('Other'), country: 'US', city: 'Boston', niche: 'Gyms', score: 90, classification: 'POOR_WEBSITE' as const, source: 'OSM' as const, email: null, phone: null };
  const rows = [a, b, fixture('Unaudited')].map(summarizeLead);
  const query = parseLeadFilters({ niche: 'Dentists', country: 'GB', city: 'London', classification: 'NO_WEBSITE', minScore: '65', maxScore: '65', priority: 'Medium', status: 'Qualified', source: 'CSV', hasEmail: 'yes', hasPhone: 'yes' });
  assert.deepEqual(filterAndSortLeads(rows, query).map(row => row.id), [a.id]);
  for (const [key, value] of Object.entries({ niche: 'Gyms', country: 'US', city: 'Boston', classification: 'POOR_WEBSITE', priority: 'High', source: 'OSM', hasEmail: 'no', hasPhone: 'no' })) assert.deepEqual(filterAndSortLeads(rows, parseLeadFilters({ [key]: value })).map(row => row.id), [b.id]);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ classification: 'UNAUDITED' })).length, 1);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ minScore: '0' })).length, 2);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ maxScore: '0' })).length, 0);
  for (const input of [{ score: '1' }, { source: ['CSV'] }, { minScore: '-1' }, { maxScore: '101' }, { minScore: '90', maxScore: '20' }, { status: 'Won' }, { sort: 'sql' }, { page: '0' }]) assert.throws(() => parseLeadFilters(input), invalid);
});

test('sorting is stable, null scores sort last, and priority uses each saved audit policy', () => {
  const leads = [fixture('Zulu'), fixture('Alpha'), fixture('Bravo')];
  leads.forEach((lead, i) => { lead.createdAt = lead.updatedAt = `2026-01-0${i + 1}T12:00:00Z`; lead.score = i === 2 ? null : i === 0 ? 70 : 30; });
  const rows = leads.map(summarizeLead);
  for (const [sort, expected] of Object.entries({ score_desc: ['Zulu', 'Alpha', 'Bravo'], score_asc: ['Alpha', 'Zulu', 'Bravo'], newest: ['Bravo', 'Alpha', 'Zulu'], oldest: ['Zulu', 'Alpha', 'Bravo'], updated: ['Bravo', 'Alpha', 'Zulu'], name: ['Alpha', 'Bravo', 'Zulu'] })) assert.deepEqual(filterAndSortLeads(rows, parseLeadFilters({ sort })).map(row => row.businessName), expected);
  const custom = { ...leads[1]!, audit: { auditedAt: '2026-01-01', website: null, checks: [], scoring: { ...defaultScoring, highPriority: 30, mediumPriority: 10 } } };
  assert.equal(summarizeLead(custom).priority, 'High');
  const tied = rows.map(row => ({ ...row, score: 40 }));
  assert.deepEqual(filterAndSortLeads(tied, parseLeadFilters({ sort: 'score_desc' })), filterAndSortLeads([...tied].reverse(), parseLeadFilters({ sort: 'score_desc' })));
});

test('dashboard counts describe actual stages/classifications; follow-up states handle today and clearing', () => {
  const statuses = ['New', 'Qualified', 'Contacted', 'Replied', 'Call Booked', 'Closed', 'Lost'] as const;
  const leads = statuses.map((status, i) => ({ ...fixture(String(i)), status, classification: i === 0 ? 'NO_WEBSITE' as const : i === 1 ? 'POOR_WEBSITE' as const : null })).map(summarizeLead);
  assert.deepEqual(dashboardCounts(leads), { total: 7, qualified: 1, noWebsite: 1, poorWebsite: 1, contacted: 1, replied: 1, callsBooked: 1, closed: 1 });
  assert.equal(dashboardCounts([]).total, 0);
  assert.equal(followUpState(null, '2026-10-01'), null);
  assert.equal(followUpState('2026-09-30T12:00:00Z', '2026-10-01'), 'Overdue');
  assert.equal(followUpState('2026-10-01T12:00:00Z', '2026-10-01'), 'Today');
  assert.equal(followUpState('2026-10-02T12:00:00Z', '2026-10-01'), 'Upcoming');
});

test('management edits whitelist fields, preserve unchanged assessments, and invalidate every editable evidence/scoring input', async () => {
  const lead = fixture(); Object.assign(lead, await auditLead(lead));
  const notes = managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, status: 'Qualified', notes: 'Discuss next steps', followUpAt: '2026-10-02T12:00:00.000Z' });
  assert.deepEqual(notes, { status: 'Qualified', notes: 'Discuss next steps', follow_up_at: '2026-10-02T12:00:00.000Z' });
  assert.deepEqual(managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, status: 'New' }), {});
  for (const [key, value] of Object.entries({ businessName: 'Changed', niche: 'Gyms', country: 'US', city: 'Boston', address: '123 Street', website: '//clinic.com/?access_token=fixture', email: 'new@clinic.com', phone: '+442079460959', rating: 4.5, reviewCount: 8 })) {
    const changes = managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, [key]: value });
    assert.equal(changes.audit, null, key); assert.equal(changes.classification, null); assert.equal(changes.score, null); assert.deepEqual(changes.score_reasons, []);
    if (key === 'website') { assert.equal(changes.website, 'https://clinic.com/'); assert.equal(changes.domain, 'clinic.com'); }
  }
  assert.throws(() => managementChanges(lead, { expectedUpdatedAt: '2020-01-01T00:00:00Z', notes: 'Stale' }), conflict);
  for (const input of [{ score: 100 }, { ownerId: 'B' }, { activity: [] }, { provenance: [] }, { status: 'Won' }, { notes: null }, { notes: 'x'.repeat(10001) }, { followUpAt: 'not-a-date' }, { followUpAt: '2026-02-31T12:00:00Z' }, { website: { url: 'clinic.com' } }, { website: 'javascript:alert(1)' }, { phone: 'garbage' }, { rating: '4' }, { reviewCount: 1.2 }]) assert.throws(() => managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, ...input }), invalid);
});

test('service paginates the complete owner collection, isolates users and rejects stale edits', async () => {
  const leads = Array.from({ length: 130 }, (_, i) => fixture(String(i))), ownerLead = leads[0]!;
  let saved: Record<string, unknown> | null = null;
  const service = new ManagementService(owner => ({ all: async () => owner === 'A' ? leads.map(summarizeLead) : [], findById: async id => owner === 'A' && id === ownerLead.id ? ownerLead : null, update: async (lead, changes) => { saved = changes; return lead; } }));
  assert.equal((await service.list('A', 'token', parseLeadFilters({ page: '6' }))).leads.length, 5);
  assert.equal((await service.counts('A', 'token')).total, 130);
  assert.equal((await service.counts('B', 'token')).total, 0);
  await assert.rejects(service.edit('B', 'token', ownerLead.id, { expectedUpdatedAt: ownerLead.updatedAt, notes: 'Attack' }), error => error instanceof RequestError && error.status === 404);
  await service.edit('A', 'token', ownerLead.id, { expectedUpdatedAt: ownerLead.updatedAt, notes: 'Saved' });
  assert.deepEqual(saved, { notes: 'Saved' });
});

test('repository update guards owner, ID and timestamp and exposes no database error details', async () => {
  const lead = fixture(), filters: unknown[] = [];
  let error: unknown = null, data: unknown = null;
  const chain = { update: () => chain, eq: (key: string, value: string) => { filters.push([key, value]); return chain; }, select: () => chain, maybeSingle: async () => ({ error, data }) };
  const repository = new SupabaseManagementRepository({ from: () => chain } as never, 'A');
  await assert.rejects(repository.update(lead, { notes: 'Saved' }), conflict);
  assert.deepEqual(filters, [['owner_id', 'A'], ['id', lead.id], ['updated_at', lead.updatedAt]]);
  error = { message: 'private database information' };
  await assert.rejects(repository.update(lead, {}), err => err instanceof RequestError && err.status === 503 && !err.message.includes('private'));
  error = null; data = { id: lead.id, business_name: 'Clinic' };
  assert.equal((await repository.update(lead, {})).businessName, 'Clinic');
});

test('actual management migration atomically preserves history, invalidates assessments and retains owner RLS', async () => {
  const db = new PGlite(), a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`create role anon noinherit; create role authenticated noinherit; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to anon,authenticated;`);
    await db.query('insert into auth.users values ($1),($2)', [a,b]);
    for (const file of ['202610010001_auth_and_leads.sql', '202610010002_lead_management.sql']) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    const asUser = async (id: string) => { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); };
    await asUser(a);
    const id = (await db.query<{ id: string }>("insert into public.leads(business_name,source,activity) values ('Clinic','CSV','[{\"forged\":true}]') returning id")).rows[0]!.id;
    await db.query("update public.leads set audit='{\"checks\":[]}',classification='NO_WEBSITE',score=60,score_reasons='[{\"points\":60}]' where id=$1", [id]);
    const managed = (await db.query<{ audit: unknown; activity: { statusTo?: string; assessmentInvalidated: boolean }[] }>("update public.leads set notes='Saved note',status='Qualified',follow_up_at='2026-10-02T12:00:00Z',activity='[]' where id=$1 returning audit,activity", [id])).rows[0]!;
    assert.ok(managed.audit); assert.equal(managed.activity.length, 2); assert.equal(managed.activity[1]?.statusTo, 'Qualified'); assert.equal(managed.activity[1]?.assessmentInvalidated, false);
    for (const [field, sqlValue] of Object.entries({ website: "'https://clinic.com/'", domain: "'clinic.com'", email: "'public@clinic.com'", phone: "'+442079460958'", rating: '4', review_count: '7', provenance: "'[{\"source\":\"OSM\"}]'::jsonb", source_id: "'new-id'", socials: "'{\"instagram\":\"https://instagram.com/clinic\"}'::jsonb" })) {
      await db.query("update public.leads set audit='{\"checks\":[]}',classification='NO_WEBSITE',score=60,score_reasons='[{\"points\":60}]' where id=$1", [id]);
      const row = (await db.query<{ audit: unknown; classification: unknown; score: unknown; score_reasons: unknown; activity: { assessmentInvalidated: boolean }[] }>(`update public.leads set ${field}=${sqlValue},audit='{"forged":true}',score=100 where id=$1 returning audit,classification,score,score_reasons,activity`, [id])).rows[0]!;
      assert.equal(row.audit, null, field); assert.equal(row.classification, null); assert.equal(row.score, null); assert.deepEqual(row.score_reasons, []); assert.equal(row.activity.at(-1)?.assessmentInvalidated, true);
    }
    for (let i = 0; i < 105; i++) await db.query('update public.leads set notes=$1 where id=$2', ['Note ' + i, id]);
    assert.equal((await db.query<{ activity: unknown[] }>('select activity from public.leads where id=$1', [id])).rows[0]!.activity.length, 100);
    await asUser(b);
    assert.equal((await db.query('select id from public.leads where id=$1', [id])).rows.length, 0);
    assert.equal((await db.query("update public.leads set notes='Foreign' where id=$1 returning id", [id])).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select activity from public.leads'), error => error instanceof Error && 'code' in error && error.code === '42501');
  } finally { await db.close(); }
});
