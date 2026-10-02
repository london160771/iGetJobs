import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readServerEnv } from './env.js';
import { createServerSupabase } from './supabase.js';
import { createDiscoveryService } from './discovery/service.js';
import { createAuditService } from './audit/service.js';
import { createManagementService } from './management.js';
import { createOutreachService } from './outreach/service.js';
import { prepareProduction } from './production.js';

// Resolve relative to this file so dev and built starts load the same API-only env.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const env = readServerEnv(process.env);
await prepareProduction(process.env);
const frontend = process.env.SERVE_WEB === 'true' ? { directory: fileURLToPath(new URL('../../web/dist/', import.meta.url)), supabaseUrl: env.supabaseUrl } : undefined;
const app = createApp(createServerSupabase(env), createDiscoveryService(process.env), createAuditService(process.env), createManagementService(process.env), createOutreachService(process.env), frontend);
const server = app.listen(env.port, env.host, () => {
  console.log(`iGetJobs API listening at http://${env.host}:${env.port}`);
});
server.on('error', () => {
  console.error('API could not start. Check Supabase/quota configuration, HOST, PORT and the production build.');
  process.exitCode = 1;
});
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 25000);
    deadline.unref();
    server.close(() => clearTimeout(deadline));
  });
}
