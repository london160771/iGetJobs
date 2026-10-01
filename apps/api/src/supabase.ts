import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ServerEnv } from './env.js';

/** Public client only; each data request carries the verified user's token and relies on RLS. */
export function createServerSupabase(env: ServerEnv, accessToken?: string): SupabaseClient | null {
  if (!env.supabaseUrl || !env.supabaseKey) return null;
  return createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      fetch: async (input, init) => {
        const timeout = AbortSignal.timeout(15000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        try { return await fetch(input, { ...init, signal }); }
        catch { throw new Error('Supabase transport unavailable.'); }
      }
    }
  });
}
