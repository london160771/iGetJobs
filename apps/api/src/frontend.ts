import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function serveFrontend(app: Express, directory: string, supabaseUrl: string | null) {
  const index = join(directory, 'index.html');
  if (!existsSync(index)) throw new Error('Build the frontend before starting production.');
  const connect = supabaseUrl ? ' ' + new URL(supabaseUrl).origin : '';
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'" + connect + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.setHeader('Content-Security-Policy', csp);
    next();
  });
  app.use(express.static(directory, {
    dotfiles: 'deny', index: false, redirect: false,
    setHeaders(res, path) {
      res.setHeader('Cache-Control', /[/\\]assets[/\\][^/\\]+-[\w-]+\.(?:js|css)$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-store');
    }
  }));
  app.use((req, res, next) => {
    // API misses, assets and non-navigation requests must never get SPA HTML.
    if (!['GET', 'HEAD'].includes(req.method) || req.path === '/api' || req.path.startsWith('/api/') || req.path.split('/').some(part => part.includes('.')) || !req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(index);
  });
}
