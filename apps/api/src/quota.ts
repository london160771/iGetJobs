import { createClient } from '@supabase/supabase-js';
import { readServerEnv } from './env.js';
import { RequestError } from './discovery/errors.js';
import type { QuotaProvider, Usage, UsageStore } from './discovery/usage.js';

export interface QuotaRpc { rpc(name: string, input?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> }
export function quotaStore(client: QuotaRpc): UsageStore {
  return {
    async load() {
      const result = await client.rpc('provider_usage_status');
      if (result.error || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new RequestError(503,'Provider usage protection is unavailable.');
      if (Object.entries(result.data).some(([provider,row]) => !['OSM','SERPAPI','HUNTER','GEOAPIFY'].includes(provider) || !row || typeof row !== 'object' || !('count' in row) || !Number.isInteger(row.count) || row.count < 0 || !('period' in row) || typeof row.period !== 'string' || !('lastCall' in row) || typeof row.lastCall !== 'number' || !Number.isFinite(row.lastCall))) throw new RequestError(503,'Provider usage protection is unavailable.');
      return result.data as Usage;
    },
    async save() { throw new RequestError(503,'Provider usage must be reserved atomically.'); },
    async reserve(provider: QuotaProvider, limit: number) {
      const result = await client.rpc('reserve_provider_usage',{ p_provider:provider,p_limit:limit });
      if (result.error) {
        if (result.error.code === 'P0001' && ['QUOTA_COOLDOWN','QUOTA_EXHAUSTED'].includes(result.error.message || '')) throw new RequestError(429,result.error.message === 'QUOTA_COOLDOWN' ? 'Please wait before another provider lookup.' : 'The configured provider attempt cap is exhausted.');
        throw new RequestError(503,'Provider usage protection is unavailable. No lookup was made.');
      }
      if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data) || !('count' in result.data) || !Number.isInteger(result.data.count) || (result.data.count as number) < 1) throw new RequestError(503,'Provider usage reservation could not be verified. No lookup was made.');
    }
  };
}
export function supabaseUsageStore(env: NodeJS.ProcessEnv): UsageStore {
  const settings = readServerEnv(env), key = env.SUPABASE_QUOTA_SERVICE_KEY?.trim();
  let privileged = Boolean(key?.startsWith('sb_secret_'));
  if (key && !privileged) {
    try { privileged = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role === 'service_role'; } catch { /* Never echo a key. */ }
  }
  if (!settings.supabaseUrl || !key || !privileged) throw new Error('Supabase quota storage requires a server-only SUPABASE_QUOTA_SERVICE_KEY.');
  // This privileged client is confined to quota RPCs. Lead/settings clients still
  // use public keys + user JWTs and owner RLS; never pass this client to them.
  return quotaStore(createClient(settings.supabaseUrl,key,{
    auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false },
    global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) }
  }));
}
