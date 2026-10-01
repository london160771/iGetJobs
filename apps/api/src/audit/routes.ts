import { Router } from 'express';
import type { AuditService } from './service.js';
import { RequestError } from '../discovery/errors.js';
export function auditRoutes(service?: AuditService) {
  const router = Router();
  router.use((req, _res, next) => {
    if (!service) throw new RequestError(503, 'Website auditing is not configured.');
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) throw new RequestError(400, 'A JSON object is required.');
    next();
  });
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw new RequestError(400, 'Invalid lead ID.');
    return value;
  };
  router.get('/:id', async (req, res) => res.json(await service!.detail(res.locals.userId as string, res.locals.accessToken as string, id(req.params.id))));
  router.post('/:id/audit', async (req, res) => res.json({ lead: await service!.run(res.locals.userId as string, res.locals.accessToken as string, id(req.params.id), req.body as Record<string, unknown>) }));
  return router;
}
