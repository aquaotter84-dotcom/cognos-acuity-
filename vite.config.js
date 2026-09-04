import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';

// No Base44 vite plugin. The dev server proxies /api to the local Node API so the
// browser only ever talks to its own origin (required for the sandboxed preview).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true }
    }
  }
});
