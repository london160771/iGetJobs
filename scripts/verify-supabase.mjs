import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../apps/api/.env', import.meta.url)), quiet: true });
const env = process.env;
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const clients = [];
const created = [];

function client() {
  assert.ok(url && key, 'Public connection configuration is required.');
  let role;
  try { role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role; } catch { /* Public formats only. */ }
  if (!key.startsWith('sb_publishable_') && role !== 'anon') throw new Error('Public connection key is invalid or privileged.');
  const instance = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      try { return await fetch(input, { ...init, signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error('Supabase transport unavailable.'); }
    } }
  });
  clients.push(instance);
  return instance;
}
function check(value, label) {
  if (!value) throw new Error(label);
  console.log('PASS: ' + label);
}

try {
  const anonymous = client();
  const probe = await anonymous.from('leads').select('id').limit(0);
  check(!probe.error || ['PGRST205', '42501'].includes(probe.error.code), 'Live database gateway connectivity');
  check(probe.error?.code !== 'PGRST205', 'Lead schema exists');
  if (!process.argv.includes('--connectivity-only')) {
    const accounts = [];
    for (const suffix of ['A', 'B']) {
      const email = env['SUPABASE_TEST_EMAIL_' + suffix];
      const password = env['SUPABASE_TEST_PASSWORD_' + suffix];
      if (!email || !password) throw new Error('Two confirmed, disposable test accounts must be configured locally.');
      const instance = client();
      const result = await instance.auth.signInWithPassword({ email, password });
      check(!result.error && Boolean(result.data.session), 'Password sign-in for test user ' + suffix);
      const verified = await instance.auth.getUser();
      check(!verified.error && Boolean(verified.data.user), 'Server-verified identity for test user ' + suffix);
      accounts.push({ client: instance, userId: verified.data.user.id });
    }
    check(accounts[0].userId !== accounts[1].userId, 'Two distinct authenticated users');
    for (const table of ['leads', 'user_settings']) {
      const ids = [];
      for (const account of accounts) {
        const id = randomUUID();
        const row = table === 'leads' ? { id, business_name: 'Disposable RLS verification', source: 'CSV' } : { id };
        const insert = await account.client.from(table).insert(row).select('id, owner_id').single();
        check(!insert.error && insert.data?.owner_id === account.userId, table + ': own insert and server ownership default');
        created.push({ client: account.client, table, id });
        ids.push(id);
        const own = await account.client.from(table).select('id').eq('id', id);
        check(!own.error && own.data?.length === 1, table + ': own persistence read');
      }
      for (let i = 0; i < accounts.length; i++) {
        const current = accounts[i];
        const other = accounts[1 - i];
        const foreignId = ids[1 - i];
        const read = await current.client.from(table).select('id').eq('id', foreignId);
        check(!read.error && read.data?.length === 0, table + ': cross-user read denied');
        const update = await current.client.from(table).update({ updated_at: new Date().toISOString() }).eq('id', foreignId).select('id');
        check(!update.error && update.data?.length === 0, table + ': cross-user update denied');
        const remove = await current.client.from(table).delete().eq('id', foreignId).select('id');
        check(!remove.error && remove.data?.length === 0, table + ': cross-user delete denied');
        const transfer = await current.client.from(table).update({ owner_id: other.userId }).eq('id', ids[i]);
        check(transfer.error?.code === '42501', table + ': owner transfer denied');
        const forgedId = randomUUID();
        // Track even a wrongly allowed insert so a failed security check leaves no test row.
        created.push({ client: other.client, table, id: forgedId });
        const forgery = await current.client.from(table).insert(table === 'leads'
          ? { id: forgedId, owner_id: other.userId, business_name: 'Disposable forged ownership probe', source: 'CSV' }
          : { id: forgedId, owner_id: other.userId });
        check(forgery.error?.code === '42501', table + ': forged owner insert denied');
        const intact = await other.client.from(table).select('id').eq('id', foreignId);
        check(!intact.error && intact.data?.length === 1, table + ': foreign record remains intact');
      }
      const anonRead = await anonymous.from(table).select('id').in('id', ids);
      check(Boolean(anonRead.error) || anonRead.data?.length === 0, table + ': anonymous read denied');
      const anonId = randomUUID();
      created.push({ client: accounts[0].client, table, id: anonId });
      const anonWrite = await anonymous.from(table).insert(table === 'leads'
        ? { id: anonId, owner_id: accounts[0].userId, business_name: 'Disposable anonymous probe', source: 'CSV' }
        : { id: anonId, owner_id: accounts[0].userId });
      check(Boolean(anonWrite.error), table + ': anonymous write denied');
    }
  }
} catch (error) {
  // Never print provider responses, requests, emails, passwords, tokens or connection values.
  const safe = error instanceof Error && !error.message.includes('http') && !error.message.includes(key || '\0');
  console.error('FAIL: ' + (safe && /^(Two confirmed|Public connection|Live database|Lead schema|Password sign-in|Server-verified|Two distinct|leads:|user_settings:)/.test(error.message) ? error.message : 'Supabase verification failed. Inspect local configuration and schema.'));
  process.exitCode = 1;
} finally {
  for (const row of created) {
    try {
      const result = await row.client.from(row.table).delete().eq('id', row.id);
      if (result.error) { console.error('FAIL: Disposable verification row cleanup failed.'); process.exitCode = 1; }
    } catch { console.error('FAIL: Disposable verification row cleanup failed.'); process.exitCode = 1; }
  }
  for (const instance of clients) {
    try { await instance.auth.signOut({ scope: 'local' }); } catch { /* No persisted sessions. */ }
  }
}
