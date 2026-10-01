import { supabase } from './supabase';
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await supabase?.auth.getSession();
  const token = session?.data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: 'Bearer ' + token } });
  } catch { throw new Error('The API is unavailable. Please try again.'); }
  if (response.status === 401) { await supabase?.auth.signOut({ scope: 'local' }); throw new Error('Your session expired. Please sign in again.'); }
  let data: T & { error?: string };
  try { data = await response.json() as T & { error?: string }; }
  catch { throw new Error('The API returned an unexpected response.'); }
  if (!response.ok) throw new ApiRequestError(data.error || 'This request could not be completed.', response.status);
  return data;
}
