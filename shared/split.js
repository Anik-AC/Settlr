/**
 * Shared money logic for Settlr.
 *
 * Used by the server (authoritative calculation + validation) and by the
 * client (live preview while the user is typing). Every amount is an integer
 * number of cents to avoid floating-point drift.
 */

export const SPLIT_METHODS = ['equal', 'exact', 'percent', 'shares', 'itemized'];
export const TAX_MODES = ['included', 'percent', 'amount'];
/** How tax + tip are shared: in proportion to each person's portion, or equally per head. */
export const EXTRAS_SPLITS = ['proportional', 'equal'];

/** Parse a user-entered dollar string ("12.5", "$1,200.00") into cents. */
export function toCents(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (value == null) return 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Cents -> "12.50" (no currency symbol). */
export function centsToInput(cents) {
  if (!cents) return '';
  return (cents / 100).toFixed(2);
}

const cadFormatter = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** Cents -> "$12.50" (CAD). */
export function formatCAD(cents, { signed = false } = {}) {
  const s = cadFormatter.format(Math.abs(cents || 0) / 100);
  if (!signed || !cents) return s;
  return (cents < 0 ? '−' : '+') + s;
}

/**
 * Split an integer `total` into integer parts proportional to `weights`
 * using the largest-remainder method, so the parts always sum to `total`.
 * Ties are broken by index order, which keeps results deterministic.
 */
export function allocate(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return new Array(n).fill(0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = w.map((x) => (abs * x) / sum);
  const floors = raw.map(Math.floor);
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .filter((o) => w[o.i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && order.length; k = (k + 1) % order.length) {
    floors[order[k].i] += 1;
    remainder -= 1;
  }
  return floors.map((x) => x * sign);
}

/**
 * Compute who owes what for an expense.
 *
 * input = {
 *   amount: cents (pre-tax subtotal; ignored for itemized — items are summed),
 *   tax: { mode: 'included' | 'percent' | 'amount', value: number },
 *        // percent: e.g. 13 for 13 %; amount: cents
 *   tip: cents (optional, never taxed),
 *   discount: cents (optional) — a bill-level coupon/promo taken off the total,
 *   discountSplit: 'proportional' (default: by what each person had) | 'equal'
 *   extrasSplit: 'proportional' (default) | 'equal'
 *        // proportional: tax/tip follow each person's (taxable) portion
 *        // equal: tax is split evenly among people with taxable items, tip among everyone
 *   split: {
 *     method: 'equal' | 'exact' | 'percent' | 'shares' | 'itemized',
 *     participants: [userId],             // equal / exact / percent / shares
 *     values: { [userId]: number },       // exact: cents, percent: %, shares: units
 *     items: [{ name, amount (cents), taxable, userIds: [userId] }]  // itemized
 *   }
 * }
 *
 * Returns { subtotal, tax, tip, total, shares: [{ userId, amount, base, tax, tip }], errors: [] }
 */
export function computeSplit(input) {
  const errors = [];
  const split = input?.split || {};
  const method = split.method || 'equal';
  const taxCfg = input?.tax || { mode: 'included', value: 0 };
  const values = split.values || {};
  const extrasSplit = input?.extrasSplit || 'proportional';
  const tip = Math.round(Number(input?.tip) || 0);
  const discount = Math.round(Number(input?.discount) || 0);
  const discountSplit = input?.discountSplit || 'proportional';

  if (!SPLIT_METHODS.includes(method)) errors.push('Unknown split method.');
  if (!TAX_MODES.includes(taxCfg.mode)) errors.push('Unknown tax mode.');
  if (!EXTRAS_SPLITS.includes(extrasSplit)) errors.push('Unknown tax/tip split.');
  if (tip < 0) errors.push('Tip cannot be negative.');
  if (discount < 0) errors.push('Discount cannot be negative.');
  if (!EXTRAS_SPLITS.includes(discountSplit)) errors.push('Unknown discount split.');

  /** userId -> pre-tax base share; userId -> taxable base share */
  const base = new Map();
  const taxable = new Map();
  const add = (map, id, cents) => map.set(id, (map.get(id) || 0) + cents);

  let subtotal = 0;

  if (method === 'itemized') {
    const items = (split.items || []).filter((it) => it && (it.amount || (it.userIds || []).length));
    if (!items.length) errors.push('Add at least one item.');
    items.forEach((it, idx) => {
      const amt = Math.round(it.amount || 0);
      const ids = [...new Set(it.userIds || [])];
      const label = it.name?.trim() ? `"${it.name.trim()}"` : `Item ${idx + 1}`;
      if (amt <= 0) errors.push(`${label} needs an amount.`);
      if (!ids.length) errors.push(`${label} needs at least one person.`);
      if (amt <= 0 || !ids.length) return;
      subtotal += amt;
      const parts = allocate(amt, ids.map(() => 1));
      ids.forEach((id, i) => {
        add(base, id, parts[i]);
        if (it.taxable !== false) add(taxable, id, parts[i]);
      });
    });
  } else {
    subtotal = Math.round(input?.amount || 0);
    const ids = [...new Set(split.participants || [])];
    if (subtotal <= 0) errors.push('Enter an amount greater than zero.');
    if (!ids.length) errors.push('Choose at least one person to split with.');

    if (ids.length && subtotal > 0) {
      let parts = [];
      if (method === 'equal') {
        parts = allocate(subtotal, ids.map(() => 1));
      } else if (method === 'exact') {
        parts = ids.map((id) => Math.round(values[id] || 0));
        const sum = parts.reduce((a, b) => a + b, 0);
        if (parts.some((p) => p < 0)) errors.push('Amounts cannot be negative.');
        if (sum !== subtotal) {
          const diff = subtotal - sum;
          errors.push(
            diff > 0
              ? `${formatCAD(diff)} left to assign.`
              : `Assigned ${formatCAD(-diff)} too much.`
          );
        }
      } else if (method === 'percent') {
        const pcts = ids.map((id) => Number(values[id]) || 0);
        const sum = pcts.reduce((a, b) => a + b, 0);
        if (pcts.some((p) => p < 0)) errors.push('Percentages cannot be negative.');
        if (Math.abs(sum - 100) > 0.001) {
          errors.push(`Percentages add up to ${+sum.toFixed(2)}%, not 100%.`);
        }
        parts = allocate(subtotal, pcts);
      } else if (method === 'shares') {
        const units = ids.map((id) => Number(values[id]) || 0);
        if (units.some((u) => u < 0)) errors.push('Shares cannot be negative.');
        if (units.reduce((a, b) => a + b, 0) <= 0) errors.push('Give at least one person a share.');
        parts = allocate(subtotal, units);
      }
      ids.forEach((id, i) => {
        add(base, id, parts[i] || 0);
        add(taxable, id, parts[i] || 0);
      });
    }
  }

  // ---- Tax ------------------------------------------------------------
  let tax = 0;
  const taxableTotal = [...taxable.values()].reduce((a, b) => a + b, 0);
  if (taxCfg.mode === 'percent') {
    const pct = Number(taxCfg.value) || 0;
    if (pct < 0 || pct > 100) errors.push('Tax rate must be between 0% and 100%.');
    tax = Math.round((taxableTotal * pct) / 100);
  } else if (taxCfg.mode === 'amount') {
    tax = Math.round(Number(taxCfg.value) || 0);
    if (tax < 0) errors.push('Tax cannot be negative.');
    if (tax > 0 && taxableTotal === 0) errors.push('No taxable items to apply tax to.');
  }

  const ids = [...base.keys()];
  const equal = extrasSplit === 'equal';
  // Tax goes to people with taxable portions: by size, or one equal slice each.
  const taxParts = allocate(tax, ids.map((id) => (equal ? ((taxable.get(id) || 0) > 0 ? 1 : 0) : taxable.get(id) || 0)));
  // Tip goes to everyone with a portion: by size, or one equal slice each.
  const tipBase = Math.max(0, tip);
  if (tipBase > 0 && !ids.some((id) => (base.get(id) || 0) > 0)) errors.push('Add something to split before adding a tip.');
  const tipParts = allocate(tipBase, ids.map((id) => (equal ? ((base.get(id) || 0) > 0 ? 1 : 0) : base.get(id) || 0)));
  // Discount (coupon/promo on the whole bill): never more than the subtotal, and
  // nobody's share goes below zero. By portion is the natural default.
  const discountBase = Math.max(0, discount);
  if (discountBase > subtotal && subtotal > 0) errors.push('The discount is bigger than the items it applies to.');
  const discEqual = discountSplit === 'equal';
  const discParts = allocate(Math.min(discountBase, subtotal), ids.map((id) => (discEqual ? ((base.get(id) || 0) > 0 ? 1 : 0) : base.get(id) || 0)));
  if (discEqual && ids.some((id, i) => (discParts[i] || 0) > (base.get(id) || 0) + (taxParts[i] || 0) + (tipParts[i] || 0))) {
    errors.push('Split equally, the discount would be more than someone’s share. Split it by portion instead.');
  }
  const shares = ids
    .map((id, i) => ({
      userId: id,
      base: base.get(id) || 0,
      tax: taxParts[i] || 0,
      tip: tipParts[i] || 0,
      discount: discParts[i] || 0,
      amount: (base.get(id) || 0) + (taxParts[i] || 0) + (tipParts[i] || 0) - (discParts[i] || 0),
    }))
    .filter((s) => s.amount > 0 || method !== 'itemized');

  const disc = Math.min(discountBase, subtotal);
  return { subtotal, tax, tip: tipBase, discount: disc, total: subtotal + tax + tipBase - disc, shares, errors };
}

/**
 * Validate payers against the expense total.
 * payers = [{ userId, amount (cents) }]
 */
export function validatePayers(payers, total) {
  const errors = [];
  const list = (payers || []).filter((p) => p && p.amount);
  if (!list.length) errors.push('Choose who paid.');
  if (list.some((p) => p.amount < 0)) errors.push('Paid amounts cannot be negative.');
  const sum = list.reduce((a, p) => a + Math.round(p.amount), 0);
  if (list.length && sum !== total) {
    const diff = total - sum;
    errors.push(
      diff > 0
        ? `Payers cover ${formatCAD(sum)} — ${formatCAD(diff)} short of ${formatCAD(total)}.`
        : `Payers cover ${formatCAD(sum)} — ${formatCAD(-diff)} more than ${formatCAD(total)}.`
    );
  }
  return errors;
}

/**
 * Per-expense pairwise debts. Each person who owes (net < 0) owes each person
 * who is owed (net > 0) in proportion to how much that person is owed.
 * Returns [{ from, to, amount }].
 */
export function expenseDebts(payers, splits) {
  const net = new Map();
  for (const p of payers) net.set(p.userId, (net.get(p.userId) || 0) + p.amount);
  for (const s of splits) net.set(s.userId, (net.get(s.userId) || 0) - s.amount);
  const creditors = [...net].filter(([, v]) => v > 0);
  const debtors = [...net].filter(([, v]) => v < 0);
  const out = [];
  for (const [d, v] of debtors) {
    const parts = allocate(-v, creditors.map(([, c]) => c));
    creditors.forEach(([c], i) => {
      if (parts[i] > 0) out.push({ from: d, to: c, amount: parts[i] });
    });
  }
  return out;
}

/**
 * Minimise the number of transfers needed to settle a set of net balances.
 * nets: Map|Object userId -> cents (positive = is owed, negative = owes).
 * Greedy: repeatedly match the largest debtor with the largest creditor.
 * Returns [{ from, to, amount }].
 */
export function simplifyDebts(nets) {
  const entries = nets instanceof Map ? [...nets] : Object.entries(nets).map(([k, v]) => [Number(k), v]);
  const cred = entries.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  const debt = entries.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const out = [];
  const byAmount = (a, b) => b.v - a.v || String(a.id).localeCompare(String(b.id));
  while (cred.length && debt.length) {
    cred.sort(byAmount);
    debt.sort(byAmount);
    const c = cred[0];
    const d = debt[0];
    const amt = Math.min(c.v, d.v);
    if (amt > 0) out.push({ from: d.id, to: c.id, amount: amt });
    c.v -= amt;
    d.v -= amt;
    if (c.v === 0) cred.shift();
    if (d.v === 0) debt.shift();
  }
  return out;
}
