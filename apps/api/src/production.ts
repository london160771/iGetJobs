import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServerEnv } from './env.js';
import { supabaseUsageStore } from './quota.js';

export function usageDirectory(env: NodeJS.ProcessEnv): string {
  const directory = env.USAGE_DIRECTORY?.trim();
  if (directory && (!isAbsolute(directory) || directory.includes('\0'))) throw new Error('USAGE_DIRECTORY must be an absolute directory.');
  if (env.NODE_ENV === 'production') throw new Error('Production quota storage must use Supabase.');
  return directory || fileURLToPath(new URL('../../../.local/', import.meta.url));
}
export function usageFile(env: NodeJS.ProcessEnv, provider: 'provider' | 'hunter') {
  return join(usageDirectory(env), provider + '-usage.json');
}
export function verifiedHunterKey(env: NodeJS.ProcessEnv): string | null {
  // An operator must verify a real Free-plan credential before opting in.
  // Every lookup still independently checks the live account and remaining quota.
  return env.HUNTER_FREE_PLAN_VERIFIED === 'true' ? env.HUNTER_API_KEY?.trim() || null : null;
}
export async function prepareProduction(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  const settings = readServerEnv(env);
  if (!settings.supabaseUrl || !settings.supabaseKey || new URL(settings.supabaseUrl).protocol !== 'https:') throw new Error('Production requires HTTPS Supabase public configuration.');
  await supabaseUsageStore(env).load(); // Fail closed on absent credentials/schema/storage.
}
