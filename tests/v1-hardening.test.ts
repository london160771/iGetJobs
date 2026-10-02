import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Session, User, SupabaseClient } from '@supabase/supabase-js';
import { AuthSession, type AuthState, type Verification } from '../apps/web/src/lib/auth-session.js';
import { approvedProviderUsers } from '../apps/api/src/provider-access.js';
import { createApp } from '../apps/api/src/app.js';
import type { DiscoveryService } from '../apps/api/src/discovery/service.js';
import type { OutreachService } from '../apps/api/src/outreach/service.js';
import { SupabaseLeadRepository } from '../apps/api/src/discovery/repository.js';
import { RequestError } from '../apps/api/src/discovery/errors.js';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const user = (id: string) => ({ id } as User);
const session = (id: string) => ({ user: user(id), access_token: 'fixture-token' } as Session);
function deferred() { let resolve!: (result: Verification) => void; const promise = new Promise<Verification>(done => { resolve = done; }); return { promise, resolve }; }

test('same-user refresh/revalidation retains verified identity and never gates the workspace as loading', async () => {
  const states: AuthState[] = [], pending = deferred();
  const controller = new AuthSession({ user: user(a), loading: false, error: null }, state => states.push(state), () => pending.promise);
  const verifying = controller.verify(session(a));
  assert.equal(states[0]?.user?.id, a); assert.equal(states[0]?.loading, false);
  pending.resolve({ user: user(a), unavailable: false }); await verifying;
  assert.ok(states.every(state => state.user?.id === a && !state.loading));
});
test('initial or switched identity remains protected until verified; invalid credentials discard identity', async () => {
  const states: AuthState[] = [], pending = deferred();
  const controller = new AuthSession({ user: user(a), loading: false, error: null }, state => states.push(state), () => pending.promise);
  const switching = controller.verify(session(b));
  assert.equal(states[0]?.user, null); assert.equal(states[0]?.loading, true);
  pending.resolve({ user: user(b), unavailable: false }); await switching;
  assert.equal(states.at(-1)?.user?.id, b);
  const invalid = new AuthSession(states.at(-1)!, state => states.push(state), async () => ({ user: null, unavailable: false }));
  await invalid.verify(session(b)); assert.equal(states.at(-1)?.user, null);
  const initial = new AuthSession({ user: null, loading: true, error: null }, state => states.push(state), async () => ({ user: user(a), unavailable: false }));
  await initial.verify(session(a)); assert.equal(states.at(-1)?.user?.id, a);
});
test('logout and newer account events supersede pending verification; disposed callbacks cannot restore state', async () => {
  const states: AuthState[] = [], pending = deferred();
  const controller = new AuthSession({ user: user(a), loading: false, error: null }, state => states.push(state), () => pending.promise);
  const verifying = controller.verify(session(a)); await controller.verify(null);
  pending.resolve({ user: user(a), unavailable: false }); await verifying;
  assert.equal(states.at(-1)?.user, null); assert.equal(states.at(-1)?.loading, false);
  const pendingA = deferred(), pendingB = deferred();
  const switching = new AuthSession({ user: user(a), loading: false, error: null }, state => states.push(state), value => value.user.id === a ? pendingA.promise : pendingB.promise);
  const older = switching.verify(session(a)), newer = switching.verify(session(b));
  pendingB.resolve({ user: user(b), unavailable: false }); await newer;
  pendingA.resolve({ user: user(a), unavailable: false }); await older;
  assert.equal(states.at(-1)?.user?.id, b);
  const disposed = deferred();
  const ending = new AuthSession(states.at(-1)!, state => states.push(state), () => disposed.promise);
  const last = ending.verify(session(b)); const count = states.length; ending.dispose(); disposed.resolve({ user: user(b), unavailable: false }); await last;
  assert.equal(states.length, count);
});
test('temporary same-user network failures preserve edits, but never retain another account or accept mismatched verification', async () => {
  const states: AuthState[] = [];
  const controller = new AuthSession({ user: user(a), loading: false, error: null }, state => states.push(state), async () => { throw new Error('Fixture network unavailable'); });
  await controller.verify(session(a)); assert.equal(states.at(-1)?.user?.id, a); assert.ok(states.at(-1)?.error);
  await controller.verify(session(b)); assert.equal(states.at(-1)?.user, null);
  const mismatch = new AuthSession({ user: null, loading: true, error: null }, state => states.push(state), async () => ({ user: user(a), unavailable: false }));
  await mismatch.verify(session(b)); assert.equal(states.at(-1)?.user, null);
});

