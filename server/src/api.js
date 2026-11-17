import { Router } from 'express';
import { db, tx } from './db.js';
import { simplifyDebts } from '../../shared/split.js';
import {
  publicUser, getUserByUsername, peopleMap, groupIdsFor, isMember, groupMemberIds,
  loadExpenses, VISIBLE_SQL, INVOLVED_SQL, canView, serializeExpense, expenseUserIds,
  netBalances, pairwiseFor, groupSummary,
} from './ledger.js';
import { createExpense, updateExpense, getExpense, deleteExpenses, HttpError, CATEGORIES } from './expenses.js';

export const api = Router();
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

async function respondExpenses(res, list, extra = {}) {
  res.json({
    expenses: list.map(serializeExpense),
    people: await peopleMap(expenseUserIds(list)),
    ...extra,
  });
}

async function loadGroup(id, userId) {
  const group = await db.get('SELECT * FROM groups WHERE id = ?', int(id));
  if (!group) throw new HttpError(404, 'Group not found.');
  if (!(await isMember(group.id, userId))) throw new HttpError(403, 'You are not a member of this group.');
  return group;
}

const groupDto = (g) => ({ id: g.id, name: g.name, kind: g.kind, simplify: !!g.simplify, createdBy: g.created_by, createdAt: g.created_at });

/** Group-name lookup for breakdowns. */
async function groupNames(ids) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return {};
  const rows = await db.all(`SELECT id, name FROM groups WHERE id IN (${uniq.map(() => '?').join(',')})`, ...uniq);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** The viewer's groups with their summaries, loaded in parallel. */
export async function myGroups(me) {
  const ids = await groupIdsFor(me);
  return Promise.all(
    ids.map(async (gid) => {
      const g = await db.get('SELECT * FROM groups WHERE id = ?', gid);
      return { g, s: await groupSummary(g, me) };
    })
  );
}

/** Balances between the viewer and everyone they share expenses with. */
export async function peopleBalances(userId) {
  const [mine, mateRows] = await Promise.all([
    loadExpenses(INVOLVED_SQL, [userId, userId]),
    db.all(
      `SELECT DISTINCT gm.user_id FROM group_members gm
       WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) AND gm.user_id != ?`,
      userId, userId
    ),
  ]);
  const pairs = pairwiseFor(userId, mine);
  // Also list group-mates with zero balance so you can always find them.
  for (const { user_id: id } of mateRows) if (!pairs.has(id)) pairs.set(id, { total: 0, groups: new Map() });
  pairs.delete(userId);
  const [names, people] = await Promise.all([
    groupNames([...pairs.values()].flatMap((p) => [...p.groups.keys()])),
    peopleMap([...pairs.keys()]),
  ]);
  const lastShared = new Map();
  for (const e of mine) {
    for (const id of [...e.payers.map((p) => p.userId), ...e.splits.map((s) => s.userId)]) {
      if (!lastShared.has(id)) lastShared.set(id, e.date);
    }
  }
  return [...pairs]
    .map(([id, p]) => ({
      user: people[id],
      balance: p.total,
      lastShared: lastShared.get(id) || null,
      groups: [...p.groups]
        .filter(([, v]) => v !== 0)
        .map(([gid, amount]) => ({ groupId: gid || null, groupName: gid ? names[gid] || 'Group' : null, amount })),
    }))
    .filter((p) => p.user)
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.user.displayName.localeCompare(b.user.displayName));
}

/**
 * Simplified settlements across everyone connected to the viewer through
 * shared expenses (a connected component always nets to zero, so the
 * suggested transfers fully settle everyone in it).
 */
async function simplifiedFor(userId) {
  const all = await loadExpenses();
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const e of all) {
    const ids = [...e.payers.map((p) => p.userId), ...e.splits.map((s) => s.userId)];
    ids.forEach((id) => union(ids[0], id));
  }
  const root = find(userId);
  const component = all.filter((e) => find(e.payers[0]?.userId ?? e.splits[0]?.userId) === root);
  const transfers = simplifyDebts(netBalances(component));
  const mine = transfers.filter((t) => t.from === userId || t.to === userId);
  return {
    transfers: mine,
    everyone: transfers,
    people: await peopleMap(transfers.flatMap((t) => [t.from, t.to])),
  };
}

// ---------------------------------------------------------------------------
// Users / people
// ---------------------------------------------------------------------------

api.get('/users/search', async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = await db.all(
    `SELECT * FROM users WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
     ORDER BY (username = ? COLLATE NOCASE) DESC, username LIMIT 10`,
    req.user.id, like, like, q
  );
  res.json({ users: rows.map(publicUser) });
});

