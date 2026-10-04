import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { dashboardCounts, filterAndSortLeads, followUpState, leadLabelMaxLength, summarizeLead, type Lead } from '@igetjobs/shared';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { managementChanges, ManagementService, parseLeadFilters, SupabaseManagementRepository } from '../apps/api/src/management.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { defaultScoring } from '../apps/api/src/audit/policy.js';
import { auditLead } from '../apps/api/src/audit/engine.js';
import { CsvAdapter } from '../apps/api/src/discovery/adapters/csv.js';
import { discoveryOptions, validateQuery } from '../apps/api/src/discovery/config.js';

const fixture = (name = 'Clinic'): Lead => normalizeLead({ businessName: name, country: 'GB', city: 'London', niche: 'Dentists', email: 'public@clinic.com', phone: '+442079460958', sourceId: name, metadata: {} }, 'CSV').lead;
const invalid = (error: unknown) => error instanceof RequestError && error.status === 400;
const conflict = (error: unknown) => error instanceof RequestError && error.status === 409;

test('management filters distinguish never-audited, completed and manual-review leads', () => {
  const a = { ...fixture(), score: 65, classification: 'NO_WEBSITE' as const, auditAttemptStatus: 'COMPLETED' as const, status: 'Qualified' as const };
  const b = { ...fixture('Other'), country: 'US', city: 'Boston', niche: 'Gyms', score: 90, classification: 'POOR_WEBSITE' as const, auditAttemptStatus: 'COMPLETED' as const, source: 'OSM' as const, email: null, phone: null };
  const manual = { ...fixture('Manual review'), auditAttemptStatus: 'NEEDS_MANUAL_REVIEW' as const, auditAttemptReason: 'HTML_TOO_LARGE' as const, auditAttemptedAt: '2026-10-04T10:00:00Z' };
  const rows = [a, b, manual, fixture('Unaudited')].map(summarizeLead);
  const query = parseLeadFilters({ niche: 'Dentists', country: 'GB', city: 'London', classification: 'NO_WEBSITE', minScore: '65', maxScore: '65', priority: 'Medium', status: 'Qualified', source: 'CSV', hasEmail: 'yes', hasPhone: 'yes' });
  assert.deepEqual(filterAndSortLeads(rows, query).map(row => row.id), [a.id]);
  for (const [key, value] of Object.entries({ niche: 'Gyms', country: 'US', city: 'Boston', classification: 'POOR_WEBSITE', priority: 'High', source: 'OSM', hasEmail: 'no', hasPhone: 'no' })) assert.deepEqual(filterAndSortLeads(rows, parseLeadFilters({ [key]: value })).map(row => row.id), [b.id]);
  assert.deepEqual(filterAndSortLeads(rows, parseLeadFilters({ classification: 'UNAUDITED' })).map(row => row.businessName), ['Unaudited']);
  assert.deepEqual(filterAndSortLeads(rows, parseLeadFilters({ auditStatus: 'NEEDS_MANUAL_REVIEW' })).map(row => row.id), [manual.id]);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ auditStatus: 'COMPLETED' })).length, 2);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ auditStatus: 'NOT_AUDITED' })).length, 1);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ minScore: '0' })).length, 2);
  assert.equal(filterAndSortLeads(rows, parseLeadFilters({ maxScore: '0' })).length, 0);
  for (const input of [{ score: '1' }, { source: ['CSV'] }, { minScore: '-1' }, { maxScore: '101' }, { minScore: '90', maxScore: '20' }, { status: 'Won' }, { auditStatus: 'POOR_WEBSITE' }, { sort: 'sql' }, { page: '0' }]) assert.throws(() => parseLeadFilters(input), invalid);
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
    assert.equal(changes.audit_attempt_status, 'NOT_AUDITED', key); assert.equal(changes.audit_attempt_reason, null); assert.equal(changes.audit_attempted_at, null); assert.equal(changes.audit_attempt_detail, null);
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

