import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedOverpassEndpoints, defaultOsmEndpoints, osmEndpoints, OsmAdapter } from '../apps/api/src/discovery/adapters/osm.js';
import { starterNiches } from '../apps/api/src/discovery/config.js';
import { ProviderGuard, type Usage, type UsageStore } from '../apps/api/src/discovery/usage.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';

const query = { country: 'GB', city: 'Bath', niche: 'dentists' };
const json = (value: unknown) => new Response(JSON.stringify(value));
const place = () => json([{ boundingbox: ['51','51.1','-1','-0.9'], address: { country_code: 'gb' }, display_name: 'Bath' }]);
const businesses = () => json({ elements: [{ id: 1, type: 'node', tags: { name: 'Mapped dentist', amenity: 'dentist', 'contact:website': 'https://example.com', custom: 'preserved' } }] });
function fixture(handler: (url: string, init: RequestInit | undefined) => Promise<Response>, count = 0) {
  let time = Date.parse('2026-10-02T12:00:00Z');
  let usage: Usage = count ? { OSM: { period: '2026-10-02', count, lastCall: time - 20000 } } : {};
  const waits: number[] = [], calls: { url: string; time: number; init: RequestInit | undefined }[] = [];
  const store: UsageStore = { load: async () => structuredClone(usage), save: async next => { usage = structuredClone(next); } };
  const guard = new ProviderGuard(store, 50, () => time);
  const adapter = new OsmAdapter(starterNiches, async (input, init) => {
    calls.push({ url: String(input), time, init }); return handler(String(input), init);
  }, defaultOsmEndpoints, { now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, reserveRetry: () => guard.reserveOsmRetry() });
  return { adapter, guard, store, waits, calls, advance: (ms: number) => { time += ms; }, now: () => time,
    run: (key = 'Bath', value = query) => guard.run('OSM', key, () => adapter.collect(value)) };
}

test('OSM endpoint configuration is bounded to approved HTTPS instances, including legacy preference', () => {
  assert.deepEqual(osmEndpoints({}).overpass, approvedOverpassEndpoints);
  assert.deepEqual(osmEndpoints({ OSM_OVERPASS_URL: approvedOverpassEndpoints[1] }).overpass, [...approvedOverpassEndpoints].reverse());
  assert.deepEqual(osmEndpoints({ OSM_OVERPASS_URLS: approvedOverpassEndpoints.join(',') }).overpass, approvedOverpassEndpoints);
  assert.throws(() => osmEndpoints({ OSM_OVERPASS_URL: approvedOverpassEndpoints[0], OSM_OVERPASS_URLS: approvedOverpassEndpoints[1] }));
  for (const overpass of [[], ['http://localhost/'], ['https://example.com/'], [approvedOverpassEndpoints[0] + '?token=fixture'], [approvedOverpassEndpoints[0], approvedOverpassEndpoints[0]], [...approvedOverpassEndpoints, approvedOverpassEndpoints[0]]]) {
    assert.throws(() => new OsmAdapter(starterNiches, fetch, { nominatim: defaultOsmEndpoints.nominatim, overpass }));
  }
});

test('Overpass connection failure falls back once, charges durable allowance, and caches unchanged results', async () => {
  const f = fixture(async url => url.includes('nominatim') ? place() : url === approvedOverpassEndpoints[0]
    ? Promise.reject(new Error('secret fixture', { cause: { code: 'ECONNREFUSED' } })) : businesses());
  const found = await f.run();
  assert.equal(found.value.records[0]?.sourceId, 'node/1');
  assert.equal((found.value.records[0]?.metadata.tags as Record<string, string>).custom, 'preserved');
  assert.deepEqual(f.calls.slice(1).map(call => call.url), approvedOverpassEndpoints);
  assert.deepEqual(f.waits, [15000]);
  assert.equal((await f.store.load()).OSM?.count, 2);
  assert.equal((await f.run()).cached, true);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.store.load()).OSM?.count, 2);
  // A new process/guard sees the same stored attempts and enforces the cap.
  const restarted = new ProviderGuard(f.store, 50, f.now);
  await assert.rejects(restarted.run('OSM', 'new', async () => businesses()), error => error instanceof RequestError && error.status === 429);
  for (const call of f.calls) {
    assert.match(new Headers(call.init?.headers).get('user-agent') || '', /^iGetJobs\/1\.0 .*github\.com\/london160771\/iGetJobs/);
    assert.equal(call.init?.redirect, 'error'); assert.ok(call.init?.signal);
  }
});

