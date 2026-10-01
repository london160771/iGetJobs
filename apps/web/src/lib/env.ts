export interface PublicEnv {
  supabaseUrl: string | null;
  supabaseKey: string | null;
}

/** Also runs in Vite config so invalid/private credentials fail before bundling. */
export function readPublicEnv(env: Record<string, string | undefined>): PublicEnv {
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim() || null;
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || null;
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim() || null;
  if (publishableKey && anonKey && publishableKey !== anonKey) {
    throw new Error('Supabase public-key aliases must agree when both are set.');
  }
  const supabaseKey = publishableKey || anonKey;
  if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
    throw new Error('Set both VITE_SUPABASE_URL and a public Supabase key, or leave both empty.');
  }
  if (supabaseUrl) {
    let url: URL;
    try { url = new URL(supabaseUrl); } catch { throw new Error('VITE_SUPABASE_URL must be an HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('VITE_SUPABASE_URL must be an HTTP(S) URL without embedded credentials.');
    }
  }
  if (supabaseKey && !supabaseKey.startsWith('sb_publishable_')) {
    let role: unknown;
    try {
      const payload = supabaseKey.split('.')[1];
      if (payload) {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        role = (JSON.parse(atob(base64)) as { role?: unknown }).role;
      }
    } catch { /* Malformed credentials are rejected below without revealing them. */ }
    if (role !== 'anon') throw new Error('Use a Supabase publishable or legacy anon key in the browser. Secret/service-role keys are forbidden.');
  }
  return { supabaseUrl, supabaseKey };
}
