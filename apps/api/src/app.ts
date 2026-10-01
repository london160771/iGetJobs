import express from 'express';
import type { ApiError, HealthResponse } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuth } from './auth.js';
import type { DiscoveryService } from './discovery/service.js';
import { discoveryRoutes } from './discovery/routes.js';
import { RequestError } from './discovery/errors.js';

export function createApp(supabase: SupabaseClient | null, discovery?: DiscoveryService) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.get('/api/health', (_req, res) => {
    const health: HealthResponse = {
      status: 'ok', service: 'igetjobs-api', supabase: supabase ? 'configured' : 'unconfigured'
    };
    res.json(health);
  });
  app.get('/api/session', requireAuth(supabase), (_req, res) => {
    res.json({ userId: res.locals.userId });
  });
  app.use('/api/discovery', requireAuth(supabase), (req, _res, next) => {
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) throw new RequestError(400, 'A JSON object is required.');
    next();
  }, discoveryRoutes(discovery));
  app.get('/api/leads', requireAuth(supabase), async (_req, res) => {
    if (!discovery) throw new RequestError(503, 'Discovery is not configured.');
    res.json({ leads: await discovery.list(res.locals.userId as string, res.locals.accessToken as string) });
  });
  app.use((_req, res) => {
    const body: ApiError = { error: 'Route not found.' };
    res.status(404).json(body);
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof RequestError) { res.status(error.status).json({ error: error.message } satisfies ApiError); return; }
    const badJson = error instanceof SyntaxError && 'status' in error && error.status === 400;
    const oversizedJson = error instanceof Error && 'status' in error && error.status === 413
      && 'type' in error && error.type === 'entity.too.large';
    if (oversizedJson) {
      res.status(413).json({ error: 'Payload too large.' } satisfies ApiError);
      return;
    }
    res.status(badJson ? 400 : 500).json({ error: badJson ? 'Invalid JSON.' : 'Request failed.' } satisfies ApiError);
  });
  return app;
}
