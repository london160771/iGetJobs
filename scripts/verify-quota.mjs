import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { supabaseUsageStore } from '../apps/api/dist/quota.js';
import { readServerEnv } from '../apps/api/dist/env.js';
config({ path:'.env',quiet:true }); config({ path:'apps/api/.env',quiet:true });
if (process.env.SUPABASE_SMOKE_EMAIL && process.env.SUPABASE_SMOKE_PASSWORD) {
  process.env.SUPABASE_TEST_EMAIL_A=process.env.SUPABASE_SMOKE_EMAIL;
  process.env.SUPABASE_TEST_PASSWORD_A=process.env.SUPABASE_SMOKE_PASSWORD;
}
const provider = process.argv.includes('--geoapify') ? 'GEOAPIFY' : 'SERPAPI';
const limit = Number(provider === 'GEOAPIFY' ? process.env.GEOAPIFY_DAILY_LIMIT || '100' : process.env.SERPAPI_MONTHLY_LIMIT || '50');
let checkpoint = 'Supabase quota configuration';
const clients = [];
const check = (value,label) => { checkpoint = label; if (!value) throw new Error(); console.log('PASS: ' + label); };
try {
  const settings = readServerEnv(process.env), first = supabaseUsageStore(process.env);
  const before = await first.load();
  // This is one real, deliberately counted reservation, with NO provider request.
  // Never delete/reset global production usage as test cleanup.
  await first.reserve(provider,limit);
  const fresh = supabaseUsageStore(process.env), after = await fresh.load();
  check(after[provider].count === (before[provider]?.period === after[provider].period ? before[provider].count + 1 : 1),'Durable reservation survives a fresh client/process state');
  let blocked = false;
  try { await fresh.reserve(provider,limit); } catch (error) { blocked = error.status === 429; }
  check(blocked,'Fresh quota client cannot bypass database cooldown');
  const anon = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } }); clients.push(anon);
  for (const client of [anon,...await Promise.all(['A','B'].map(async suffix => {
    const client = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } }); clients.push(client);
    const signed = await client.auth.signInWithPassword({ email:process.env['SUPABASE_TEST_EMAIL_' + suffix],password:process.env['SUPABASE_TEST_PASSWORD_' + suffix] }); check(!signed.error,'Quota isolation test account ' + suffix + ' signs in'); return client;
  }))]) {
    check(Boolean((await client.from('provider_usage').select('*')).error),'Public/user credentials cannot read global provider usage');
    check(Boolean((await client.rpc('provider_usage_status')).error),'Public/user credentials cannot call quota status');
    check(Boolean((await client.rpc('reserve_provider_usage',{ p_provider:provider,p_limit:limit })).error),'Public/user credentials cannot consume or reset quota');
  }
  check((await fresh.load())[provider].count === after[provider].count,'Rejected reservations leave usage unchanged');
} catch { console.error('FAIL: ' + checkpoint + '. No credentials or provider data emitted.'); process.exitCode = 1; }
finally { for (const client of clients) await client.auth.signOut({ scope:'local' }).catch(() => {}); }
