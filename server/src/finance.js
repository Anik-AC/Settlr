import { Router } from 'express';
import { db } from './db.js';
import { loadExpenses, peopleMap, publicUser } from './ledger.js';
import { HttpError } from './expenses.js';

/**
 * Read-only spending feed for a connected finance tracker (docs/FINANCE-API.md).
 *
 * "Spending" = the user's own share of each expense (incl. their part of tax and
 * tip, minus their part of any discount), on the bill's date, whoever paid.
 * Settle-up payments are transfers, not spending, so they're not included.
 *
 * Sync is a change feed: the first call returns a full snapshot; after that the
 * tracker sends the cursor from its last sync and gets every expense that was
 * added/edited since (whatever its bill date) plus the ones that no longer count
 * for this user. The cursor is an id in the finance_changes log, written in the
 * same transaction as each change, so nothing can be skipped.
 */

export const financeRouter = Router();

const CURRENCY = 'CAD';
const MAX_LIMIT = 1000;
const iso = (t) => (t ? `${String(t).replace(' ', 'T')}Z` : null);
const dollars = (c) => (c / 100).toFixed(2);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Cursor: { p: 's', upto, after } while sending the first full snapshot (after = last expense id),
// then { p: 'l', after } for the change log (after = last finance_changes id).
function encodeCursor(c) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(s) {
  try {
    const c = JSON.parse(Buffer.from(String(s), 'base64url').toString());
    if ((c.p === 's' && Number.isInteger(c.upto) && Number.isInteger(c.after)) || (c.p === 'l' && Number.isInteger(c.after))) return c;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'That sync cursor isn’t valid. Start again without `since` to do a full sync.');
}

/** One expense -> the user's spending transaction. */
function toTransaction(e, userId, people) {
  const share = e.splits.find((s) => s.userId === userId);
  const youPaid = e.payers.filter((p) => p.userId === userId).reduce((a, p) => a + p.amount, 0);
  return {
    id: `settlr:${e.id}`,
    expense_id: e.id,
    date: e.date,
    description: e.description,
    category: e.category,
    group: e.group_name || null,
    amount: dollars(share.amount),
    amount_cents: share.amount,
    currency: CURRENCY,
    breakdown_cents: { items: share.base, tax: share.tax, tip: share.tip || 0, discount: share.discount || 0 },
    expense_total_cents: e.total,
    you_paid_cents: youPaid,
    paid_by: e.payers.map((p) => ({ username: people[p.userId]?.username || null, amount_cents: p.amount })),
    created_at: iso(e.created_at),
    updated_at: iso(e.updated_at),
  };
}

financeRouter.get('/me', async (req, res) => {
  res.json({
    user: publicUser(req.user),
    currency: CURRENCY,
    connection: req.apiKeyScope === 'finance' ? 'finance' : req.apiKeyScope ? 'api_key' : 'session',
  });
});

financeRouter.get('/transactions', async (req, res) => {
  const me = req.user.id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), MAX_LIMIT);
  let cur;
  if (req.query.since) cur = decodeCursor(req.query.since);
  else {
    // First sync: remember where the change log is now, then send a full snapshot.
    // Changes made during the snapshot are re-sent afterwards (upserts are idempotent).
    const { m } = await db.get('SELECT COALESCE(MAX(id), 0) AS m FROM finance_changes');
    cur = { p: 's', upto: m, after: 0 };
  }

  let expenseIds;
  let next;
  let hasMore;
  if (cur.p === 's') {
    const rows = await db.all(
      `SELECT e.id FROM expenses e
       WHERE e.type = 'expense' AND e.id > ?
         AND e.id IN (SELECT expense_id FROM expense_splits WHERE user_id = ? AND amount > 0)
       ORDER BY e.id LIMIT ?`,
      cur.after, me, limit + 1
    );
    hasMore = rows.length > limit;
    expenseIds = rows.slice(0, limit).map((r) => r.id);
    next = hasMore ? { p: 's', upto: cur.upto, after: expenseIds.at(-1) } : { p: 'l', after: cur.upto };
  } else {
    const rows = await db.all('SELECT id, expense_id FROM finance_changes WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?', me, cur.after, limit + 1);
    hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    expenseIds = [...new Set(page.map((r) => r.expense_id))];
    next = { p: 'l', after: page.length ? page.at(-1).id : cur.after };
  }

  // Current state of each changed expense, for this user.
  const expenses = expenseIds.length ? await loadExpenses(`e.id IN (${expenseIds.map(() => '?').join(',')})`, expenseIds) : [];
  const counts = (e) => e && e.type === 'expense' && e.splits.some((s) => s.userId === me && s.amount > 0);
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const live = expenses.filter(counts);
  const people = await peopleMap(live.flatMap((e) => e.payers.map((p) => p.userId)));
  const transactions = live.map((e) => toTransaction(e, me, people)).sort((a, b) => a.date.localeCompare(b.date) || a.expense_id - b.expense_id);
  // Deleted, or this user is no longer part of it.
  const removed = expenseIds.filter((id) => !counts(byId.get(id))).map((id) => ({ id: `settlr:${id}`, expense_id: id }));

  res.json({ transactions, removed, next_cursor: encodeCursor(next), has_more: hasMore, currency: CURRENCY });
});

financeRouter.get('/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'Give from and to as YYYY-MM-DD (from ≤ to).');
  const rows = await db.all(
    `SELECT e.date, e.category, s.amount FROM expenses e JOIN expense_splits s ON s.expense_id = e.id
     WHERE e.type = 'expense' AND s.user_id = ? AND s.amount > 0 AND e.date BETWEEN ? AND ?`,
    req.user.id, from, to
  );
  const byCategory = {};
  const byDay = {};
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    byDay[r.date] = (byDay[r.date] || 0) + r.amount;
  }
  res.json({ from, to, currency: CURRENCY, total_cents: total, by_category_cents: byCategory, by_day_cents: byDay, expenses: rows.length });
});
