import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../apps/api/src/app.js';
import { prepareProduction, usageDirectory, verifiedHunterKey } from '../apps/api/src/production.js';
import { supabaseUsageStore } from '../apps/api/src/quota.js';
import { createOutreachService } from '../apps/api/src/outreach/service.js';
import { ProviderGuard, type UsageStore } from '../apps/api/src/discovery/usage.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';

test('production requires Supabase quota storage and HTTPS public configuration, with no filesystem fallback', async () => {
    const env = { NODE_ENV:'production', SUPABASE_URL:'https://fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture' };
    assert.throws(() => usageDirectory({ NODE_ENV:'production' }), /Supabase/);
    assert.throws(() => usageDirectory({ USAGE_DIRECTORY:'relative-path' }), /absolute/);
    await assert.rejects(prepareProduction({ ...env, SUPABASE_URL:'http://fixture.supabase.co' }), /HTTPS/);
    await assert.rejects(prepareProduction({ NODE_ENV:'production' }), /configuration/);
    await assert.rejects(prepareProduction(env), /SUPABASE_QUOTA_SERVICE_KEY/);
    assert.throws(() => supabaseUsageStore({ ...env,SUPABASE_QUOTA_SERVICE_KEY:'sb_publishable_fixture' }), /server-only/);
});

test('production starts through a quota-status outage and provider lookups still fail closed on reservation failure', async () => {
  const env = {
    NODE_ENV:'production',
    SUPABASE_URL:'https://fixture.supabase.co',
    SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',
    SUPABASE_QUOTA_SERVICE_KEY:'sb_secret_fixture'
  };
  let statusReads = 0, reservations = 0, providerLookups = 0;
  const store: UsageStore = {
    async load() {
      statusReads++;
      throw new RequestError(503,'Simulated provider_usage_status outage.');
    },
    async save() { throw new RequestError(503,'Provider usage must be reserved atomically.'); },
    async reserve() {
      reservations++;
      throw new RequestError(503,'Provider usage protection is unavailable. No lookup was made.');
    }
  };
  await prepareProduction(env, () => store);
  assert.equal(statusReads,0,'Startup must not depend on provider_usage_status availability.');
  const guard = new ProviderGuard(store);
  for (const provider of ['SERPAPI','GEOAPIFY'] as const) {
    await assert.rejects(guard.run(provider,'startup-test-' + provider,async () => { providerLookups++; }),error => error instanceof RequestError && error.status === 503);
  }
  assert.equal(reservations,2);
  assert.equal(providerLookups,0,'A provider adapter must not run without a confirmed durable reservation.');
});

test('a Hunter key alone cannot enable lookup; operator verification and live provider guards are separate', () => {
  const key = 'fixture-server-secret';
  for (const flag of [undefined, 'false', 'TRUE', 'yes']) {
    assert.equal(verifiedHunterKey({ HUNTER_API_KEY:key, HUNTER_FREE_PLAN_VERIFIED:flag }),null);
    assert.equal(createOutreachService({ HUNTER_API_KEY:key, HUNTER_FREE_PLAN_VERIFIED:flag }).hunter.configured,false);
  }
  assert.equal(verifiedHunterKey({ HUNTER_FREE_PLAN_VERIFIED:'true' }),null);
  assert.equal(verifiedHunterKey({ HUNTER_API_KEY:key, HUNTER_FREE_PLAN_VERIFIED:'true' }),key);
});

test('production serves SPA routes securely, caches only built assets, and never turns API/asset errors into HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(),'igetjobs-web-'));
  let server;
  try {
    await mkdir(join(directory,'assets'));
    await writeFile(join(directory,'index.html'),'<html><body>Fixture app</body></html>');
    await writeFile(join(directory,'assets','index-Fixture12.js'),'export const fixture = true;');
    await writeFile(join(directory,'.env'),'must-not-be-served');
    server = createApp(null,undefined,undefined,undefined,undefined,{ directory, supabaseUrl:'https://fixture.supabase.co' }).listen(0,'127.0.0.1');
    await once(server,'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const route = await fetch(base + '/leads/fixture',{ headers:{ Accept:'text/html' } });
    assert.equal(route.status,200); assert.match(await route.text(),/Fixture app/);
    assert.match(route.headers.get('content-security-policy')!,/connect-src 'self' https:\/\/fixture.supabase.co/);
    assert.doesNotMatch(route.headers.get('content-security-policy')!,/unsafe-inline|unsafe-eval/);
    assert.equal(route.headers.get('x-frame-options'),'DENY');
    assert.equal(route.headers.get('x-content-type-options'),'nosniff');
    assert.equal(route.headers.get('cache-control'),'no-store');
    assert.match((await fetch(base + '/assets/index-Fixture12.js')).headers.get('cache-control')!,/immutable/);
    for (const path of ['/api/missing','/assets/missing.js','/.env','/missing.css']) {
      const missing = await fetch(base + path,{ headers:{ Accept:'text/html' } });
      assert.equal(missing.status,404); assert.doesNotMatch(await missing.text(),/Fixture app|must-not-be-served/);
    }
    assert.equal((await fetch(base + '/api/outreach')).status,401);
    assert.equal((await fetch(base + '/api/health')).headers.get('cache-control'),'no-store');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(directory,{ recursive:true,force:true });
  }
});
