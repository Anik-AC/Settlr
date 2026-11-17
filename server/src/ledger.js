import { db } from './db.js';
import { expenseDebts, simplifyDebts } from '../../shared/split.js';

export const publicUser = (u) => (u ? { id: u.id, username: u.username, displayName: u.display_name } : null);

export function getUserById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', id);
}
export function getUserByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', String(username || '').trim().replace(/^@/, ''));
}

/** Map of id -> public user for the given ids. */
export async function peopleMap(ids) {
  const uniq = [...new Set(ids)].filter((x) => x != null);
  if (!uniq.length) return {};
  const rows = await db.all(`SELECT * FROM users WHERE id IN (${uniq.map(() => '?').join(',')})`, ...uniq);
  return Object.fromEntries(rows.map((r) => [r.id, publicUser(r)]));
}

export async function groupIdsFor(userId) {
  return (await db.all('SELECT group_id FROM group_members WHERE user_id = ?', userId)).map((r) => r.group_id);
}
export async function isMember(groupId, userId) {
  return !!(await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId));
}
export async function groupMemberIds(groupId) {
  return (await db.all('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id', groupId)).map((r) => r.user_id);
}

/** Load expenses (with payers + splits) for the given WHERE clause. */
export async function loadExpenses(where = '1=1', params = [], { limit, offset } = {}) {
  let sql = `SELECT e.*, g.name AS group_name FROM expenses e LEFT JOIN groups g ON g.id = e.group_id
             WHERE ${where} ORDER BY e.date DESC, e.id DESC`;
  if (limit) sql += ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`;
  const rows = await db.all(sql, ...params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const [payers, splits] = await Promise.all([
    db.all(`SELECT * FROM expense_payers WHERE expense_id IN (${ph})`, ...ids),
    db.all(`SELECT * FROM expense_splits WHERE expense_id IN (${ph})`, ...ids),
  ]);
  const byId = new Map(rows.map((r) => [r.id, { ...r, payers: [], splits: [] }]));
  for (const p of payers) byId.get(p.expense_id).payers.push({ userId: p.user_id, amount: p.amount });
  for (const s of splits) byId.get(s.expense_id).splits.push({ userId: s.user_id, amount: s.amount, base: s.base, tax: s.tax, tip: s.tip || 0 });
  return rows.map((r) => byId.get(r.id));
}

/** Expenses the user can see: in one of their groups, or they are involved. */
export const VISIBLE_SQL = `(
  e.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
  OR e.id IN (SELECT expense_id FROM expense_payers WHERE user_id = ?)
  OR e.id IN (SELECT expense_id FROM expense_splits WHERE user_id = ?)
)`;
export const INVOLVED_SQL = `(
  e.id IN (SELECT expense_id FROM expense_payers WHERE user_id = ?)
  OR e.id IN (SELECT expense_id FROM expense_splits WHERE user_id = ?)
)`;

export async function canView(expense, userId) {
  if (expense.group_id && (await isMember(expense.group_id, userId))) return true;
  return expense.payers.some((p) => p.userId === userId) || expense.splits.some((s) => s.userId === userId);
}

export function serializeExpense(e) {
  let meta = null;
  try {
    meta = e.split_meta ? JSON.parse(e.split_meta) : null;
  } catch {
    meta = null;
  }
  return {
    id: e.id,
    type: e.type,
    groupId: e.group_id,
    groupName: e.group_name || null,
    description: e.description,
    category: e.category,
    notes: e.notes || '',
    date: e.date,
    currency: e.currency,
    subtotal: e.subtotal,
    tax: e.tax,
    tip: e.tip || 0,
    extrasSplit: e.extras_split || 'proportional',
    total: e.total,
    taxMode: e.tax_mode,
    taxValue: e.tax_value,
    splitMethod: e.split_method,
    splitMeta: meta,
    method: e.method,
    payers: e.payers,
    splits: e.splits,
    createdBy: e.created_by,
    updatedBy: e.updated_by,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

/** Collect every user id referenced by a list of expenses. */
export function expenseUserIds(list) {
  const ids = [];
  for (const e of list) {
    ids.push(e.created_by, e.updated_by);
    e.payers.forEach((p) => ids.push(p.userId));
    e.splits.forEach((s) => ids.push(s.userId));
  }
  return ids;
}

/** Net position per user (positive = is owed money). */
export function netBalances(expenses) {
  const net = new Map();
  for (const e of expenses) {
    for (const p of e.payers) net.set(p.userId, (net.get(p.userId) || 0) + p.amount);
    for (const s of e.splits) net.set(s.userId, (net.get(s.userId) || 0) - s.amount);
  }
  return net;
}

/**
 * Direct (unsimplified) balances between `userId` and everyone else.
 * Returns Map otherId -> { total, groups: Map(groupId|0 -> cents) }
 * where positive = they owe you.
 */
export function pairwiseFor(userId, expenses) {
  const out = new Map();
  const bump = (other, groupId, cents) => {
    if (!out.has(other)) out.set(other, { total: 0, groups: new Map() });
    const rec = out.get(other);
    rec.total += cents;
    const g = groupId || 0;
    rec.groups.set(g, (rec.groups.get(g) || 0) + cents);
  };
  for (const e of expenses) {
    for (const d of expenseDebts(e.payers, e.splits)) {
      if (d.to === userId) bump(d.from, e.group_id, d.amount);
      else if (d.from === userId) bump(d.to, e.group_id, -d.amount);
    }
  }
  return out;
}

/** All pairwise debts among a set of expenses, netted per pair. [{from,to,amount}] */
export function pairwiseAll(expenses) {
  const m = new Map();
  for (const e of expenses) {
    for (const d of expenseDebts(e.payers, e.splits)) {
      const [a, b] = d.from < d.to ? [d.from, d.to] : [d.to, d.from];
      const k = `${a}|${b}`;
      // positive => a owes b
      m.set(k, (m.get(k) || 0) + (d.from === a ? d.amount : -d.amount));
    }
  }
  const out = [];
  for (const [k, v] of m) {
    if (!v) continue;
    const [a, b] = k.split('|').map(Number);
    out.push(v > 0 ? { from: a, to: b, amount: v } : { from: b, to: a, amount: -v });
  }
  return out.sort((x, y) => y.amount - x.amount);
}

export function groupExpenses(groupId) {
  return loadExpenses('e.group_id = ?', [groupId]);
}

/** Summary of a group: member nets + suggested settlements. */
export async function groupSummary(group, viewerId) {
  const [expenses, memberIds] = await Promise.all([groupExpenses(group.id), groupMemberIds(group.id)]);
  const nets = netBalances(expenses);
  // Include ex-members who still have a balance.
  const ids = [...new Set([...memberIds, ...nets.keys()])];
  const members = ids.map((id) => ({ userId: id, net: nets.get(id) || 0, active: memberIds.includes(id) }));
  const settlements = group.simplify ? simplifyDebts(nets) : pairwiseAll(expenses);
  const spent = expenses.filter((e) => e.type === 'expense').reduce((a, e) => a + e.total, 0);
  const mySpend = expenses
    .filter((e) => e.type === 'expense')
    .reduce((a, e) => a + (e.splits.find((s) => s.userId === viewerId)?.amount || 0), 0);
  return {
    members,
    memberIds,
    settlements,
    myNet: nets.get(viewerId) || 0,
    totalSpent: spent,
    mySpend,
    expenseCount: expenses.filter((e) => e.type === 'expense').length,
    lastActivity: expenses[0]?.date || null,
  };
}
