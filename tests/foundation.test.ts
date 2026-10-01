import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { readServerEnv } from '../apps/api/src/env.js';
import { createServerSupabase } from '../apps/api/src/supabase.js';
import { createApp } from '../apps/api/src/app.js';
import { readPublicEnv } from '../apps/web/src/lib/env.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = 'https://example.supabase.co';
const key = 'sb_publishable_test-only';

test('empty configuration runs without Supabase; partial/invalid config fails clearly', () => {
  const env = readServerEnv({});
  assert.equal(env.port, 3001);
  assert.equal(createServerSupabase(env), null);
  assert.deepEqual(readPublicEnv({}), { supabaseUrl: null, supabaseKey: null });
  for (const port of ['0', '65536', 'NaN', '3.14', '1e3']) {
    assert.throws(() => readServerEnv({ PORT: port }), /PORT/);
  }
  assert.throws(() => readServerEnv({ SUPABASE_URL: url }), /both/);
  assert.throws(() => readPublicEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: key }), /both/);
  assert.throws(() => readServerEnv({ SUPABASE_URL: 'ftp://example.com', SUPABASE_PUBLISHABLE_KEY: key }), /HTTP/);
  assert.throws(() => readPublicEnv({ VITE_SUPABASE_URL: 'invalid', VITE_SUPABASE_PUBLISHABLE_KEY: key }), /HTTP/);
  assert.throws(() => readPublicEnv({ VITE_SUPABASE_URL: 'https://user:password@example.com', VITE_SUPABASE_PUBLISHABLE_KEY: key }), /credentials/);
});

test('browser config accepts public keys and refuses private credentials without echoing them', () => {
  assert.equal(readPublicEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key }).supabaseKey, key);
  const jwt = (role: string) => 'header.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature';
  assert.equal(readPublicEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon') }).supabaseKey, jwt('anon'));
  for (const privateKey of ['sb_secret_test-only', jwt('service_role'), 'malformed']) {
    assert.throws(() => readPublicEnv({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: privateKey }),
      error => error instanceof Error && /forbidden/.test(error.message) && !error.message.includes(privateKey));
  }
});

test('root public configuration and legacy key aliases work without accepting admin keys', () => {
  const root = { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key };
  assert.deepEqual(readPublicEnv(root), { supabaseUrl: url, supabaseKey: key });
  assert.equal(readServerEnv(root).supabaseKey, key);
  assert.equal(readServerEnv({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key }).supabaseKey, key);
  assert.throws(() => readPublicEnv({ ...root, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_different' }), /agree/);
  assert.throws(() => readServerEnv({ ...root, SUPABASE_URL: url }), /both/);
  assert.throws(() => readServerEnv({ SUPABASE_URL: url, SUPABASE_ANON_KEY: 'sb_secret_test-only' }), /private/);
  assert.throws(() => readPublicEnv({ ...root, VITE_SUPABASE_ANON_KEY: 'sb_secret_test-only' }), /forbidden/);
});

test('protected API verifies tokens with Auth and never echoes credentials or provider errors', async () => {
  const verifiedTokens: string[] = [];
  const client = { auth: { getUser: async (token: string) => {
    verifiedTokens.push(token);
    if (token === 'transport-failure') throw new Error('private transport details');
    return token === 'valid-test-token'
      ? { data: { user: { id: 'verified-user-id' } }, error: null }
      : { data: { user: null }, error: { message: 'private provider details' } };
  } } } as unknown as SupabaseClient;
  const server = createApp(client).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = 'http://127.0.0.1:' + address.port + '/api/session';
    for (const authorization of ['', 'Basic invalid', 'Bearer ', 'Bearer two tokens']) {
      const response = await fetch(endpoint, { headers: { Authorization: authorization } });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Sign in to continue.' });
    }
    assert.equal(verifiedTokens.length, 0);
    const valid = await fetch(endpoint, { headers: { Authorization: 'Bearer valid-test-token' } });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { userId: 'verified-user-id' });
    const invalid = await fetch(endpoint, { headers: { Authorization: 'Bearer rejected-token' } });
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: 'Unable to verify your session. Please sign in again.' });
    const failure = await fetch(endpoint, { headers: { Authorization: 'Bearer transport-failure' } });
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: 'Authentication is temporarily unavailable.' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('server Supabase setup keeps request credentials isolated', async () => {
  const env = readServerEnv({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key });
  const client = createServerSupabase(env, 'test-user-token');
  const anonymous = createServerSupabase(env);
  assert.ok(client && anonymous);
  assert.equal((await anonymous.auth.getSession()).data.session, null);
  const originalFetch = globalThis.fetch;
  const requests: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(new Headers(init?.headers));
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // Mocked transport only: no database table or live Supabase request is created.
    await client.from('__foundation_test__').select();
    await anonymous.from('__foundation_test__').select();
    assert.equal(requests[0]?.get('Authorization'), 'Bearer test-user-token');
    assert.notEqual(requests[1]?.get('Authorization'), 'Bearer test-user-token');
    assert.equal(requests[0]?.get('apikey'), key);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API health is honest; unknown routes, malformed and oversized JSON fail safely', async () => {
  for (const configured of [false, true]) {
    const client = configured ? createServerSupabase(readServerEnv({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key })) : null;
    const server = createApp(client).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = 'http://127.0.0.1:' + address.port;
      const response = await fetch(base + '/api/health');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-powered-by'), null);
      assert.deepEqual(await response.json(), { status: 'ok', service: 'igetjobs-api', supabase: configured ? 'configured' : 'unconfigured' });
      const missing = await fetch(base + '/api/unknown');
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'Route not found.' });
      const malformed = await fetch(base + '/api/unknown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { error: 'Invalid JSON.' });
      // Include JSON overhead so the complete UTF-8 body is exactly at the 100KB limit.
      const atLimitBody = JSON.stringify({ value: 'a'.repeat(100 * 1024 - 12) });
      assert.equal(Buffer.byteLength(atLimitBody), 100 * 1024);
      const atLimit = await fetch(base + '/api/unknown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: atLimitBody });
      assert.equal(atLimit.status, 404);
      assert.deepEqual(await atLimit.json(), { error: 'Route not found.' });
      const oversized = await fetch(base + '/api/unknown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(100 * 1024 - 11) }) });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), { error: 'Payload too large.' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
