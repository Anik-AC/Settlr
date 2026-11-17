import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Database: SQLite everywhere.
 *  - Production (Vercel): Turso (hosted libSQL/SQLite) via DATABASE_URL + DATABASE_AUTH_TOKEN.
 *  - Local development:   a plain SQLite file in server/data (no account needed).
 *
 * Everything goes through the tiny async helpers below:
 *   db.get(sql, ...args) -> first row | undefined
 *   db.all(sql, ...args) -> rows
 *   db.run(sql, ...args) -> { changes, lastInsertRowid }
 *   tx(async (q) => { ... })  -> same helpers inside one write transaction
 * Args are positional (?) or a single object for named params (@name).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.SETTLR_DATA_DIR || path.resolve(__dirname, '../data');

const remoteUrl = process.env.DATABASE_URL;
export const DB_LABEL = remoteUrl ? remoteUrl.replace(/\?.*$/, '') : path.join(DATA_DIR, 'settlr.db');

let client;
let configError = null;
if (remoteUrl) {
  // The web client talks plain HTTPS: no native modules, ideal for serverless.
  const { createClient } = await import('@libsql/client/web');
  client = createClient({ url: remoteUrl, authToken: process.env.DATABASE_AUTH_TOKEN });
} else if (process.env.VERCEL) {
  // Don't crash on import; every API request reports this (and it shows in Vercel's logs).
  configError = new Error('DATABASE_URL is not set. Add your Turso database URL and token in Vercel → Settings → Environment Variables, then redeploy.');
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { createClient } = await import('@libsql/client');
  client = createClient({ url: `file:${path.join(DATA_DIR, 'settlr.db')}` });
}

// NaN/Infinity (e.g. a bad id in a URL) bind as NULL, so lookups just find nothing (-> 404).
const clean = (v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v === undefined ? null : v);
/**
 * Named args: send only the names the SQL actually uses. Turso (remote libSQL)
 * rejects extra named values ("Number of arguments mismatch"), while a local file
 * database ignores them — which once broke every expense edit in production.
 */
function toArgs(sql, args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const used = new Set([...sql.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((m) => m[1]));
    return Object.fromEntries(Object.entries(args[0]).filter(([k]) => used.has(k)).map(([k, v]) => [k, clean(v)]));
  }
  return args.map(clean);
}

/** libSQL rows -> plain objects (safe to spread / JSON). */
const plain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

function helpers(execute) {
  const exec = (sql, args) => execute({ sql, args: toArgs(sql, args) });
  return {
    async get(sql, ...args) {
      return plain(await exec(sql, args))[0];
    },
    async all(sql, ...args) {
      return plain(await exec(sql, args));
    },
    async run(sql, ...args) {
      const rs = await exec(sql, args);
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
    },
  };
}

export const db = helpers((stmt) => client.execute(stmt));

/** Run `fn(q)` inside one write transaction; rolls back if it throws. */
export async function tx(fn) {
  const t = await client.transaction('write');
  try {
    const out = await fn(helpers((stmt) => t.execute(stmt)));
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    t.close();
  }
}

// ---------------------------------------------------------------------------
// Schema (idempotent). Deletes are done explicitly in code, so nothing relies on
// foreign-key cascades (not every libSQL connection enforces them).
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 1 = signed in with a temporary password
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'home',      -- home | trip | couple | other
  simplify   INTEGER NOT NULL DEFAULT 1,        -- simplify debts within the group
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

