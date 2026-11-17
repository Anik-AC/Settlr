import './env.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter, requireAuth, requirePasswordSet, blockFinanceKeys } from './auth.js';
import { financeRouter } from './finance.js';
import { api } from './api.js';
import { receiptsRouter } from './receipts.js';
import { mcpRouter } from './mcp.js';
import { HttpError } from './expenses.js';
import { dbReady } from './db.js';

/**
 * JSON body parser that also works on Vercel, whose Node runtime may already
 * have read (and parsed) the request body before Express sees it.
 */
export function jsonBody(limit) {
  const parse = express.json({ limit });
  return (req, res, next) => {
    if (req.readableEnded || req.complete) {
      // Body already consumed upstream: use what the platform parsed.
      try {
        const b = req.body;
        req.body = b && typeof b === 'object' && !Buffer.isBuffer(b) ? b : {};
      } catch {
        return next(new HttpError(400, 'That request body isn’t valid JSON.'));
      }
      return next();
    }
    parse(req, res, next);
  };
}

/** Wait for the schema on cold start before handling API requests. */
async function ensureDb(_req, _res, next) {
  try {
    await dbReady();
    next();
  } catch (err) {
    console.error('Database unavailable:', err);
    next(new HttpError(503, 'Can’t reach the database right now. Please try again in a moment.'));
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Vercel (and most hosts) sit behind a proxy: trust it for req.ip / https.
  app.set('trust proxy', process.env.VERCEL ? true : 'loopback');
  app.use(cookieParser());

  // `commit` shows which deploy is live (Vercel sets VERCEL_GIT_COMMIT_SHA).
  app.get('/api/health', (_req, res) => res.json({ ok: true, commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7) }));
  app.use('/api', ensureDb);
  // Bill photos are bigger than normal JSON bodies, so this route parses its own body.
  // (Vercel caps request bodies at 4.5 MB; the client keeps photos under that.)
  app.use('/api/receipts', requireAuth, blockFinanceKeys, requirePasswordSet, jsonBody('4.5mb'), receiptsRouter);
  // AI assistants (Claude etc.) connect here with a personal API key: Authorization: Bearer stl_…
  app.use('/api/mcp', requireAuth, blockFinanceKeys, requirePasswordSet, jsonBody('1mb'), mcpRouter);
  // Read-only spending feed for a connected finance tracker (finance key, any key, or a session).
  app.use('/api/finance/v1', requireAuth, requirePasswordSet, financeRouter);
  app.use(jsonBody('200kb'));
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth, blockFinanceKeys, requirePasswordSet, api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

/** Final error handler; call after any extra routes (e.g. static files). */
export function handleErrors(app) {
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
    // HttpErrors carry messages meant for the user (incl. 502/503 from bill scanning); hide anything else.
    const expected = err instanceof HttpError || status < 500;
    if (!expected) console.error(err);
    res.status(status).json({ error: expected ? err.message : 'Something went wrong on the server.', details: err.details });
  });
  return app;
}
