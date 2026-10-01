import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ServerEnv } from './env.js';

/** No admin key. Future user requests must carry their access token and rely on RLS. */
export function createServerSupabase(env: ServerEnv, accessToken?: string): SupabaseClient | null {
  if (!env.supabaseUrl || !env.supabaseKey) return null;
  return createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {})
  });
}
