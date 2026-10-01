import { createClient } from '@supabase/supabase-js';
import { readPublicEnv } from './env';

const env = readPublicEnv(import.meta.env);
export const supabase = env.supabaseUrl && env.supabaseKey
  ? createClient(env.supabaseUrl, env.supabaseKey)
  : null;
