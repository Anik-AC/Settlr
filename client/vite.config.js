import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('../shared', import.meta.url));

// Build version = deployed commit (Vercel sets VERCEL_GIT_COMMIT_SHA at build time).
// The app compares it with /api/health to notice when a newer version is live.
const version = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias: { '@shared': shared } },
  server: {
    host: true, // expose on LAN so phones can open the dev server
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  preview: { host: true, proxy: { '/api': 'http://localhost:4000' } },
});
