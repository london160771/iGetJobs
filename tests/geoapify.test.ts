import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoapifyAdapter, geoapifyCategories } from '../apps/api/src/discovery/adapters/geoapify.js';
import { starterNiches, discoveryOptions } from '../apps/api/src/discovery/config.js';
import { normalizeLead } from '../apps/api/src/discovery/normalize.js';
import { duplicateCheck } from '../apps/api/src/discovery/dedupe.js';
import { ProviderGuard, type Usage, type UsageStore } from '../apps/api/src/discovery/usage.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';
import { resolveWebsiteEvidence } from '../apps/api/src/website-safety.js';

const query = { country: 'GB', city: 'Bath', niche: 'dentists' };
const feature = (id: string, properties: Record<string, unknown> = {}) => ({ type: 'Feature', properties: { place_id: id, country_code: 'gb', ...properties }, geometry: { type: 'Point', coordinates: [-2.35, 51.38] } });
const json = (items: unknown[]) => new Response(JSON.stringify({ type: 'FeatureCollection', features: items }));
function runtime() {
  let clock = Date.parse('2026-10-02T10:00:00Z'), reservations = 0;
  return { now: () => clock, sleep: async (ms: number) => { clock += ms; }, reserveNext: async () => { reservations++; }, count: () => reservations };
}

test('Geoapify category mapping is explicit for every starter niche and active sources exclude OSM', () => {
  assert.deepEqual(Object.keys(geoapifyCategories), starterNiches.map(item => item.id));
  assert.deepEqual(geoapifyCategories.dentists, ['healthcare.dentist']);
  assert.deepEqual(geoapifyCategories['law-firms'], ['office.lawyer']);
  for (const categories of Object.values(geoapifyCategories)) assert.ok(categories.length > 0 && categories.length <= 5);
  const config = discoveryOptions({ GEOAPIFY_API_KEY: 'fixture-key' }).config;
  assert.deepEqual(config.sources.map(item => [item.id, item.available]), [['GEOAPIFY', true], ['SERPAPI', false]]);
  assert.throws(() => discoveryOptions({ DISCOVERY_NICHES_JSON: JSON.stringify([{ ...starterNiches[0], geoapifyCategories: ['https://internal/'] }]) }));
});

test('Geoapify normalizes contacts/coordinates, preserves sanitized provenance and dedupes across providers', async () => {
  let calls = 0;
  const adapter = new GeoapifyAdapter('fixture-key', starterNiches, (async input => {
    const url = new URL(String(input)); calls++;
    if (calls === 1) { assert.equal(url.searchParams.get('filter'), 'countrycode:gb'); assert.equal(url.searchParams.get('type'), 'city'); return json([feature('city')]); }
    assert.equal(url.pathname, '/v2/places'); assert.equal(url.searchParams.get('filter'), 'place:city');
    return json([feature('dental', { name: 'Bath Dental', city: 'Bath', formatted: '1 Main Street, Bath', contact: { phone: '+44 20 7946 0018', email: 'HELLO@EXAMPLE.COM', website: '//example.com/?api_key=fixture-credential' }, datasource: { raw: { website: 'https://example.com/?token=fixture-credential', 'contact:phone': 'raw preserved' } } }), feature('missing', { name: 'No Contact Dental' })]);
  }) as typeof fetch, runtime());
  const result = await adapter.collect(query);
  const lead = normalizeLead(result.records[0]!, 'GEOAPIFY').lead;
  assert.equal(lead.source, 'GEOAPIFY'); assert.equal(lead.sourceId, 'dental'); assert.equal(lead.phone, '+442079460018'); assert.equal(lead.email, 'hello@example.com'); assert.equal(lead.domain, 'example.com');
  assert.equal(lead.provenance[0]!.metadata!.latitude, 51.38); assert.equal(lead.provenance[0]!.metadata!.longitude, -2.35);
  assert.ok(!JSON.stringify(lead).includes('fixture-credential'));
  assert.equal(resolveWebsiteEvidence(lead).candidates.length, 1);
  const missing = normalizeLead(result.records[1]!, 'GEOAPIFY').lead;
  assert.equal(missing.website, null); assert.equal(missing.phone, null); assert.equal(missing.email, null);
  for (const source of ['CSV', 'SERPAPI'] as const) assert.equal(duplicateCheck(lead, [{ ...lead, id: 'existing', source, sourceId: 'other-source' }]).kind, 'exact');
});

test('Geoapify bounds pagination and charges every request; city and result caches avoid repeat lookup', async () => {
  const time = runtime(); let geocodes = 0, pages = 0, usage: Usage = {};
  const store: UsageStore = { load: async () => structuredClone(usage), save: async next => { usage = structuredClone(next); } };
  const guard = new ProviderGuard(store, 50, time.now, 100);
  const adapter = new GeoapifyAdapter('fixture-key', starterNiches, (async input => {
    const url = new URL(String(input));
    if (url.pathname.includes('geocode')) { geocodes++; return json([feature('city')]); }
    assert.equal(url.searchParams.get('limit'), '20'); assert.equal(url.searchParams.get('offset'), String(pages++ * 20));
    return json(Array.from({ length: 20 }, (_, i) => feature('place-' + (pages * 20 + i), { name: 'Dental ' + i })));
  }) as typeof fetch, { ...time, reserveNext: () => guard.reserveGeoapifyRequest() });
  const first = await guard.run('GEOAPIFY', 'first', () => adapter.collect(query));
  assert.equal(first.value.records.length, 100); assert.equal(pages, 5); assert.equal(geocodes, 1); assert.equal(usage.GEOAPIFY!.count, 6);
  assert.ok(first.value.warnings.some(value => value.includes('100')));
  assert.equal((await guard.run('GEOAPIFY', 'first', () => adapter.collect(query))).cached, true); assert.equal(usage.GEOAPIFY!.count, 6);
  await time.sleep(5000); pages = 0;
  await guard.run('GEOAPIFY', 'second', () => adapter.collect({ ...query, niche: 'salons' }));
  assert.equal(geocodes, 1); assert.equal(usage.GEOAPIFY!.count, 11);
});

