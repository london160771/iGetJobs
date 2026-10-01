import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readServerEnv } from './env.js';
import { createServerSupabase } from './supabase.js';
import { createDiscoveryService } from './discovery/service.js';

// Resolve relative to this file so dev and built starts load the same API-only env.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const env = readServerEnv(process.env);
const app = createApp(createServerSupabase(env), createDiscoveryService(process.env));
const server = app.listen(env.port, env.host, () => {
  console.log(`iGetJobs API listening at http://${env.host}:${env.port}`);
});
server.on('error', () => {
  console.error('API could not start. Check HOST, PORT and whether the port is in use.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close());
}
