import type { RequestHandler } from 'express';

/** Private deployment setting, never returned in configuration or errors. */
export function approvedProviderUsers(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const input = env.PROVIDER_ALLOWED_USER_IDS?.trim();
  if (!input) return new Set(); // Fail closed, including local development.
  const ids = input.split(',').map(value => value.trim().toLowerCase());
  if (ids.length > 20 || ids.some(id => !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id)))
    throw new Error('PROVIDER_ALLOWED_USER_IDS must contain a bounded list of Supabase user IDs.');
  return new Set(ids);
}
export function requireProviderAccess(approved: ReadonlySet<string>): RequestHandler {
  return (_req, res, next) => {
    if (!approved.has(res.locals.userId)) { res.status(403).json({ error: 'Provider discovery and enrichment are restricted to approved private-workspace accounts.' }); return; }
    next();
  };
}
