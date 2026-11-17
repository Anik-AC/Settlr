#!/usr/bin/env node
/**
 * Settlr admin tasks (accounts and groups), run from your machine.
 *
 *   npm run admin -- list
 *   npm run admin -- add-user <username> ["Display Name"]      temp password, must change on first login
 *   npm run admin -- reset-password <username>                 new temp password, must change on login
 *   npm run admin -- add-group "<Group name>" <owner> [member ...]
 *
 * Uses the same database settings as the app: DATABASE_URL / DATABASE_AUTH_TOKEN
 * from the environment or the repo-root .env (production Turso), otherwise the
 * local file in server/data. Against a remote database, changes are only shown
 * unless you add --yes.
 */
import '../src/env.js';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, tx, dbReady, DB_LABEL } from '../src/db.js';
import { USERNAME_RE } from '../src/auth.js';
import { getUserByUsername } from '../src/ledger.js';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const [cmd, ...rest] = args.filter((a) => a !== '--yes');
const remote = !!process.env.DATABASE_URL;
const willWrite = !remote || yes;

/** 12 random chars from an unambiguous alphabet, shown as xxxx-xxxx-xxxx. */
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function addUser(usernameIn, displayNameIn) {
  const username = String(usernameIn || '').trim().replace(/^@/, '');
  if (!USERNAME_RE.test(username)) fail(`"${username}" isn't a valid username (3–20 letters, numbers, . _ -).`);
  const displayName = String(displayNameIn || username).trim().slice(0, 40);
  const existing = await getUserByUsername(username);
  if (existing) {
    console.log(`  • @${existing.username} already exists (${existing.display_name}), skipped. Use reset-password to issue a new temporary password.`);
    return null;
  }
  const password = tempPassword();
  if (willWrite) {
    await db.run(
      'INSERT INTO users (username, display_name, password_hash, must_change_password) VALUES (?, ?, ?, 1)',
      username.toLowerCase(), displayName, await bcrypt.hash(password, 10)
    );
  }
  console.log(`  ${willWrite ? '✓' : '(dry run)'} @${username.toLowerCase()}  "${displayName}"  temporary password: ${willWrite ? password : '(generated on --yes)'}`);
  return password;
}

async function resetPassword(usernameIn) {
  const user = await getUserByUsername(usernameIn);
  if (!user) fail(`No user @${String(usernameIn).replace(/^@/, '')}.`);
  const password = tempPassword();
  if (willWrite) {
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await bcrypt.hash(password, 10), user.id);
  }
  console.log(`  ${willWrite ? '✓' : '(dry run)'} @${user.username}  new temporary password: ${willWrite ? password : '(generated on --yes)'}`);
}

async function addGroup(nameIn, ownerName, memberNames) {
  const name = String(nameIn || '').trim().slice(0, 60);
  if (!name) fail('Give the group a name.');
  const usernames = [ownerName, ...memberNames];
  const users = [];
  for (const u of usernames) {
    const user = await getUserByUsername(u);
    if (!user) fail(`No user @${String(u).replace(/^@/, '')}. Create them first with add-user.`);
    if (!users.some((x) => x.id === user.id)) users.push(user);
  }
  const owner = users[0];
  const dup = await db.get(
    `SELECT g.id FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
     WHERE g.name = ? COLLATE NOCASE`,
    owner.id, name
  );
  if (dup) {
    const have = (await db.all('SELECT user_id FROM group_members WHERE group_id = ?', dup.id)).map((r) => r.user_id);
    const missing = users.filter((u) => !have.includes(u.id));
    if (willWrite) for (const u of missing) await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', dup.id, u.id);
    console.log(`  • Group "${name}" already exists (#${dup.id}).${missing.length ? ` ${willWrite ? 'Added' : 'Would add'}: ${missing.map((u) => '@' + u.username).join(', ')}` : ' Everyone is already in it.'}`);
    return;
  }
  if (willWrite) {
    const gid = await tx(async (q) => {
      const info = await q.run("INSERT INTO groups (name, kind, simplify, created_by) VALUES (?, 'other', 1, ?)", name, owner.id);
      for (const u of users) await q.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', info.lastInsertRowid, u.id);
      return info.lastInsertRowid;
    });
    console.log(`  ✓ Group "${name}" (#${gid}) with ${users.map((u) => '@' + u.username).join(', ')}`);
  } else {
    console.log(`  (dry run) Group "${name}" with ${users.map((u) => '@' + u.username).join(', ')}`);
  }
}

async function list() {
  const users = await db.all('SELECT id, username, display_name, must_change_password, created_at FROM users ORDER BY id');
  console.log(`  ${users.length} user(s):`);
  for (const u of users) console.log(`   #${u.id} @${u.username}  "${u.display_name}"${u.must_change_password ? '  (temporary password)' : ''}  since ${u.created_at.slice(0, 10)}`);
  const groups = await db.all(
    `SELECT g.id, g.name, group_concat(u.username, ', ') AS members FROM groups g
     JOIN group_members m ON m.group_id = g.id JOIN users u ON u.id = m.user_id GROUP BY g.id ORDER BY g.id`
  );
  console.log(`  ${groups.length} group(s):`);
  for (const g of groups) console.log(`   #${g.id} "${g.name}": ${g.members}`);
}

const HELP = `Usage:
  npm run admin -- list
  npm run admin -- add-user <username> ["Display Name"]
  npm run admin -- reset-password <username>
  npm run admin -- add-group "<Group name>" <owner> [member ...]
Add --yes to apply changes to a remote (production) database.`;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(HELP);
  process.exit(0);
}

console.log(`\n  Database: ${DB_LABEL}${remote ? '  (REMOTE)' : ''}`);
if (remote && !yes && cmd !== 'list') console.log('  Dry run: nothing will be written. Re-run with --yes to apply.\n');
else console.log('');
// Same additive schema upgrade the app runs on deploy; skipped on remote dry runs.
if (willWrite) await dbReady();

if (cmd === 'list') await list();
else if (cmd === 'add-user') await addUser(rest[0], rest[1]);
else if (cmd === 'reset-password') await resetPassword(rest[0]);
else if (cmd === 'add-group') await addGroup(rest[0], rest[1], rest.slice(2));
else fail(`Unknown command "${cmd}".\n\n${HELP}`);
console.log('');
