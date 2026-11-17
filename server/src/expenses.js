import { db, tx } from './db.js';
import { computeSplit, validatePayers, formatCAD } from '../../shared/split.js';
import { isMember, getUserById, loadExpenses } from './ledger.js';

export const CATEGORIES = [
  'rent', 'utilities', 'internet', 'groceries', 'household', 'dining',
  'transport', 'entertainment', 'subscriptions', 'furniture', 'general',
];
export const PAYMENT_METHODS = ['cash', 'etransfer', 'other'];

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

async function checkUsers(ids, groupId) {
  for (const id of ids) {
    const user = await getUserById(id);
    if (!user) throw new HttpError(400, `Unknown user #${id}.`);
    if (groupId && !(await isMember(groupId, id))) {
      throw new HttpError(400, `${user.display_name} is not a member of this group.`);
    }
  }
}

/**
 * Validate a raw request body and turn it into rows to persist.
 * Amounts in the body are integer cents.
 */
export async function buildExpense(body, actorId) {
  const type = body.type === 'payment' ? 'payment' : 'expense';
  const groupId = body.groupId ? int(body.groupId) : null;
  const date = body.date;
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';

  if (!isDate(date)) throw new HttpError(400, 'Pick a valid date.');
  if (groupId) {
    const g = await db.get('SELECT id FROM groups WHERE id = ?', groupId);
    if (!g) throw new HttpError(404, 'Group not found.');
    if (!(await isMember(groupId, actorId))) throw new HttpError(403, 'You are not a member of this group.');
  }

  if (type === 'payment') {
    const fromId = int(body.fromId);
    const toId = int(body.toId);
    const amount = int(body.amount);
    if (!fromId || !toId) throw new HttpError(400, 'Choose who paid and who received.');
    if (fromId === toId) throw new HttpError(400, 'A payment needs two different people.');
    if (!(amount > 0)) throw new HttpError(400, 'Enter an amount greater than zero.');
    if (amount > 100_000_000) throw new HttpError(400, 'That amount looks too large.');
    await checkUsers([fromId, toId], groupId);
    if (!groupId && actorId !== fromId && actorId !== toId) {
      throw new HttpError(403, 'You can only record payments you are part of.');
    }
    const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
    const [from, to] = await Promise.all([getUserById(fromId), getUserById(toId)]);
    return {
      row: {
        type, group_id: groupId, date, notes,
        description: body.description?.trim() || `${from.display_name} paid ${to.display_name}`,
        category: 'payment', subtotal: amount, tax: 0, tip: 0, fees: 0, extras_split: 'proportional', discount: 0, discount_split: 'proportional', total: amount,
        tax_mode: 'included', tax_value: 0, split_method: 'exact', split_meta: null, method,
      },
      payers: [{ userId: fromId, amount }],
      splits: [{ userId: toId, amount, base: amount, tax: 0 }],
    };
  }

  // ---- Regular expense --------------------------------------------------
  const description = String(body.description || '').trim().slice(0, 140);
  if (!description) throw new HttpError(400, 'Add a description.');
  const category = CATEGORIES.includes(body.category) ? body.category : 'general';

  const tax = {
    mode: ['included', 'percent', 'amount'].includes(body.tax?.mode) ? body.tax.mode : 'included',
    value: Number(body.tax?.value) || 0,
  };
  const s = body.split || {};
  const split = {
    method: s.method,
    participants: (s.participants || []).map(int).filter(Boolean),
    values: Object.fromEntries(Object.entries(s.values || {}).map(([k, v]) => [int(k), Number(v) || 0])),
    items: (s.items || []).slice(0, 200).map((it) => ({
      name: String(it.name || '').trim().slice(0, 80),
      amount: int(it.amount) || 0,
      taxable: it.taxable !== false,
      userIds: (it.userIds || []).map(int).filter(Boolean),
    })),
  };
  const extrasSplit = body.extrasSplit === 'equal' ? 'equal' : 'proportional';
  const tip = int(body.tip) || 0;
  const discount = int(body.discount) || 0;
  const fees = int(body.fees) || 0;
  const discountSplit = body.discountSplit === 'equal' ? 'equal' : 'proportional';
  const result = computeSplit({ amount: int(body.amount) || 0, tax, tip, fees, extrasSplit, discount, discountSplit, split });
  if (result.errors.length) throw new HttpError(400, result.errors[0], result.errors);
  if (result.total > 100_000_000) throw new HttpError(400, 'That amount looks too large.');

  // Merge duplicate payers.
  const payerMap = new Map();
  for (const p of body.payers || []) {
    const id = int(p.userId);
    const amt = int(p.amount);
    if (!id || !amt) continue;
    payerMap.set(id, (payerMap.get(id) || 0) + amt);
  }
  const payers = [...payerMap].map(([userId, amount]) => ({ userId, amount }));
  const payerErrors = validatePayers(payers, result.total);
  if (payerErrors.length) throw new HttpError(400, payerErrors[0], payerErrors);

  const involved = [...new Set([...payers.map((p) => p.userId), ...result.shares.map((x) => x.userId)])];
  await checkUsers(involved, groupId);
  if (!groupId && !involved.includes(actorId)) {
    throw new HttpError(403, 'Include yourself in a non-group expense (as a payer or in the split).');
  }

  // Store raw inputs so the expense can be edited exactly as entered.
  const meta =
    split.method === 'itemized'
      ? { items: split.items }
      : { participants: split.participants, values: split.method === 'equal' ? {} : split.values };

  return {
    row: {
      type, group_id: groupId, date, notes, description, category,
      subtotal: result.subtotal, tax: result.tax, tip: result.tip, fees: result.fees, extras_split: extrasSplit,
      discount: result.discount, discount_split: discountSplit, total: result.total,
      tax_mode: tax.mode, tax_value: tax.value, split_method: split.method,
      split_meta: JSON.stringify(meta), method: null,
    },
    payers,
    splits: result.shares.filter((x) => x.amount > 0),
  };
}

