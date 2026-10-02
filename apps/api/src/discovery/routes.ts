import { Router, type RequestHandler } from 'express';
import type { DiscoveryService } from './service.js';
import { RequestError } from './errors.js';
import { requireProviderAccess } from '../provider-access.js';
export function discoveryRoutes(service?: DiscoveryService, providerAccess: RequestHandler = requireProviderAccess(new Set())) {
  const router = Router();
  router.use((_req, _res, next) => { if (!service) throw new RequestError(503, 'Discovery is not configured.'); next(); });
  router.get('/config', (_req, res) => res.json(service!.options.config));
  router.post('/search', providerAccess, async (req, res) => res.json(await service!.search(res.locals.userId as string, res.locals.accessToken as string, req.body as Record<string, unknown>)));
  router.post('/import', async (req, res) => res.json(await service!.importCsv(res.locals.userId as string, res.locals.accessToken as string, req.body as Record<string, unknown>)));
  router.post('/save', async (req, res) => res.json(await service!.save(res.locals.userId as string, res.locals.accessToken as string, req.body as Record<string, unknown>)));
  return router;
}
