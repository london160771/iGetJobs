import express from 'express';
import type { ApiError, HealthResponse } from '@igetjobs/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export function createApp(supabase: SupabaseClient | null) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.get('/api/health', (_req, res) => {
    const health: HealthResponse = {
      status: 'ok', service: 'igetjobs-api', supabase: supabase ? 'configured' : 'unconfigured'
    };
    res.json(health);
  });
  app.use((_req, res) => {
    const body: ApiError = { error: 'Route not found.' };
    res.status(404).json(body);
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const badJson = error instanceof SyntaxError && 'status' in error && error.status === 400;
    res.status(badJson ? 400 : 500).json({ error: badJson ? 'Invalid JSON.' : 'Request failed.' } satisfies ApiError);
  });
  return app;
}
