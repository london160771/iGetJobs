import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Lead } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeLead, sanitizeMetadata } from '../apps/api/src/discovery/normalize.js';
import { duplicateCheck } from '../apps/api/src/discovery/dedupe.js';
import { CsvAdapter } from '../apps/api/src/discovery/adapters/csv.js';
import { OsmAdapter } from '../apps/api/src/discovery/adapters/osm.js';
import { SerpApiAdapter } from '../apps/api/src/discovery/adapters/serpapi.js';
import { starterNiches, discoveryOptions } from '../apps/api/src/discovery/config.js';
import { ProviderGuard, type UsageStore } from '../apps/api/src/discovery/usage.js';
import { DiscoveryService } from '../apps/api/src/discovery/service.js';
import type { LeadRepository } from '../apps/api/src/discovery/repository.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { createApp } from '../apps/api/src/app.js';

function memoryUsage() {
  let value: Awaited<ReturnType<UsageStore['load']>> = {};
  const store: UsageStore = { load: async () => structuredClone(value), save: async next => { value = structuredClone(next); } };
  return store;
}
const normalized = (name = 'Test Dental', address = '1 Main Street') => normalizeLead({ businessName: name, country: 'US', city: 'Boston', address, website: 'example.com', sourceId: null, metadata: { custom: 'preserved' } }, 'CSV').lead;
const errorStatus = (status: number) => (error: unknown) => error instanceof RequestError && error.status === status;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('lead normalization preserves provenance, normalizes contacts, and leaves audits/scores unprocessed', () => {
  const value = normalizeLead({ businessName: '  Test Dental  ', country: 'us', phone: '(415) 555-2671', website: 'WWW.Example.COM/team', email: ' HELLO@Example.com ', rating: '4.5', reviewCount: '1,234', sourceId: 'place-1', metadata: { arbitrary: { field: 'preserved' }, api_key: 'private-test-key', url: 'https://example.com/?api_key=private-test-key&record=1' } }, 'SERPAPI');
  assert.equal(value.lead.businessName, 'Test Dental');
  assert.equal(value.lead.phone, '+14155552671');
  assert.equal(value.lead.domain, 'example.com');
  assert.equal(value.lead.email, 'hello@example.com');
  assert.equal(value.lead.reviewCount, 1234);
  assert.equal(value.lead.rating, 4.5);
  assert.deepEqual(value.lead.provenance[0]?.metadata, { arbitrary: { field: 'preserved' }, url: 'https://example.com/?record=1' });
  for (const key of ['audit', 'classification', 'score', 'outreachDraft'] as const) assert.equal(value.lead[key], null);
  const invalid = normalizeLead({ businessName: 'Unsafe contact', website: 'javascript:alert(1)', phone: '123', email: 'bad', rating: 'Infinity', reviewCount: '-1', sourceId: null, metadata: {} }, 'CSV');
  assert.equal(invalid.lead.website, null); assert.equal(invalid.lead.phone, null); assert.equal(invalid.lead.email, null); assert.equal(invalid.lead.rating, null); assert.equal(invalid.lead.reviewCount, null);
  assert.equal(invalid.warnings.length, 3);
  assert.deepEqual(sanitizeMetadata({ auth: { password: 'private', allowed: 1 }, link: 'https://user:pass@example.com/' }), { auth: { allowed: 1 }, link: 'https://example.com/' });
});