api.get('/people', async (req, res) => {
  const [people, simplified] = await Promise.all([peopleBalances(req.user.id), simplifiedFor(req.user.id)]);
  res.json({ people, simplified });
});

api.get('/people/:username', async (req, res) => {
  const other = await getUserByUsername(req.params.username);
  if (!other) throw new HttpError(404, 'No one with that username.');
  const me = req.user.id;
  const [shared, sharedGroupRows] = await Promise.all([
    loadExpenses(
      `${INVOLVED_SQL} AND (e.id IN (SELECT expense_id FROM expense_payers WHERE user_id = ?)
         OR e.id IN (SELECT expense_id FROM expense_splits WHERE user_id = ?))`,
      [me, me, other.id, other.id]
    ),
    db.all(
      `SELECT g.* FROM groups g JOIN group_members a ON a.group_id = g.id AND a.user_id = ?
       JOIN group_members b ON b.group_id = g.id AND b.user_id = ? ORDER BY g.name`,
      me, other.id
    ),
  ]);
  const rec = pairwiseFor(me, shared).get(other.id) || { total: 0, groups: new Map() };
  const names = await groupNames([...rec.groups.keys()]);
  await respondExpenses(res, shared, {
    user: publicUser(other),
    balance: rec.total,
    groups: [...rec.groups]
      .filter(([, v]) => v !== 0)
      .map(([gid, amount]) => ({ groupId: gid || null, groupName: gid ? names[gid] : null, amount })),
    sharedGroups: sharedGroupRows.map(groupDto),
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

api.get('/dashboard', async (req, res) => {
  const me = req.user.id;
  // Spending this month (your share of expenses).
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [people, mine, recent, monthRows] = await Promise.all([
    peopleBalances(me),
    myGroups(me),
    loadExpenses(VISIBLE_SQL, [me, me, me], { limit: 6 }),
    loadExpenses(`${INVOLVED_SQL} AND e.type = 'expense' AND substr(e.date, 1, 7) = ?`, [me, me, month]),
  ]);
  const owed = people.filter((p) => p.balance > 0).reduce((a, p) => a + p.balance, 0);
  const owe = people.filter((p) => p.balance < 0).reduce((a, p) => a - p.balance, 0);
  const groups = mine.map(({ g, s }) => ({ ...groupDto(g), myNet: s.myNet, memberIds: s.memberIds, lastActivity: s.lastActivity }));
  const monthShare = monthRows.reduce((a, e) => a + (e.splits.find((s) => s.userId === me)?.amount || 0), 0);
  const byCategory = {};
  for (const e of monthRows) {
    const share = e.splits.find((s) => s.userId === me)?.amount || 0;
    if (share) byCategory[e.category] = (byCategory[e.category] || 0) + share;
  }
  await respondExpenses(res, recent, {
    totals: { owed, owe, net: owed - owe },
    month: { key: month, share: monthShare, byCategory },
    balances: people,
    groups,
    groupPeople: await peopleMap(groups.flatMap((g) => g.memberIds)),
  });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_KINDS = ['home', 'trip', 'couple', 'other'];

api.get('/groups', async (req, res) => {
  const groups = (await myGroups(req.user.id)).map(({ g, s }) => ({
    ...groupDto(g),
    myNet: s.myNet,
    totalSpent: s.totalSpent,
    expenseCount: s.expenseCount,
    lastActivity: s.lastActivity,
    memberIds: s.memberIds,
  }));
  groups.sort((a, b) => String(b.lastActivity || b.createdAt).localeCompare(String(a.lastActivity || a.createdAt)));
  res.json({ groups, people: await peopleMap(groups.flatMap((g) => g.memberIds)) });
});

api.post('/groups', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Give the group a name.');
  const kind = GROUP_KINDS.includes(req.body.kind) ? req.body.kind : 'home';
  const members = new Set([req.user.id]);
  for (const u of req.body.members || []) {
    const user = await getUserByUsername(u);
    if (!user) throw new HttpError(400, `No one with the username @${String(u).replace(/^@/, '')}.`);
    members.add(user.id);
  }
  const gid = await tx(async (q) => {
    const info = await q.run(
      'INSERT INTO groups (name, kind, simplify, created_by) VALUES (?, ?, ?, ?)',
      name, kind, req.body.simplify === false ? 0 : 1, req.user.id
    );
    for (const id of members) await q.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', info.lastInsertRowid, id);
    return info.lastInsertRowid;
  });
  res.status(201).json({ group: groupDto(await db.get('SELECT * FROM groups WHERE id = ?', gid)) });
});

api.get('/groups/:id', async (req, res) => {
  const group = await loadGroup(req.params.id, req.user.id);
  const summary = await groupSummary(group, req.user.id);
  res.json({
    group: { ...groupDto(group), memberIds: summary.memberIds },
    summary,
    people: await peopleMap([...summary.memberIds, ...summary.members.map((m) => m.userId)]),
  });
});

api.patch('/groups/:id', async (req, res) => {
  const group = await loadGroup(req.params.id, req.user.id);
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 60) : group.name;
  if (!name) throw new HttpError(400, 'Give the group a name.');
  const kind = GROUP_KINDS.includes(req.body.kind) ? req.body.kind : group.kind;
  const simplify = req.body.simplify !== undefined ? (req.body.simplify ? 1 : 0) : group.simplify;
  await db.run('UPDATE groups SET name = ?, kind = ?, simplify = ? WHERE id = ?', name, kind, simplify, group.id);
  res.json({ group: groupDto(await db.get('SELECT * FROM groups WHERE id = ?', group.id)) });
});

api.delete('/groups/:id', async (req, res) => {
  const group = await loadGroup(req.params.id, req.user.id);
  const s = await groupSummary(group, req.user.id);
  if (s.members.some((m) => m.net !== 0)) {
    throw new HttpError(400, 'Settle all balances in this group before deleting it.');
  }
  await tx(async (q) => {
    await deleteExpenses(q, 'group_id = ?', group.id);
    await q.run('DELETE FROM group_members WHERE group_id = ?', group.id);
    await q.run('DELETE FROM groups WHERE id = ?', group.id);
  });
  res.json({ ok: true });
});

api.post('/groups/:id/members', async (req, res) => {
  const group = await loadGroup(req.params.id, req.user.id);
  const user = await getUserByUsername(req.body.username);
  if (!user) throw new HttpError(404, `No one with the username @${String(req.body.username || '').replace(/^@/, '')}.`);
  if (await isMember(group.id, user.id)) throw new HttpError(409, `${user.display_name} is already in this group.`);
  await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', group.id, user.id);
  res.status(201).json({ user: publicUser(user) });
});

api.delete('/groups/:id/members/:userId', async (req, res) => {
  const group = await loadGroup(req.params.id, req.user.id);
  const uid = int(req.params.userId);
  const s = await groupSummary(group, req.user.id);
  const m = s.members.find((x) => x.userId === uid);
  if (m && m.net !== 0) throw new HttpError(400, 'This person still has an unsettled balance in the group.');
  await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, uid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Expenses & payments
// ---------------------------------------------------------------------------

api.get('/meta', (_req, res) => res.json({ categories: CATEGORIES, currency: 'CAD' }));

api.get('/expenses', async (req, res) => {
  const me = req.user.id;
  const where = [VISIBLE_SQL];
  const params = [me, me, me];
  if (req.query.groupId) {
    await loadGroup(req.query.groupId, me);
    where.push('e.group_id = ?');
    params.push(int(req.query.groupId));
  }
  if (req.query.type === 'expense' || req.query.type === 'payment') {
    where.push('e.type = ?');
    params.push(req.query.type);
  }
  if (req.query.q) {
    where.push('(e.description LIKE ? OR e.notes LIKE ?)');
    const like = `%${String(req.query.q).trim()}%`;
    params.push(like, like);
  }
  const limit = Math.min(int(req.query.limit) || 50, 200);
  const offset = int(req.query.offset) || 0;
  const list = await loadExpenses(where.join(' AND '), params, { limit: limit + 1, offset });
  await respondExpenses(res, list.slice(0, limit), { hasMore: list.length > limit });
});

api.post('/expenses', async (req, res) => {
  const id = await createExpense(req.body, req.user.id);
  const e = await getExpense(id);
  res.status(201).json({ expense: serializeExpense(e), people: await peopleMap(expenseUserIds([e])) });
});

async function loadVisibleExpense(id, userId) {
  const e = await getExpense(int(id));
  if (!e || !(await canView(e, userId))) throw new HttpError(404, 'Expense not found.');
  return e;
}

api.get('/expenses/:id', async (req, res) => {
  const e = await loadVisibleExpense(req.params.id, req.user.id);
  const extraIds = e.group_id ? await groupMemberIds(e.group_id) : [];
  res.json({ expense: serializeExpense(e), people: await peopleMap([...expenseUserIds([e]), ...extraIds]) });
});

api.put('/expenses/:id', async (req, res) => {
  await loadVisibleExpense(req.params.id, req.user.id);
  const id = await updateExpense(int(req.params.id), req.body, req.user.id);
  const e = await getExpense(id);
  res.json({ expense: serializeExpense(e), people: await peopleMap(expenseUserIds([e])) });
});

api.delete('/expenses/:id', async (req, res) => {
  const e = await loadVisibleExpense(req.params.id, req.user.id);
  await tx((q) => deleteExpenses(q, 'id = ?', e.id));
  res.json({ ok: true });
});
