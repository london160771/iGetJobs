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
  const supabaseUrl = env.SUPABASE_URL?.trim() || null;
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY?.trim() || null;
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
  return { host: env.HOST?.trim() || '127.0.0.1', port, supabaseUrl, supabaseKey };
}
