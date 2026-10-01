import type { RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Verify with Auth rather than trusting a decoded token or client-supplied owner ID. */
export function requireAuth(supabase: SupabaseClient | null): RequestHandler {
  return async (req, res, next) => {
    const authorization = req.get('Authorization');
    const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (!supabase) {
      res.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) {
        res.status(error?.name === 'AuthRetryableFetchError' ? 503 : 401).json({ error: 'Unable to verify your session. Please sign in again.' });
        return;
      }
      res.locals.userId = data.user.id;
      res.locals.accessToken = token;
      next();
    } catch {
      res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
    }
  };
}
