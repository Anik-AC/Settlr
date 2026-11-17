import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db, getSecret } from './db.js';
import { publicUser, getUserById, getUserByUsername } from './ledger.js';

/** The signed-in user's own view of their account (never shown to other users). */
const selfUser = (u) => (u ? { ...publicUser(u), mustChangePassword: !!u.must_change_password } : null);
import { HttpError } from './expenses.js';

const COOKIE = 'settlr_session';
const MAX_AGE = 1000 * 60 * 60 * 24 * 60; // 60 days
// Behind HTTPS in production (Vercel), mark the cookie Secure.
const SECURE = !!process.env.VERCEL || process.env.SETTLR_SECURE_COOKIES === '1';

export const USERNAME_RE = /^[a-z0-9_.-]{3,20}$/i;

/** Optional invite code: when set, signing up requires it (keeps strangers out). */
const inviteCode = () => (process.env.SETTLR_INVITE_CODE || '').trim();
function inviteMatches(given) {
  const want = Buffer.from(inviteCode().toLowerCase());
  const got = Buffer.from(String(given || '').trim().toLowerCase());
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Sessions carry a fingerprint of the current password hash, so changing or
 * resetting a password signs out every other device.
 */
const passwordVersion = (user) => crypto.createHash('sha256').update(String(user.password_hash)).digest('hex').slice(0, 12);

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, pv: passwordVersion(user) }, getSecret(), { expiresIn: '60d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: MAX_AGE, path: '/' });
}

// ---------------------------------------------------------------------------
// Personal API keys: "Authorization: Bearer stl_…". Used by AI assistants (MCP)
// and scripts; they act as the key's owner. Only a SHA-256 hash is stored.
// ---------------------------------------------------------------------------
export const API_KEY_PREFIX = 'stl_';
export const hashApiKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const KEY_SCOPES = ['full', 'finance'];
export const newApiKey = (scope = 'full') => API_KEY_PREFIX + (scope === 'finance' ? 'fin_' : '') + crypto.randomBytes(30).toString('base64url');