test('Geoapify quota exhaustion fails closed before later pages and fresh guards cannot reset daily usage', async () => {
  const time = runtime(); let calls = 0, usage: Usage = {};
  const store: UsageStore = { load: async () => structuredClone(usage), save: async next => { usage = structuredClone(next); } };
  const guard = new ProviderGuard(store, 50, time.now, 2);
  const adapter = new GeoapifyAdapter('fixture-key', starterNiches, (async () => { calls++; return calls === 1 ? json([feature('city')]) : json(Array.from({ length: 20 }, (_, i) => feature('place-' + i, { name: 'Dental' }))); }) as typeof fetch, { ...time, reserveNext: () => guard.reserveGeoapifyRequest() });
  await assert.rejects(guard.run('GEOAPIFY', 'first', () => adapter.collect(query)), error => error instanceof RequestError && error.status === 429);
  assert.equal(calls, 2); assert.equal(usage.GEOAPIFY!.count, 2);
  await time.sleep(5000);
  await assert.rejects(new ProviderGuard(store, 50, time.now, 2).run('GEOAPIFY', 'restart', async () => { calls++; })); assert.equal(calls, 2);
  await time.sleep(86400000);
  await new ProviderGuard(store, 50, time.now, 2).run('GEOAPIFY', 'tomorrow', async () => 'allowed'); assert.equal(usage.GEOAPIFY!.count, 1);
  assert.throws(() => new ProviderGuard(store, 50, time.now, 1001));
});

test('Geoapify 429/transient failures have one charged backoff retry; permanent/malformed failures are not retried', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let calls = 0; const time = runtime(), starts: number[] = [];
    const adapter = new GeoapifyAdapter('fixture-key', starterNiches, (async () => { starts.push(time.now()); calls++; return calls === 1 ? new Response('private-fixture', { status, headers: { 'Retry-After': '12' } }) : calls === 2 ? json([feature('city')]) : json([]); }) as typeof fetch, time);
    assert.equal((await adapter.collect(query)).records.length, 0); assert.equal(calls, 3); assert.equal(time.count(), 2); assert.ok(starts[1]! - starts[0]! >= 12000);
  }
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const adapter = new GeoapifyAdapter('fixture-key', starterNiches, (async () => { calls++; return new Response('fixture-key', { status }); }) as typeof fetch, runtime());
    await assert.rejects(adapter.collect(query), error => error instanceof RequestError && !error.message.includes('fixture-key')); assert.equal(calls, 1);
  }
  for (const body of [{ features: [] }, { type: 'FeatureCollection', features: [feature('bad', { place_id: null })] }, { type: 'FeatureCollection', features: [{ ...feature('bad'), geometry: { type: 'Point', coordinates: [0, 999] } }] }]) {
    let calls = 0;
    await assert.rejects(new GeoapifyAdapter('fixture-key', starterNiches, (async () => { calls++; return new Response(JSON.stringify(body)); }) as typeof fetch, runtime()).collect(query), /Geoapify returned/); assert.equal(calls, 1);
  }
});

test('Geoapify timeouts/connection failures are bounded and do not expose keys', async () => {
  for (const timeout of [false, true]) {
    let calls = 0; const time = runtime();
    const transport = (async (_input, init) => {
      calls++;
      if (!timeout) throw new Error('fixture-key', { cause: { code: 'ECONNRESET' } });
      return await new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Test timeout safeguard')), 1000);
        init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('fixture-key', 'TimeoutError')); }, { once: true });
      });
    }) as typeof fetch;
    await assert.rejects(new GeoapifyAdapter('fixture-key', starterNiches, transport, { ...time, timeoutMs: 5 }).collect(query), error => error instanceof RequestError && error.status === 502 && !error.message.includes('fixture-key'));
    assert.equal(calls, 2); assert.equal(time.count(), 1);
  }
});

test('Geoapify rejects ambiguous cities and preserves conflicting/malformed website evidence for review', async () => {
  const ambiguous = new GeoapifyAdapter('fixture-key', starterNiches, (async () => json([feature('city-a'), feature('city-b')])) as typeof fetch, runtime());
  await assert.rejects(ambiguous.collect(query), /Several cities/);
  let calls = 0;
  const result = await new GeoapifyAdapter('fixture-key', starterNiches, (async () => ++calls === 1 ? json([feature('city')]) : json([feature('dental', { name: 'Dental', website: ['https://one.example/', 'https://two.example/'], contact: { website: 'https://three.example/' } })])) as typeof fetch, runtime()).collect(query);
  const evidence = resolveWebsiteEvidence(normalizeLead(result.records[0]!, 'GEOAPIFY').lead);
  assert.equal(evidence.candidates.length, 3);
  await assert.rejects(new GeoapifyAdapter(null, starterNiches).collect(query), /not configured/);
  await assert.rejects(new GeoapifyAdapter('fixture-key', [{ id: 'custom', label: 'Custom', tags: [['shop', 'test']] }]).collect({ ...query, niche: 'custom' }), /no Geoapify category/);
});