test('collection/counts use one bounded snapshot, without offset reads under concurrent inserts', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ id: String(i).padStart(5, '0'), business_name: 'Fixture ' + i, status: i === 199 ? 'Qualified' : 'New', classification: null, score: null, audit: null }));
  let calls = 0, failed = false;
  const repository = new SupabaseManagementRepository({
    from: () => { throw new Error('Offset/table scan must never be used.'); },
    rpc: async (name: string) => {
      assert.equal(name, 'lead_management_snapshot'); calls++;
      const data = structuredClone(rows);
      rows.unshift({ ...rows[0]!, id: 'insert-' + calls, status: 'New' });
      return { data, error: failed ? { message: 'private details' } : null };
    }
  } as never, 'A');
  const before = await repository.all();
  assert.equal(calls, 1); assert.equal(before.length, 201); assert.equal(new Set(before.map(row => row.id)).size, 201);
  assert.equal(dashboardCounts(before).qualified, 1);
  const after = await repository.all();
  assert.equal(after.length, 202); assert.equal(new Set(after.map(row => row.id)).size, 202); assert.equal(dashboardCounts(after).qualified, 1);
  while (rows.length < 2001) rows.push({ ...rows[0]!, id: 'cap-' + rows.length });
  await assert.rejects(repository.all(), conflict);
  failed = true;
  await assert.rejects(repository.all(), err => err instanceof RequestError && err.status === 503 && !err.message.includes('private'));
});

test('city/niche boundary limits agree for edits, normalized imports, filters and discovery defaults/config', () => {
  const lead = fixture(), maximum = 'x'.repeat(leadLabelMaxLength), tooLong = maximum + 'x';
  for (const key of ['city', 'niche'] as const) {
    const changes = managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, [key]: maximum });
    assert.equal(changes[key], maximum);
    const record = new CsvAdapter().collect(`businessName,${key}\nBoundary,${maximum}`, 'boundary.csv').records[0]!;
    const imported = normalizeLead(record, 'CSV').lead;
    assert.equal(imported[key], maximum);
    assert.equal(filterAndSortLeads([summarizeLead(imported)], parseLeadFilters({ [key]: maximum })).length, 1);
    assert.throws(() => managementChanges(lead, { expectedUpdatedAt: lead.updatedAt, [key]: tooLong }), invalid);
    assert.throws(() => normalizeLead({ ...record, [key]: tooLong }, 'CSV'), invalid);
    assert.throws(() => normalizeLead({ ...record, [key]: ' '.repeat(leadLabelMaxLength + 1) }, 'CSV'), invalid);
    assert.throws(() => normalizeLead({ ...record, [key]: '\uFDFA'.repeat(leadLabelMaxLength) }, 'CSV'), invalid, 'NFKC expansion is bounded too.');
    assert.throws(() => parseLeadFilters({ [key]: tooLong }), invalid);
    assert.throws(() => parseLeadFilters({ [key]: '\uFDFA'.repeat(leadLabelMaxLength) }), invalid);
  }
  const options = discoveryOptions({ DISCOVERY_NICHES_JSON: JSON.stringify([{ id: 'boundary', label: maximum, tags: [['amenity', 'dentist']] }]) });
  const defaulted = new CsvAdapter().collect('businessName\nDefault labels', 'defaults.csv', { city: maximum, niche: maximum }).records[0]!;
  assert.equal(normalizeLead(defaulted, 'CSV').lead.city, maximum); assert.equal(normalizeLead(defaulted, 'CSV').lead.niche, maximum);
  assert.throws(() => normalizeLead({ ...defaulted, city: tooLong }, 'CSV'), invalid);
  assert.equal(validateQuery({ country: 'GB', city: maximum, niche: 'boundary' }, options.config).city, maximum);
  assert.throws(() => validateQuery({ country: 'GB', city: tooLong, niche: 'boundary' }, options.config), invalid);
  assert.throws(() => discoveryOptions({ DISCOVERY_NICHES_JSON: JSON.stringify([{ id: 'boundary', label: tooLong, tags: [['amenity', 'dentist']] }]) }));
  assert.deepEqual(managementChanges({ ...lead, city: tooLong, niche: tooLong }, { expectedUpdatedAt: lead.updatedAt, notes: 'Legacy label correction can wait' }), { notes: 'Legacy label correction can wait' });
});

