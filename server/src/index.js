// Local server: `npm run dev` / `npm start`. (Production on Vercel uses api/index.js.)
import express from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, handleErrors } from './app.js';
import { DB_LABEL, dbReady } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const DIST = path.resolve(__dirname, '../../client/dist');

await dbReady();
const app = createApp();

// Serve the built React app (npm run build).
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}
handleErrors(app);

app.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`\n  Settlr API listening on http://localhost:${PORT}`);
  console.log(`  Database: ${DB_LABEL}`);
  console.log(`  Bill scanning: ${process.env.OPENROUTER_API_KEY ? 'on (OpenRouter)' : 'off — set OPENROUTER_API_KEY in .env'}`);
  if (fs.existsSync(DIST)) {
    console.log('  Serving the built web app. On your phone (same Wi-Fi):');
    lan.forEach((u) => console.log(`    ${u}`));
  }
  console.log('');
});
