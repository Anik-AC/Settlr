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

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id }, getSecret(), { expiresIn: '60d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: MAX_AGE, path: '/' });
}

export async function requireAuth(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  let sub;
  try {
    ({ sub } = jwt.verify(token, getSecret()));
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return next(new HttpError(401, 'Your session expired. Please sign in again.'));
    }
    return next(err);
  }
  try {
    const user = await getUserById(sub);
    if (!user) return next(new HttpError(401, 'Please sign in.'));
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

// Small in-memory limiter for login attempts. On serverless each instance keeps
// its own counts, so this slows down guessing rather than stopping it outright.
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) Object.assign(rec, { n: 0, t: now });
  rec.n += 1;
  attempts.set(key, rec);
  if (rec.n > 20) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({ inviteRequired: !!inviteCode() });
});

authRouter.post('/register', async (req, res) => {
  throttle(`reg:${req.ip}`);
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (inviteCode() && !inviteMatches(req.body.inviteCode)) {
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
  throttle(req.ip);
  const user = await getUserByUsername(req.body.username);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
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
authRouter.get('/invite', requireAuth, requirePasswordSet, (_req, res) => {
  res.json({ inviteCode: inviteCode() || null });
});

authRouter.patch('/me', requireAuth, async (req, res) => {
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
  }
  res.json({ user: selfUser(await getUserById(req.user.id)) });
});
