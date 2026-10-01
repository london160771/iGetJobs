export interface ServerEnv {
  host: string;
  port: number;
  supabaseUrl: string | null;
  supabaseKey: string | null;
}

export function readServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const portText = env.PORT?.trim() || '3001';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const hasServerConfig = Boolean(env.SUPABASE_URL?.trim() || env.SUPABASE_PUBLISHABLE_KEY?.trim() || env.SUPABASE_ANON_KEY?.trim());
  const supabaseUrl = (hasServerConfig ? env.SUPABASE_URL : env.VITE_SUPABASE_URL)?.trim() || null;
  const publishableKey = (hasServerConfig ? env.SUPABASE_PUBLISHABLE_KEY : env.VITE_SUPABASE_PUBLISHABLE_KEY)?.trim() || null;
  const anonKey = (hasServerConfig ? env.SUPABASE_ANON_KEY : env.VITE_SUPABASE_ANON_KEY)?.trim() || null;
  if (publishableKey && anonKey && publishableKey !== anonKey) {
    throw new Error('Supabase public-key aliases must agree when both are set.');
  }
  const supabaseKey = publishableKey || anonKey;
  if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, or leave both empty.');
  }
  if (supabaseUrl) {
    let parsed: URL;
    try { parsed = new URL(supabaseUrl); } catch { throw new Error('SUPABASE_URL must be an HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('SUPABASE_URL must be an HTTP(S) URL without embedded credentials.');
    }
  }
  if (supabaseKey && !supabaseKey.startsWith('sb_publishable_')) {
    let role: unknown;
    try {
      role = (JSON.parse(Buffer.from(supabaseKey.split('.')[1] || '', 'base64url').toString()) as { role?: unknown }).role;
    } catch { /* Reject malformed keys without exposing them. */ }
    if (role !== 'anon') throw new Error('Use a public Supabase key; private/admin credentials are forbidden in the app.');
  }
  return { host: env.HOST?.trim() || '127.0.0.1', port, supabaseUrl, supabaseKey };
}