test('provider allowlist is private, validated and fails closed when unset', () => {
  assert.equal(approvedProviderUsers({}).size, 0);
  assert.deepEqual([...approvedProviderUsers({ PROVIDER_ALLOWED_USER_IDS: ` ${a}, ${b},${a} ` })], [a,b]);
  const privateInput = 'malformed-private-setting';
  assert.throws(() => approvedProviderUsers({ PROVIDER_ALLOWED_USER_IDS: privateInput }), error => error instanceof Error && !error.message.includes(privateInput));
  assert.throws(() => approvedProviderUsers({ PROVIDER_ALLOWED_USER_IDS: Array(21).fill(a).join(',') }));
});
test('public/unapproved users cannot reach provider I/O, including route aliases, spoofed owner fields or Hunter', async () => {
  let discoveryCalls = 0, hunterCalls = 0;
  const client = { auth: { getUser: async (token: string) => ({ data: { user: user(token === 'approved' ? a : b) }, error: null }) } } as unknown as SupabaseClient;
  const discovery = { options: { config: {} }, search: async () => { discoveryCalls++; return { rows: [] }; } } as unknown as DiscoveryService;
  const outreach = { enrich: async () => { hunterCalls++; return {}; } } as unknown as OutreachService;
  for (const approved of [new Set<string>(), new Set([a])]) {
    const server = createApp(client, discovery, undefined, undefined, outreach, undefined, approved).listen(0,'127.0.0.1'); await once(server,'listening');
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
      for (const path of ['/api/discovery/search','/api/discovery/SEARCH/','/api/outreach/' + a + '/enrich','/api/outreach/' + a + '/ENRICH/']) {
        const anonymous = await fetch(origin + path,{ method:'POST',headers:{ 'Content-Type':'application/json' },body:'{}' }); assert.equal(anonymous.status,401);
        for (const source of ['GEOAPIFY','SERPAPI']) {
          const denied = await fetch(origin + path,{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:'Bearer unapproved' },body:JSON.stringify({ source,ownerId:a,userId:a }) });
          assert.equal(denied.status,403); assert.ok(!JSON.stringify(await denied.json()).includes(a));
        }
      }
      const response = await fetch(origin + '/api/discovery/search',{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:'Bearer approved' },body:'{}' });
      assert.equal(response.status, approved.size ? 200 : 403);
      assert.equal(hunterCalls,0);
    } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
  }
  assert.equal(discoveryCalls,1);
});
test('discovery identities use the actual owner snapshot: concurrent inserts never shift pages or duplicate IDs', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon noinherit; create role authenticated noinherit; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to anon,authenticated;`);
    await db.query('insert into auth.users values ($1),($2)',[a,b]);
    for (const file of ['202610010001_auth_and_leads.sql','202610010002_lead_management.sql','202610010003_management_snapshot.sql']) await db.exec(await readFile('supabase/migrations/' + file,'utf8'));
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a]);
    await db.exec("insert into public.leads(business_name,source) select 'Business '||i,'CSV' from generate_series(1,201) as i");
    let concurrent = true, calls = 0;
    const client = { from: () => { throw new Error('Offset reads forbidden'); }, rpc: async (name: string, args?: unknown) => {
      assert.equal(name,'lead_management_snapshot'); assert.equal(args,undefined); calls++;
      const query = concurrent ? "with inserted as (insert into public.leads(business_name,source,domain) values ('Concurrent business','CSV','concurrent.business') returning id) select public.lead_management_snapshot() as data,(select count(*) from inserted) as inserted_count" : 'select public.lead_management_snapshot() as data';
      concurrent = false;
      return { data:(await db.query<{ data: Record<string,unknown>[] }>(query)).rows[0]!.data,error:null };
    } } as unknown as SupabaseClient;
    const repository = new SupabaseLeadRepository(client,a);
    const during = await repository.identities(); assert.equal(during.length,201); assert.equal(new Set(during.map(row => row.id)).size,201);
    const after = await repository.identities(); assert.equal(after.length,202); assert.equal(new Set(after.map(row => row.id)).size,202);
    assert.ok(after.some(row => row.domain === 'concurrent.business')); assert.deepEqual(after.map(row => row.id),after.map(row => row.id).sort()); assert.equal(calls,2);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b]); assert.deepEqual(await repository.identities(),[],'RPC derives ownership from Auth, never the constructor argument.');
  } finally { await db.close(); }
});
test('discovery snapshot failures and overflow cannot silently truncate duplicate checks', async () => {
  for (const data of [null,{},Array(2001).fill({})]) {
    const repository = new SupabaseLeadRepository({ rpc:async () => ({ data,error:null }) } as unknown as SupabaseClient,a);
    await assert.rejects(repository.identities(), error => error instanceof RequestError && error.status === (Array.isArray(data) ? 409 : 503));
  }
});