test('CSV parsing handles BOM, quoting, multiline fields, stable row IDs, and bounded imports', () => {
  const adapter = new CsvAdapter();
  const csv = '\uFEFFbusinessName,country,address,phone,extra\r\n"Dental, One",UK,"Line 1\nLine 2",020 7946 0018,original\r\n';
  const first = adapter.collect(csv, 'first.csv');
  const second = adapter.collect(csv, 'second.csv');
  assert.equal(first.records[0]?.businessName, 'Dental, One');
  assert.equal(first.records[0]?.country, 'GB');
  assert.equal(first.records[0]?.address, 'Line 1\nLine 2');
  assert.equal(first.records[0]?.sourceId, second.records[0]?.sourceId);
  assert.deepEqual(first.records[0]?.metadata.fields, { businessName: 'Dental, One', country: 'UK', address: 'Line 1\nLine 2', phone: '020 7946 0018', extra: 'original' });
  assert.throws(() => adapter.collect('name,business_name\nA,B', 'bad.csv'), errorStatus(400));
  assert.throws(() => adapter.collect('name,name\nA,B', 'bad.csv'), errorStatus(400));
  assert.throws(() => adapter.collect('name\n"unterminated', 'bad.csv'), errorStatus(400));
  assert.throws(() => adapter.collect('name\n' + 'A\n'.repeat(201), 'large.csv'), errorStatus(400));
  assert.throws(() => adapter.collect('name\n' + 'a'.repeat(41 * 1024), 'large.csv'), errorStatus(413));
});

test('dedupe prioritizes domain/phone/name-address evidence and does not treat shared contacts as certain', () => {
  const existing = normalized();
  assert.equal(duplicateCheck(normalized('Other branch', '9 Other Street'), [existing]).kind, 'possible');
  const exact = duplicateCheck(normalized(), [existing]);
  assert.equal(exact.kind, 'exact'); assert.equal(exact.canLink, true);
  assert.deepEqual(exact.reasons, ['Matching domain']);
  assert.equal(duplicateCheck({ ...normalized(), address: null, domain: null, phone: null }, [{ ...existing, address: null, domain: null, phone: null }]).kind, 'new');
  assert.equal(duplicateCheck(normalized(), [existing, normalized()]).canLink, false);
  assert.equal(duplicateCheck({ ...normalized(), sourceId: 'stable', address: 'changed' }, [{ ...existing, sourceId: 'stable' }]).kind, 'possible');
  assert.equal(duplicateCheck({ ...normalized(), domain: null, phone: '+14155552671', address: null }, [{ ...existing, domain: null, phone: '+14155552671', address: null }]).kind, 'possible');
});

test('OSM uses country-constrained cached city lookup, bounded Overpass queries, and retains raw tags', async () => {
  const requests: { url: string; body: string }[] = [];
  const adapter = new OsmAdapter(starterNiches, async (input, init) => {
    const url = String(input); requests.push({ url, body: String(init?.body || '') });
    return url.includes('nominatim') ? json([{ boundingbox: ['51', '51.1', '-1', '-0.9'], display_name: 'Test City', address: { country_code: 'gb' } }])
      : json({ elements: [{ id: 123, type: 'node', center: { lat: 51, lon: -1 }, tags: { name: 'Mapped Dental', amenity: 'dentist', website: 'example.com', 'custom:field': 'kept' } }] });
  });
  const value = await adapter.collect({ country: 'GB', city: 'Test City', niche: 'dentists' });
  assert.equal(value.records[0]?.sourceId, 'node/123');
  assert.equal(value.records[0]?.metadata.tags && (value.records[0].metadata.tags as Record<string, string>)['custom:field'], 'kept');
  assert.ok(requests[0]?.url.includes('countrycodes=gb'));
  assert.equal(new URL(requests[0]!.url).searchParams.get('featureType'), 'city');
  assert.ok(requests[1]?.body.includes('100'));
  await adapter.collect({ country: 'GB', city: 'Test City', niche: 'gyms' });
  assert.equal(requests.filter(item => item.url.includes('nominatim')).length, 1);
  const ambiguous = new OsmAdapter(starterNiches, async () => json([{ display_name: 'One', address: { country_code: 'gb' } }, { display_name: 'Two', address: { country_code: 'gb' } }]));
  await assert.rejects(ambiguous.collect({ country: 'GB', city: 'Ambiguous', niche: 'dentists' }), errorStatus(422));
});