test('429 honors Retry-After, charges retries, and shares geocoder cooldown across cities', async () => {
  let cityCalls = 0;
  const f = fixture(async url => url.includes('nominatim') ? ++cityCalls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '45' } }) : place() : businesses());
  await f.run(); assert.deepEqual(f.waits, [45000]); assert.equal(cityCalls, 2); assert.equal((await f.store.load()).OSM?.count, 2);
  const blocked = fixture(async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } }));
  await assert.rejects(blocked.run(), error => error instanceof RequestError && error.status === 429);
  blocked.advance(20000);
  await assert.rejects(blocked.run('Other', { ...query, city: 'Other' }), /cooling down/);
  assert.equal(blocked.calls.length, 1); assert.equal(blocked.waits.length, 0);
});

test('transient Overpass HTTP failures and endpoint refusals use only one bounded fallback', async () => {
  for (const status of [429,500,502,503,504,403,404]) {
    const f = fixture(async url => url.includes('nominatim') ? place() : url === approvedOverpassEndpoints[0] ? new Response('', { status }) : businesses());
    await f.run(); assert.equal(f.calls.length, 3); assert.equal(f.waits[0], status === 429 ? 30000 : 15000);
  }
  const failed = fixture(async url => url.includes('nominatim') ? place() : new Response('', { status: 503 }));
  await assert.rejects(failed.run(), /business search/); assert.equal(failed.calls.length, 3); assert.equal((await failed.store.load()).OSM?.count, 2);
});

test('permanent query errors, invalid JSON, TLS failure, and exhausted quota never cause another request', async () => {
  for (const response of [() => new Response('', { status: 400 }), () => new Response('', { status: 401 }), () => new Response('invalid'),
    () => Promise.reject(new Error('private detail', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }))]) {
    const f = fixture(async url => url.includes('nominatim') ? place() : response());
    await assert.rejects(f.run()); assert.equal(f.calls.length, 2); assert.equal(f.waits.length, 0);
  }
  const capped = fixture(async url => url.includes('nominatim') ? place() : new Response('', { status: 503 }), 29);
  await assert.rejects(capped.run(), error => error instanceof RequestError && error.status === 429);
  assert.equal(capped.calls.length, 2); assert.equal((await capped.store.load()).OSM?.count, 30);
  const adapter = new OsmAdapter(starterNiches, async () => new Response('', { status: 503 }));
  await assert.rejects(adapter.collect(query)); // No configured reservation hook: fail closed.
});

test('geocoding coalesces identical cities, caches seven days across niches, and spaces distinct cities', async () => {
  const f = fixture(async url => url.includes('nominatim') ? place() : businesses());
  await Promise.all([f.adapter.collect(query), f.adapter.collect({ ...query, city: '  BATH  ', niche: 'gyms' })]);
  assert.equal(f.calls.filter(call => call.url.includes('nominatim')).length, 1);
  f.advance(6 * 86400000);
  await f.adapter.collect({ ...query, niche: 'gyms' });
  assert.equal(f.calls.filter(call => call.url.includes('nominatim')).length, 1);
  await Promise.all(['Other','Another'].map(city => f.adapter.collect({ ...query, city })));
  const cities = f.calls.filter(call => call.url.includes('nominatim'));
  assert.ok(cities[2]!.time - cities[1]!.time >= 1000);
  f.advance(2 * 86400000); await f.adapter.collect(query);
  assert.equal(f.calls.filter(call => call.url.includes('nominatim')).length, 4);
});
