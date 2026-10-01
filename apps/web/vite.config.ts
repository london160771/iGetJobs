import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readPublicEnv } from './src/lib/env';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...loadEnv(mode, root, ''), ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const publicEnv = readPublicEnv(env);
  return {
    plugins: [react()],
    // Only validated public connection settings enter the browser bundle.
    envPrefix: [],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicEnv.supabaseUrl || ''),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publicEnv.supabaseKey || '')
    },
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:3001' } }
    }
  };
});