test('SerpAPI fails closed for non-free/unverifiable/exhausted plans and never forwards provider secrets', async () => {
  const account = { plan_name: 'Free Plan', plan_monthly_price: 0, account_status: 'Active', plan_searches_left: 10, this_hour_searches: 0, account_rate_limit_per_hour: 10 };
  let calls = 0;
  const adapter = new SerpApiAdapter('private-test-key', starterNiches, async input => { calls++; return String(input).includes('account.json') ? json(account) : json({ local_results: [{ title: 'Dental', place_id: 'place-1', website: 'example.com' }], serpapi_pagination: { next: 'unused' } }); });
  const result = await adapter.collect({ country: 'US', city: 'Boston', niche: 'dentists' });
  assert.equal(calls, 2); assert.equal(result.records[0]?.sourceId, 'place-1');
  for (const response of [{ ...account, plan_monthly_price: 25 }, { ...account, plan_name: undefined }, { ...account, plan_searches_left: 0 }]) {
    let searches = 0;
    const blocked = new SerpApiAdapter('private-test-key', starterNiches, async input => { if (String(input).includes('search.json')) searches++; return json(response); });
    await assert.rejects(blocked.collect({ country: 'US', city: 'Boston', niche: 'dentists' }));
    assert.equal(searches, 0);
  }
  const unavailable = new SerpApiAdapter('private-test-key', starterNiches, async () => { throw new Error('https://serpapi.com/?api_key=private-test-key'); });
  await assert.rejects(unavailable.collect({ country: 'US', city: 'Boston', niche: 'dentists' }), error => error instanceof RequestError && !error.message.includes('private-test-key') && !error.message.includes('http'));
  assert.throws(() => discoveryOptions({ DISCOVERY_NICHES_JSON: JSON.stringify([{ id: 'bad', label: 'Bad', tags: [['name', '"injection']] }]) }));
});

test('provider guards cache results, reserve attempts, retain quotas across restarts, and fail closed on storage errors', async () => {
  let now = Date.parse('2026-10-01T12:00:00Z');
  const store = memoryUsage(); const guard = new ProviderGuard(store, 2, () => now);
  let calls = 0;
  const collect = async () => { calls++; return { records: [1] }; };
  assert.equal((await guard.run('OSM', 'one', collect)).cached, false);
  const cached = await guard.run('OSM', 'one', collect);
  assert.equal(cached.cached, true); cached.value.records.push(2);
  assert.deepEqual((await guard.run('OSM', 'one', collect)).value.records, [1]);
  await assert.rejects(guard.run('OSM', 'two', collect), errorStatus(429));
  now += 16000; await guard.run('OSM', 'two', collect); assert.equal(calls, 2);
  await guard.run('SERPAPI', 'serp-one', collect); now += 6000;
  await new ProviderGuard(store, 2, () => now).run('SERPAPI', 'serp-two', collect); now += 6000;
  await assert.rejects(new ProviderGuard(store, 2, () => now).run('SERPAPI', 'serp-three', collect), errorStatus(429));
  const broken = new ProviderGuard({ load: async () => ({}), save: async () => { throw new RequestError(503, 'Storage failed'); } });
  let sent = false;
  await assert.rejects(broken.run('OSM', 'blocked', async () => { sent = true; return {}; }), errorStatus(503));
  assert.equal(sent, false);
});

function memoryService() {
  const rows = new Map<string, Lead[]>();
  const repository = (owner: string): LeadRepository => {
    if (!rows.has(owner)) rows.set(owner, []);
    return {
      identities: async () => structuredClone(rows.get(owner)!), list: async () => structuredClone(rows.get(owner)!),
      insert: async lead => { rows.get(owner)!.push(structuredClone(lead)); return lead; },
      link: async (id, provenance) => { const lead = rows.get(owner)!.find(item => item.id === id)!; lead.provenance.push(...provenance); return lead; }
    };
  };
  return { rows, service: new DiscoveryService({}, repository, new ProviderGuard(memoryUsage())) };
}