-- An "expense" row is either a shared expense (type = 'expense') or a
-- settle-up payment between two people (type = 'payment').
CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL DEFAULT 'expense',  -- expense | payment
  group_id     INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'general',
  notes        TEXT,
  date         TEXT NOT NULL,                    -- YYYY-MM-DD
  currency     TEXT NOT NULL DEFAULT 'CAD',
  subtotal     INTEGER NOT NULL,                 -- cents, before tax
  tax          INTEGER NOT NULL DEFAULT 0,       -- cents
  tip          INTEGER NOT NULL DEFAULT 0,       -- cents
  extras_split TEXT NOT NULL DEFAULT 'proportional', -- proportional | equal (tax + tip)
  fees         INTEGER NOT NULL DEFAULT 0,       -- cents, order fees (service/delivery), shared like tip
  discount     INTEGER NOT NULL DEFAULT 0,       -- cents, bill-level coupon/promo
  discount_split TEXT NOT NULL DEFAULT 'proportional', -- proportional | equal
  total        INTEGER NOT NULL,                 -- cents
  tax_mode     TEXT NOT NULL DEFAULT 'included', -- included | percent | amount
  tax_value    REAL NOT NULL DEFAULT 0,
  split_method TEXT NOT NULL DEFAULT 'equal',
  split_meta   TEXT,                             -- JSON: raw split inputs, for editing
  method       TEXT,                             -- payments: cash | etransfer | other
  created_by   INTEGER NOT NULL REFERENCES users(id),
  updated_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

CREATE TABLE IF NOT EXISTS expense_payers (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,     -- what this person owes, incl. tax + tip
  base       INTEGER NOT NULL DEFAULT 0,
  tax        INTEGER NOT NULL DEFAULT 0,
  tip        INTEGER NOT NULL DEFAULT 0,
  fees       INTEGER NOT NULL DEFAULT 0,
  discount   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (expense_id, user_id)
);
-- Bills an AI assistant read for someone, waiting for them to check and assign
-- items in the app. Drafts never affect balances; saving one creates a real expense.
CREATE TABLE IF NOT EXISTS expense_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),   -- whose review queue it is in
  group_id    INTEGER REFERENCES groups(id),
  description TEXT NOT NULL,
  date        TEXT NOT NULL,
  data        TEXT NOT NULL,                           -- JSON: items, tax, tip, discount, paidBy, warnings…
  source      TEXT NOT NULL DEFAULT 'assistant',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON expense_drafts(user_id);

-- Change log for connected finance trackers: one row per person whose spending an
-- expense create/edit/delete touched, written in the same transaction as the change.
-- The ever-increasing id is the sync cursor (no clocks involved).
CREATE TABLE IF NOT EXISTS finance_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  expense_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_changes_user ON finance_changes(user_id, id);

-- Personal API keys (for AI assistants via MCP, or scripts). Only a SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,                    -- first characters, to recognise a key
  scope        TEXT NOT NULL DEFAULT 'full',     -- full (MCP/API) | finance (read-only spending feed)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_payers_user ON expense_payers(user_id);
CREATE INDEX IF NOT EXISTS idx_splits_user ON expense_splits(user_id);
`;

/** Additive migrations for databases created by older versions. */
async function addColumn(table, column, ddl) {
  const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (!cols.includes(column)) await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

let ready;
/** Create/upgrade the schema once per process (cold start). */
export function dbReady() {
  if (configError) return Promise.reject(configError);
  ready ||= (async () => {
    await client.executeMultiple(SCHEMA);
    await addColumn('expenses', 'tip', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('expenses', 'extras_split', "TEXT NOT NULL DEFAULT 'proportional'");
    await addColumn('expense_splits', 'tip', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('expenses', 'discount', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('expenses', 'discount_split', "TEXT NOT NULL DEFAULT 'proportional'");
    await addColumn('expense_splits', 'discount', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('api_tokens', 'scope', "TEXT NOT NULL DEFAULT 'full'");
    await addColumn('expenses', 'fees', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('expense_splits', 'fees', 'INTEGER NOT NULL DEFAULT 0');
  })().catch((err) => {
    ready = null; // retry on the next request
    throw err;
  });
  return ready;
}

/**
 * JWT signing secret. Production must set SETTLR_SECRET (serverless disks are
 * wiped, so a generated file wouldn't survive). Locally a file is generated once.
 */
let secret;
export function getSecret() {
  if (secret) return secret;
  if (process.env.SETTLR_SECRET) return (secret = process.env.SETTLR_SECRET);
  if (process.env.VERCEL) {
    throw new Error('SETTLR_SECRET is not set. Generate one with `openssl rand -hex 48` and add it to the environment.');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return (secret = fs.readFileSync(file, 'utf8').trim());
}