test('actual management migration atomically preserves history, invalidates assessments and retains owner RLS', async () => {
  const db = new PGlite(), a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`create role anon noinherit; create role authenticated noinherit; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to anon,authenticated;`);
    await db.query('insert into auth.users values ($1),($2)', [a,b]);
    for (const file of ['202610010001_auth_and_leads.sql', '202610010002_lead_management.sql', '202610010003_management_snapshot.sql']) await db.exec(await readFile('supabase/migrations/' + file, 'utf8'));
    const asUser = async (id: string) => { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); };
    await asUser(a);
    const legacyCompleted = (await db.query<{ id: string }>("insert into public.leads(business_name,source) values ('Legacy completed','CSV') returning id")).rows[0]!.id;
    await db.query("update public.leads set audit='{}',classification='NO_WEBSITE',score=60 where id=$1", [legacyCompleted]);
    const legacyUntouched = (await db.query<{ id: string }>("insert into public.leads(business_name,source) values ('Legacy untouched','CSV') returning id")).rows[0]!.id;
    // The migration changes table/function definitions, so apply it as the
    // database owner; resume authenticated queries afterward to keep checking RLS.
    await db.exec('reset role');
    await db.exec(await readFile('supabase/migrations/202610040008_audit_manual_review.sql', 'utf8'));
    await asUser(a);
    const legacyStatuses = (await db.query<{ id: string; audit_attempt_status: string; audit_attempted_at: string | null }>("select id,audit_attempt_status,audit_attempted_at from public.leads where id=any($1::uuid[])", [[legacyCompleted, legacyUntouched]])).rows;
    assert.equal(legacyStatuses.find(row => row.id === legacyCompleted)?.audit_attempt_status, 'COMPLETED');
    assert.ok(legacyStatuses.find(row => row.id === legacyCompleted)?.audit_attempted_at);
    assert.deepEqual(legacyStatuses.find(row => row.id === legacyUntouched), { id: legacyUntouched, audit_attempt_status: 'NOT_AUDITED', audit_attempted_at: null });
    await db.query('delete from public.leads where id=any($1::uuid[])', [[legacyCompleted, legacyUntouched]]);
    const id = (await db.query<{ id: string }>("insert into public.leads(business_name,source,activity) values ('Clinic','CSV','[{\"forged\":true}]') returning id")).rows[0]!.id;
    await db.query("update public.leads set audit='{\"checks\":[]}',classification='NO_WEBSITE',score=60,score_reasons='[{\"points\":60}]',audit_attempt_status='COMPLETED',audit_attempted_at=now() where id=$1", [id]);
    const managed = (await db.query<{ audit: unknown; activity: { statusTo?: string; assessmentInvalidated: boolean }[] }>("update public.leads set notes='Saved note',status='Qualified',follow_up_at='2026-10-02T12:00:00Z',activity='[]' where id=$1 returning audit,activity", [id])).rows[0]!;
    assert.ok(managed.audit); assert.equal(managed.activity.length, 2); assert.equal(managed.activity[1]?.statusTo, 'Qualified'); assert.equal(managed.activity[1]?.assessmentInvalidated, false);
    const retained = (await db.query<{ audit_attempt_status: string; audit_attempt_reason: string | null; audit_attempt_detail: unknown; audit_attempted_at: string | null; audit: unknown; classification: string | null; score: number | null; activity: { auditAttempted?: boolean; auditCompleted?: boolean }[] }>("update public.leads set audit_attempt_status='NEEDS_MANUAL_REVIEW',audit_attempt_reason='HTML_TOO_LARGE',audit_attempted_at=now(),audit_attempt_detail='{}' where id=$1 returning audit_attempt_status,audit_attempt_reason,audit_attempt_detail,audit_attempted_at,audit,classification,score,activity", [id])).rows[0]!;
    assert.equal(retained.audit_attempt_status, 'NEEDS_MANUAL_REVIEW'); assert.equal(retained.audit_attempt_reason, 'HTML_TOO_LARGE'); assert.ok(retained.audit_attempted_at);
    assert.ok(retained.audit); assert.equal(retained.classification, 'NO_WEBSITE'); assert.equal(Number(retained.score), 60);
    assert.equal(retained.activity.at(-1)?.auditAttempted, true); assert.equal(retained.activity.at(-1)?.auditCompleted, false);
    const noteOnly = (await db.query<{ audit_attempt_status: string; audit_attempt_reason: string | null; classification: string | null }>("update public.leads set notes='manual review note' where id=$1 returning audit_attempt_status,audit_attempt_reason,classification", [id])).rows[0]!;
    assert.equal(noteOnly.audit_attempt_status, 'NEEDS_MANUAL_REVIEW'); assert.equal(noteOnly.audit_attempt_reason, 'HTML_TOO_LARGE'); assert.equal(noteOnly.classification, 'NO_WEBSITE');
    for (const [field, sqlValue] of Object.entries({ website: "'https://clinic.com/'", domain: "'clinic.com'", email: "'public@clinic.com'", phone: "'+442079460958'", rating: '4', review_count: '7', provenance: "'[{\"source\":\"OSM\"}]'::jsonb", source_id: "'new-id'", socials: "'{\"instagram\":\"https://instagram.com/clinic\"}'::jsonb" })) {
      await db.query("update public.leads set audit='{\"checks\":[]}',classification='NO_WEBSITE',score=60,score_reasons='[{\"points\":60}]',audit_attempt_status='COMPLETED',audit_attempt_reason=null,audit_attempted_at=now(),audit_attempt_detail=null where id=$1", [id]);
      const row = (await db.query<{ audit: unknown; classification: unknown; score: unknown; score_reasons: unknown; audit_attempt_status: string; audit_attempt_reason: string | null; audit_attempted_at: string | null; audit_attempt_detail: unknown; activity: { assessmentInvalidated: boolean }[] }>(`update public.leads set ${field}=${sqlValue},audit='{"forged":true}',score=100 where id=$1 returning audit,classification,score,score_reasons,audit_attempt_status,audit_attempt_reason,audit_attempted_at,audit_attempt_detail,activity`, [id])).rows[0]!;
      assert.equal(row.audit, null, field); assert.equal(row.classification, null); assert.equal(row.score, null); assert.deepEqual(row.score_reasons, []);
      assert.equal(row.audit_attempt_status, 'NOT_AUDITED'); assert.equal(row.audit_attempt_reason, null); assert.equal(row.audit_attempted_at, null); assert.equal(row.audit_attempt_detail, null);
      assert.equal(row.activity.at(-1)?.assessmentInvalidated, true);
    }
    for (let i = 0; i < 105; i++) await db.query('update public.leads set notes=$1 where id=$2', ['Note ' + i, id]);
    assert.equal((await db.query<{ activity: unknown[] }>('select activity from public.leads where id=$1', [id])).rows[0]!.activity.length, 100);
    await asUser(b);
    assert.equal((await db.query('select id from public.leads where id=$1', [id])).rows.length, 0);
    assert.equal((await db.query("update public.leads set notes='Foreign' where id=$1 returning id", [id])).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select activity from public.leads'), error => error instanceof Error && 'code' in error && error.code === '42501');
    await assert.rejects(db.query('select public.lead_management_snapshot()'), error => error instanceof Error && 'code' in error && error.code === '42501');
    await asUser(a);
    const snapshot = async () => (await db.query<{ data: Record<string, unknown>[] }>('select public.lead_management_snapshot() as data')).rows[0]!.data;
    await db.exec("insert into public.leads(business_name,source) select 'Snapshot '||i,'CSV' from generate_series(1,200) as i");
    const before = await snapshot();
    assert.equal(before.length, 201); assert.equal(new Set(before.map(row => row.id)).size, 201);
    // A data-changing CTE and the read share a statement snapshot. The stable
    // invoker function must see the before-view, then see the insert next request.
    const during = (await db.query<{ data: Record<string, unknown>[] }>("with inserted as (insert into public.leads(business_name,source,status) values ('Concurrent insert','CSV','Qualified') returning id) select public.lead_management_snapshot() as data,(select count(*) from inserted) as inserted_count")).rows[0]!.data;
    assert.deepEqual(during, before);
    const after = await snapshot();
    assert.equal(after.length, 202); assert.equal(new Set(after.map(row => row.id)).size, 202);
    assert.equal(after.filter(row => row.status === 'Qualified').length, before.filter(row => row.status === 'Qualified').length + 1);
    assert.ok(after.every(row => !Object.hasOwn(row, 'notes') && !Object.hasOwn(row, 'activity') && !Object.hasOwn(row, 'provenance') && !Object.hasOwn(row, 'owner_id') && Object.hasOwn(row, 'audit_attempt_status')));
    const attributes = (await db.query<{ stable: boolean; invoker: boolean }>("select provolatile='s' as stable,not prosecdef as invoker from pg_proc where oid='public.lead_management_snapshot()'::regprocedure")).rows[0]!;
    assert.deepEqual(attributes, { stable: true, invoker: true });
    await asUser(b);
    assert.deepEqual(await snapshot(), []);
    await db.exec("insert into public.leads(business_name,source) values ('Own B','OSM')");
    assert.equal((await snapshot()).length, 1);
    await asUser(a);
    await db.exec("insert into public.leads(business_name,source) select 'Cap '||i,'CSV' from generate_series(1,1800) as i");
    assert.equal((await snapshot()).length, 2001, 'Overflow sentinel is bounded, never silently truncated to the accepted cap.');
  } finally { await db.close(); }
});
