import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const shared = fileURLToPath(new URL('../shared', import.meta.url));

// Build version = deployed commit (Vercel sets VERCEL_GIT_COMMIT_SHA at build time).
// The app compares it with /api/health to notice when a newer version is live.
const version = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);

/**
 * Production builds get a Content-Security-Policy: only Settlr's own scripts,
 * styles, fonts and API. The inline theme script is allowed by its hash.
 * (Not applied to `npm run dev`, which needs Vite's inline scripts and websocket.)
 */
function contentSecurityPolicy() {
  return {
    name: 'settlr-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
      );
      const csp = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`,
        "style-src 'self' 'unsafe-inline'", // React style={{…}} attributes
        "img-src 'self' data: blob:", // bill photo previews
        "font-src 'self' data:",
        "connect-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
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
