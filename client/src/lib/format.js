export { formatCAD, toCents, centsToInput } from '@shared/split.js';

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const parse = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function formatDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const d = parse(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-CA', sameYear ? opts : { ...opts, year: 'numeric' });
}

export function relativeDate(iso) {
  if (!iso) return '';
  const d = parse(iso);
  const today = parse(todayISO());
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-CA', { weekday: 'long' });
  return formatDate(iso);
}

export function monthLabel(iso) {
  const d = parse(iso.length === 7 ? `${iso}-01` : iso);
  return d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

export function dayParts(iso) {
  const d = parse(iso);
  return { day: d.getDate(), mon: d.toLocaleDateString('en-CA', { month: 'short' }).replace('.', '') };
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const firstName = (name = '') => name.trim().split(/\s+/)[0] || name;

/** Display name for a user id relative to the viewer ("You"). */
export function nameOf(people, id, meId, { you = 'You' } = {}) {
  if (id === meId) return you;
  return people?.[id]?.displayName ? firstName(people[id].displayName) : 'Someone';
}

const PALETTE = ['lime', 'coral', 'iris', 'sky', 'sand', 'mint', 'rose'];
export function colorFor(key = '') {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Viewer's net on one expense: positive = lent, negative = borrowed. */
export function myNet(expense, meId) {
  const paid = expense.payers.filter((p) => p.userId === meId).reduce((a, p) => a + p.amount, 0);
  const owed = expense.splits.filter((s) => s.userId === meId).reduce((a, s) => a + s.amount, 0);
  return paid - owed;
}

export const cls = (...xs) => xs.filter(Boolean).join(' ');
