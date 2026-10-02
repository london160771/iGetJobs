import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { quotaStore, type QuotaRpc } from '../apps/api/src/quota.js';
import { ProviderGuard } from '../apps/api/src/discovery/usage.js';
import { HunterAdapter } from '../apps/api/src/outreach/hunter.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';

test('actual quota migration enforces atomic caps/cooldowns, survives fresh guards, and denies public/user access', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon noinherit; create role authenticated noinherit; create role service_role noinherit;');
    await db.exec(await readFile('supabase/migrations/202610020005_provider_usage.sql','utf8'));
    const rpc: QuotaRpc = { async rpc(name,input) {
      try {
        const query = name === 'reserve_provider_usage' ? 'select public.reserve_provider_usage($1,$2) as data' : 'select public.provider_usage_status() as data';
        const result = await db.query<{ data:unknown }>(query,input ? [input.p_provider,input.p_limit] : []);
        return { data:result.rows[0]!.data,error:null };
      } catch (error) { return { data:null,error:{ code:(error as { code:string }).code,message:(error as Error).message } }; }
    } };
    await db.exec('set role service_role');
    const initial = quotaStore(rpc); assert.deepEqual(await initial.load(),{});
    let calls = 0;
    const first = new ProviderGuard(initial,2);
    assert.deepEqual(await first.run('SERPAPI','query',async () => { calls++; return 'recorded'; }),{ value:'recorded',cached:false });
    assert.equal((await first.run('SERPAPI','query',async () => { calls++; return 'unused'; })).cached,true);
    assert.equal(calls,1); assert.equal((await initial.load()).SERPAPI!.count,1);
    // New service objects simulate losing every process-local cache/lock on restart.
    const restarted = new ProviderGuard(quotaStore(rpc),2);
    await assert.rejects(restarted.run('SERPAPI','fresh',async () => { calls++; }),error => error instanceof RequestError && error.status === 429);
    assert.equal(calls,1);
    await db.exec("reset role; update public.provider_usage set last_call=clock_timestamp()-interval '6 seconds'; set role service_role");
    await assert.rejects(restarted.run('SERPAPI','failure',async () => { calls++; throw new Error('Provider unavailable'); }));
    assert.equal((await initial.load()).SERPAPI!.count,2); // Failed request still reserved.
    await db.exec("reset role; update public.provider_usage set last_call=clock_timestamp()-interval '6 seconds'; set role service_role");
    await assert.rejects(new ProviderGuard(quotaStore(rpc),2).run('SERPAPI','over-cap',async () => { calls++; }),error => error instanceof RequestError && error.status === 429);
    assert.equal(calls,2);
    // Independent concurrent reservations cannot consume the last allowance twice.
    const concurrent = await Promise.allSettled([quotaStore(rpc).reserve!('OSM',30),quotaStore(rpc).reserve!('OSM',30)]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length,1);
    assert.equal((await initial.load()).OSM!.count,1);
    await db.exec("reset role; update public.provider_usage set period='2000-01',count=999,last_call=clock_timestamp()-interval '6 seconds' where provider='SERPAPI'; set role service_role");
    await initial.reserve!('SERPAPI',2); assert.equal((await initial.load()).SERPAPI!.count,1);
    for (const role of ['anon','authenticated']) {
      await db.exec('reset role; set role ' + role);
      for (const query of ["select public.reserve_provider_usage('OSM',30)",'select public.provider_usage_status()','select * from public.provider_usage',"update public.provider_usage set count=0",'delete from public.provider_usage']) await assert.rejects(db.query(query),error => (error as { code:string }).code === '42501');
    }
    await db.exec('reset role; set role service_role');
    await assert.rejects(db.query('update public.provider_usage set count=0'),error => (error as { code:string }).code === '42501');
    await assert.rejects(initial.reserve!('HUNTER',51),error => error instanceof RequestError && error.status === 503);
  } finally { await db.close(); }
});

test('database quota failure blocks provider I/O, rejects non-atomic saves, and Hunter reserves before lookup', async () => {
  let calls = 0, reserved = 0;
  const failed = quotaStore({ rpc:async () => ({ data:null,error:{ code:'unexpected',message:'private database detail fixture-secret' } }) });
  const guard = new ProviderGuard(failed);
  await assert.rejects(guard.run('OSM','blocked',async () => { calls++; }),error => error instanceof RequestError && error.status === 503 && !error.message.includes('fixture-secret'));
  assert.equal(calls,0); await assert.rejects(failed.save({}),/atomically/);
  const store = quotaStore({ rpc:async (name,input) => {
    assert.equal(name,'reserve_provider_usage'); assert.deepEqual(input,{ p_provider:'HUNTER',p_limit:10 }); reserved++;
    return { data:{ count:reserved,period:'2026-10',lastCall:1 },error:null };
  } });
  const transport = (async input => {
    assert.equal(reserved,1); calls++;
    return new Response(JSON.stringify({ data:String(input).endsWith('/account') ? { plan_name:'Free',requests:{ credits:{ remaining:10,available:50 } } } : { domain:'fixture.com',emails:[] } }));
  }) as typeof fetch;
  const hunter = new HunterAdapter('fixture-secret',store,10,transport);
  assert.deepEqual(await hunter.lookup('fixture.com'),{ state:'no_result' }); assert.equal(calls,2); assert.equal(reserved,1);
});