/** Record that an expense changed for these people (finance tracker sync). */
async function logFinanceChanges(q, expenseId, userIds) {
  for (const uid of new Set(userIds)) await q.run('INSERT INTO finance_changes (user_id, expense_id) VALUES (?, ?)', uid, expenseId);
}

export const ACTIVITY_SOURCES = ['app', 'assistant', 'admin'];

/** Append to the activity log (who did what to which expense, and when). */
async function logActivity(q, { actorId, action, expense, involved, changes, source }) {
  await q.run(
    `INSERT INTO activity_log (actor_id, action, expense_id, expense_type, group_id, description, total, date, involved, details, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actorId, action, expense.id, expense.type, expense.group_id ?? null, expense.description, expense.total, expense.date,
    JSON.stringify([...new Set(involved)]), changes?.length ? JSON.stringify({ changes }) : null,
    ACTIVITY_SOURCES.includes(source) ? source : 'app'
  );
}

/** What an edit changed, in a form the app can describe ("Total $25.00 → $30.00"). */
function diffExpense(old, row, payers, splits) {
  const changes = [];
  for (const field of ['description', 'total', 'date', 'category', 'group_id']) {
    if ((old[field] ?? null) !== (row[field] ?? null)) changes.push({ field: field === 'group_id' ? 'group' : field, from: old[field] ?? null, to: row[field] ?? null });
  }
  const asMap = (list) => Object.fromEntries(list.filter((x) => x.amount > 0).map((x) => [x.userId, x.amount]));
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
  const oldPayers = asMap(old.payers);
  const newPayers = asMap(payers);
  if (!same(oldPayers, newPayers)) changes.push({ field: 'payers', from: oldPayers, to: newPayers });
  const oldShares = asMap(old.splits);
  const newShares = asMap(splits);
  if (!same(oldShares, newShares)) changes.push({ field: 'shares', from: oldShares, to: newShares });
  if ((old.notes || '') !== (row.notes || '')) changes.push({ field: 'notes' });
  return changes;
}

async function writeChildren(q, id, payers, splits) {
  await q.run('DELETE FROM expense_payers WHERE expense_id = ?', id);
  await q.run('DELETE FROM expense_splits WHERE expense_id = ?', id);
  for (const p of payers) {
    await q.run('INSERT INTO expense_payers (expense_id, user_id, amount) VALUES (?, ?, ?)', id, p.userId, p.amount);
  }
  for (const x of splits) {
    await q.run(
      'INSERT INTO expense_splits (expense_id, user_id, amount, base, tax, tip, fees, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, x.userId, x.amount, x.base ?? x.amount, x.tax ?? 0, x.tip ?? 0, x.fees ?? 0, x.discount ?? 0
    );
  }
}

export async function createExpense(body, actorId, { source = 'app' } = {}) {
  // Validate (reads) first, then write everything in one transaction.
  const { row, payers, splits } = await buildExpense(body, actorId);
  return tx(async (q) => {
    const info = await q.run(
      `INSERT INTO expenses (type, group_id, description, category, notes, date, subtotal, tax, tip, fees, extras_split, discount, discount_split, total,
        tax_mode, tax_value, split_method, split_meta, method, created_by)
       VALUES (@type, @group_id, @description, @category, @notes, @date, @subtotal, @tax, @tip, @fees, @extras_split, @discount, @discount_split, @total,
        @tax_mode, @tax_value, @split_method, @split_meta, @method, @created_by)`,
      { ...row, created_by: actorId }
    );
    const id = info.lastInsertRowid;
    await writeChildren(q, id, payers, splits);
    if (row.type === 'expense') await logFinanceChanges(q, id, splits.map((x) => x.userId));
    await logActivity(q, {
      actorId, action: 'created', source, expense: { ...row, id },
      involved: [...payers.map((p) => p.userId), ...splits.map((x) => x.userId)],
    });
    return id;
  });
}

export async function updateExpense(id, body, actorId, { source = 'app' } = {}) {
  const existing = await getExpense(id);
  if (!existing) throw new HttpError(404, 'Expense not found.');
  const { row, payers, splits } = await buildExpense({ ...body, type: existing.type }, actorId);
  const before = existing.splits.map((x) => x.userId);
  const changes = diffExpense(existing, row, payers, splits);
  await tx(async (q) => {
    // Everyone before or after the edit gets a change (their share changed, or it no longer counts).
    if (existing.type === 'expense') await logFinanceChanges(q, id, [...before, ...splits.map((x) => x.userId)]);
    await q.run(
      `UPDATE expenses SET group_id=@group_id, description=@description, category=@category, notes=@notes,
         date=@date, subtotal=@subtotal, tax=@tax, tip=@tip, fees=@fees, extras_split=@extras_split, discount=@discount, discount_split=@discount_split, total=@total, tax_mode=@tax_mode,
         tax_value=@tax_value, split_method=@split_method, split_meta=@split_meta, method=@method, updated_by=@updated_by,
         updated_at=datetime('now') WHERE id=@id`,
      { ...row, id, updated_by: actorId }
    );
    await writeChildren(q, id, payers, splits);
    if (changes.length) {
      await logActivity(q, {
        actorId, action: 'updated', source, changes, expense: { ...row, id },
        involved: [...existing.payers.map((p) => p.userId), ...before, ...payers.map((p) => p.userId), ...splits.map((x) => x.userId)],
      });
    }
  });
  return id;
}

/**
 * Delete expenses and their payer/split rows (no reliance on FK cascades).
 * `who` = { actorId, source } for the activity log.
 */
export async function deleteExpenses(q, who, where, ...args) {
  const sub = `SELECT id FROM expenses WHERE ${where}`;
  // Activity: one "deleted" entry per expense, visible to everyone who was on it.
  await q.run(
    `INSERT INTO activity_log (actor_id, action, expense_id, expense_type, group_id, description, total, date, involved, source)
     SELECT ?, 'deleted', e.id, e.type, e.group_id, e.description, e.total, e.date,
       (SELECT json_group_array(user_id) FROM (SELECT user_id FROM expense_payers WHERE expense_id = e.id
                                               UNION SELECT user_id FROM expense_splits WHERE expense_id = e.id)), ?
     FROM expenses e WHERE ${where.replace(/\bid\b/g, 'e.id').replace(/\bgroup_id\b/g, 'e.group_id')}`,
    who.actorId, ACTIVITY_SOURCES.includes(who.source) ? who.source : 'app', ...args
  );
  // Log a change for everyone these counted for, so their finance trackers drop them.
  await q.run(
    `INSERT INTO finance_changes (user_id, expense_id)
     SELECT s.user_id, s.expense_id FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
     WHERE e.type = 'expense' AND s.expense_id IN (${sub})`,
    ...args
  );
  await q.run(`DELETE FROM expense_payers WHERE expense_id IN (${sub})`, ...args);
  await q.run(`DELETE FROM expense_splits WHERE expense_id IN (${sub})`, ...args);
  await q.run(`DELETE FROM expenses WHERE ${where}`, ...args);
}

export async function getExpense(id) {
  return (await loadExpenses('e.id = ?', [id]))[0] || null;
}

export const describeAmount = formatCAD;

// ---------------------------------------------------------------------------
// Drafts: bills read by an AI assistant, waiting for review in the app.
// ---------------------------------------------------------------------------
export const MAX_DRAFTS = 50;

export function draftDto(d) {
  let data = {};
  try {
    data = JSON.parse(d.data || '{}');
  } catch {
    data = {};
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const itemsSum = items.reduce((s, i) => s + (i.amount || 0), 0);
  return {
    id: d.id,
    groupId: d.group_id,
    groupName: d.group_name || null,
    description: d.description,
    date: d.date,
    source: d.source,
    createdAt: d.created_at,
    items,
    tax: data.tax || 0,
    tip: data.tip || 0,
    fees: data.fees || 0,
    discount: data.discount || 0,
    billTotal: data.billTotal ?? null,
    total: itemsSum + (data.tax || 0) + (data.tip || 0) + (data.fees || 0) - (data.discount || 0),
    paidBy: data.paidBy || null,
    category: data.category || null,
    notes: data.notes || '',
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  };
}

export async function listDrafts(userId) {
  const rows = await db.all(
    `SELECT d.*, g.name AS group_name FROM expense_drafts d LEFT JOIN groups g ON g.id = d.group_id
     WHERE d.user_id = ? ORDER BY d.id DESC`,
    userId
  );
  return rows.map(draftDto);
}

export async function getDraft(id, userId) {
  const d = await db.get(
    `SELECT d.*, g.name AS group_name FROM expense_drafts d LEFT JOIN groups g ON g.id = d.group_id
     WHERE d.id = ? AND d.user_id = ?`,
    id, userId
  );
  return d ? draftDto(d) : null;
}

export async function createDraft(userId, { groupId, description, date, data, source = 'assistant' }) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM expense_drafts WHERE user_id = ?', userId);
  if (n >= MAX_DRAFTS) throw new HttpError(400, `There are already ${MAX_DRAFTS} bills waiting for review. Review or discard some in the app first.`);
  const info = await db.run(
    'INSERT INTO expense_drafts (user_id, group_id, description, date, data, source) VALUES (?, ?, ?, ?, ?, ?)',
    userId, groupId || null, String(description).slice(0, 140), date, JSON.stringify(data), source
  );
  return info.lastInsertRowid;
}

export async function deleteDraft(id, userId) {
  const info = await db.run('DELETE FROM expense_drafts WHERE id = ? AND user_id = ?', id, userId);
  return info.changes > 0;
}