async function userFromApiKey(header) {
  // "Bearer" is case-insensitive (RFC 7235); stray spaces around the value are fine.
  const m = /^\s*Bearer\s+(stl_[A-Za-z0-9_-]{20,})\s*$/i.exec(header || '');
  if (!m) return null;
  const row = await db.get(
    `SELECT t.id AS token_id, t.last_used_at, t.scope AS token_scope, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    hashApiKey(m[1])
  );
  if (!row) return null;
  // Record use at most every 10 minutes (keeps writes down).
  const stale = !row.last_used_at || Date.now() - Date.parse(row.last_used_at + 'Z') > 10 * 60 * 1000;
  if (stale) db.run("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?", row.token_id).catch(() => {});
  const { token_id: tokenId, last_used_at: _ignored, token_scope: scope, ...user } = row;
  return { user, tokenId, scope: scope || 'full' };
}

/** Finance-connection keys are read-only: they only work on /api/finance. */
export function blockFinanceKeys(req, _res, next) {
  if (req.apiKeyScope === 'finance') {
    return next(new HttpError(403, 'This is a finance connection key. It can only read your spending at /api/finance.'));
  }
  next();
}

/** Routes that must be done by a signed-in person, never with an API key. */
export function requireSession(req, _res, next) {
  if (req.apiKeyId) return next(new HttpError(403, 'This needs you to be signed in to the app, not an API key.'));
  next();
}

export async function requireAuth(req, _res, next) {
  if (req.headers.authorization) {
    try {
      const found = await userFromApiKey(req.headers.authorization);
      if (!found) return next(new HttpError(401, 'That API key isn’t valid (it may have been revoked).'));
      req.user = found.user;
      req.apiKeyId = found.tokenId;
      req.apiKeyScope = found.scope;
      return next();
    } catch (err) {
      return next(err);
    }
  }
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  let sub;
  let pv;
  try {
    ({ sub, pv } = jwt.verify(token, getSecret()));
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return next(new HttpError(401, 'Your session expired. Please sign in again.'));
    }
    return next(err);
  }
  try {
    const user = await getUserById(sub);
    if (!user) return next(new HttpError(401, 'Please sign in.'));
    if (pv !== passwordVersion(user)) return next(new HttpError(401, 'Your password was changed. Please sign in again.'));
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Accounts created by an admin start with a temporary password. Until the person
 * picks their own, everything except their own account endpoints is blocked.
 */
export function requirePasswordSet(req, _res, next) {
  if (req.user?.must_change_password) {
    return next(new HttpError(403, 'Choose a new password to continue.', { code: 'password_change_required' }));
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting failed attempts, stored in the database so it holds across all
// serverless instances. Windows are 15 minutes.
// ---------------------------------------------------------------------------
const WINDOW = "datetime('now', '-15 minutes')";
const LIMITS = { user: 10, ip: 30, 'invite-ip': 10 };

async function tooManyFailures(...keys) {
  for (const key of keys) {
    const kind = key.slice(0, key.lastIndexOf(':'));
    const { n } = await db.get(`SELECT COUNT(*) AS n FROM auth_failures WHERE key = ? AND created_at > ${WINDOW}`, key);
    if (n >= LIMITS[kind]) return true;
  }
  return false;
}
async function recordFailure(...keys) {
  for (const key of keys) await db.run('INSERT INTO auth_failures (key) VALUES (?)', key);
  // Keep the table small.
  await db.run("DELETE FROM auth_failures WHERE created_at < datetime('now', '-1 day')");
}
const TOO_MANY = () => new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({ inviteRequired: !!inviteCode() });
});

authRouter.post('/register', async (req, res) => {
  const ipKey = `invite-ip:${req.ip}`;
  if (inviteCode() && (await tooManyFailures(ipKey))) throw TOO_MANY();
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (inviteCode() && !inviteMatches(req.body.inviteCode)) {
    await recordFailure(ipKey);
    throw new HttpError(403, 'That invite code isn’t right. Ask the friend who sent you the link.');
  }
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Usernames are 3–20 characters: letters, numbers, dots, dashes or underscores.');
  }
  if (!displayName) throw new HttpError(400, 'Tell your friends your name.');
  if (password.length < 8) throw new HttpError(400, 'Use a password with at least 8 characters.');
  if (await getUserByUsername(username)) throw new HttpError(409, `@${username} is already taken.`);
  const hash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)',
    username.toLowerCase(), displayName, hash
  );
  const user = await getUserById(info.lastInsertRowid);
  setSession(res, user);
  res.status(201).json({ user: selfUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const name = String(req.body.username || '').trim().replace(/^@/, '').toLowerCase().slice(0, 40);
  const keys = [`user:${name}`, `ip:${req.ip}`];
  if (await tooManyFailures(...keys)) throw TOO_MANY();
  const user = await getUserByUsername(name);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    await recordFailure(...keys);
    throw new HttpError(401, 'That username and password don’t match.');
  }
  setSession(res, user);
  res.json({ user: selfUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/', secure: SECURE, sameSite: 'lax' });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: selfUser(req.user) });
});

/** Signed-in users can see the invite code so they can share a ready-made link. */
authRouter.get('/invite', requireAuth, requireSession, requirePasswordSet, (_req, res) => {
  res.json({ inviteCode: inviteCode() || null });
});

authRouter.patch('/me', requireAuth, requireSession, async (req, res) => {
  const { displayName, currentPassword, newPassword } = req.body;
  if (displayName !== undefined) {
    const name = String(displayName).trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Name cannot be empty.');
    await db.run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  }
  if (newPassword !== undefined) {
    const temporary = !!req.user.must_change_password;
    // With a temporary password the person has just proved it by signing in,
    // so the first-login screen only asks for the new one.
    if (!temporary && !(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) {
      throw new HttpError(400, 'Your current password is incorrect.');
    }
    if (String(newPassword).length < 8) throw new HttpError(400, 'Use a password with at least 8 characters.');
    if (await bcrypt.compare(String(newPassword), req.user.password_hash)) {
      throw new HttpError(400, temporary ? 'Pick a new password, not the temporary one.' : 'That’s your current password. Pick a new one.');
    }
    await db.run(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      await bcrypt.hash(String(newPassword), 10), req.user.id
    );
    // Other devices are now signed out (their session has the old password's
    // fingerprint); keep this one signed in with a fresh session.
    setSession(res, await getUserById(req.user.id));
  }
  res.json({ user: selfUser(await getUserById(req.user.id)) });
});

// ---- API key management (signed-in session only) ---------------------------
const MAX_KEYS = 10;
const keyDto = (t) => ({ id: t.id, name: t.name, prefix: t.prefix, scope: t.scope || 'full', createdAt: t.created_at, lastUsedAt: t.last_used_at });

authRouter.get('/api-keys', requireAuth, requireSession, requirePasswordSet, async (req, res) => {
  const rows = await db.all('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id DESC', req.user.id);
  res.json({ keys: rows.map(keyDto) });
});

authRouter.post('/api-keys', requireAuth, requireSession, requirePasswordSet, async (req, res) => {
  const scope = KEY_SCOPES.includes(req.body.scope) ? req.body.scope : 'full';
  const name = String(req.body.name || '').trim().slice(0, 40) || (scope === 'finance' ? 'Finance tracker' : 'My AI assistant');
  const { n } = await db.get('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?', req.user.id);
  if (n >= MAX_KEYS) throw new HttpError(400, `You can have up to ${MAX_KEYS} API keys. Revoke one first.`);
  const key = newApiKey(scope);
  const info = await db.run(
    'INSERT INTO api_tokens (user_id, name, token_hash, prefix, scope) VALUES (?, ?, ?, ?, ?)',
    req.user.id, name, hashApiKey(key), key.slice(0, scope === 'finance' ? 14 : 10), scope
  );
  const row = await db.get('SELECT * FROM api_tokens WHERE id = ?', info.lastInsertRowid);
  // The full key is shown exactly once.
  res.status(201).json({ key: keyDto(row), secret: key });
});

authRouter.delete('/api-keys/:id', requireAuth, requireSession, async (req, res) => {
  const info = await db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!info.changes) throw new HttpError(404, 'API key not found.');
  res.json({ ok: true });
});