test('server previews prevent ownership/mass-assignment, require duplicate review, retain metadata and support idempotent retry', async () => {
  const { service, rows } = memoryService();
  const csv = 'name,country,city,address,website,custom\nOne,US,Boston,1 Main Street,example.com,original\nTwo,US,Boston,2 Main Street,example.com,second';
  const preview = await service.importCsv('A', 'token-A', { csv, filename: 'fixture.csv', ownerId: 'B', score: 100 });
  assert.equal(preview.rows[0]?.duplicate.kind, 'new'); assert.equal(preview.rows[1]?.duplicate.kind, 'possible');
  await assert.rejects(service.save('B', 'token-B', { previewId: preview.id, selections: [{ id: preview.rows[0]!.lead.id, action: 'save' }] }), errorStatus(410));
  const first = await service.save('A', 'token-A', { previewId: preview.id, selections: preview.rows.map(row => ({ id: row.lead.id, action: 'save' })) });
  assert.deepEqual(first.results.map(item => item.status), ['saved', 'failed']);
  const reviewed = await service.save('A', 'token-A', { previewId: preview.id, selections: [{ id: preview.rows[1]!.lead.id, action: 'separate' }] });
  assert.equal(reviewed.results[0]?.status, 'saved');
  await service.save('A', 'token-A', { previewId: preview.id, selections: [{ id: preview.rows[0]!.lead.id, action: 'save' }] });
  assert.equal(rows.get('A')?.length, 2); assert.equal(rows.get('B')?.length || 0, 0);
  assert.equal(rows.get('A')?.[0]?.score, null);
  assert.equal((rows.get('A')?.[0]?.provenance[0]?.metadata?.fields as Record<string, string>).custom, 'original');
});

test('an explicit exact-match source link retains existing fields and new source metadata', async () => {
  const { service, rows } = memoryService();
  const csv = 'name,address,country,city\nDental,1 Main Street,US,Boston';
  const first = await service.importCsv('A', 'token', { csv, filename: 'one.csv' });
  await service.save('A', 'token', { previewId: first.id, selections: [{ id: first.rows[0]!.lead.id, action: 'save' }] });
  const next = await service.importCsv('A', 'token', { csv, filename: 'two.csv' });
  assert.equal(next.rows[0]?.duplicate.canLink, true);
  const result = await service.save('A', 'token', { previewId: next.id, selections: [{ id: next.rows[0]!.lead.id, action: 'link' }] });
  assert.equal(result.results[0]?.status, 'linked'); assert.equal(rows.get('A')?.length, 1);
  assert.equal(rows.get('A')?.[0]?.businessName, 'Dental'); assert.equal(rows.get('A')?.[0]?.provenance.length, 2);
});

test('discovery API requires verified authentication and scopes previews/saved leads to the verified owner', async () => {
  const { service } = memoryService();
  const client = { auth: { getUser: async (token: string) => ({ data: { user: { id: token === 'token-A' ? 'A' : 'B' } }, error: null }) } } as unknown as SupabaseClient;
  const server = createApp(client, service).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    for (const path of ['/api/leads', '/api/discovery/config']) assert.equal((await fetch(base + path)).status, 401);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer token-A' };
    const response = await fetch(base + '/api/discovery/import', { method: 'POST', headers, body: JSON.stringify({ csv: 'name\nPrivate lead', ownerId: 'B' }) });
    assert.equal(response.status, 200);
    const preview = await response.json() as { id: string; rows: { lead: Lead }[] };
    assert.equal((await fetch(base + '/api/discovery/save', { method: 'POST', headers: { ...headers, Authorization: 'Bearer token-B' }, body: JSON.stringify({ previewId: preview.id, selections: [{ id: preview.rows[0]!.lead.id, action: 'save' }] }) })).status, 410);
    const save = await fetch(base + '/api/discovery/save', { method: 'POST', headers, body: JSON.stringify({ previewId: preview.id, selections: [{ id: preview.rows[0]!.lead.id, action: 'save' }] }) });
    assert.equal(save.status, 200);
    const a = await (await fetch(base + '/api/leads', { headers })).json() as { leads: Lead[] };
    const b = await (await fetch(base + '/api/leads', { headers: { Authorization: 'Bearer token-B' } })).json() as { leads: Lead[] };
    assert.equal(a.leads.length, 1); assert.equal(b.leads.length, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
