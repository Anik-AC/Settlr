import { Link } from 'react-router-dom';
import { CategoryGlyph } from './ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { formatCAD, dayParts, monthLabel, myNet, nameOf, cls } from '../lib/format.js';
import { paymentMethodLabel } from '../lib/categories.js';

export function ExpenseRow({ expense: e, people, showGroup = true }) {
  const { user } = useAuth();
  const me = user.id;
  const { day, mon } = dayParts(e.date);
  const net = myNet(e, me);

  let sub;
  let endLabel;
  let endValue = null;
  let tone = '';

  if (e.type === 'payment') {
    const from = e.payers[0]?.userId;
    const to = e.splits[0]?.userId;
    sub = `${nameOf(people, from, me)} paid ${nameOf(people, to, me, { you: 'you' })} · ${paymentMethodLabel(e.method)}`;
    if (from === me) {
      endLabel = 'you paid';
      endValue = formatCAD(e.total);
    } else if (to === me) {
      endLabel = 'you received';
      endValue = formatCAD(e.total);
    } else {
      endLabel = 'payment';
      endValue = formatCAD(e.total);
    }
  } else {
    const payers = e.payers;
    const who =
      payers.length === 1
        ? `${nameOf(people, payers[0].userId, me)} paid ${formatCAD(e.total)}`
        : `${payers.length} people paid ${formatCAD(e.total)}`;
    sub = showGroup && e.groupName ? `${who} · ${e.groupName}` : who;
    if (net > 0) {
      endLabel = 'you lent';
      endValue = formatCAD(net);
      tone = 'pos';
    } else if (net < 0) {
      endLabel = 'you borrowed';
      endValue = formatCAD(net);
      tone = 'neg';
    } else {
      const involved = e.splits.some((s) => s.userId === me) || e.payers.some((p) => p.userId === me);
      endLabel = involved ? 'all square' : 'not involved';
    }
  }

  return (
    <Link to={`/expenses/${e.id}`} className="item">
      <span className="date-chip" aria-hidden="true">
        <span className="mon">{mon}</span>
        <span className="day">{day}</span>
      </span>
      <CategoryGlyph category={e.type === 'payment' ? 'payment' : e.category} />
      <span className="item-main">
        <span className="item-title">{e.description}</span>
        <span className="item-sub">{sub}</span>
      </span>
      <span className="item-end">
        <span className="label">{endLabel}</span>
        {endValue && <span className={cls('value', tone)}>{endValue}</span>}
      </span>
    </Link>
  );
}

/** Expenses grouped under sticky month headings. */
export function ExpenseList({ expenses, people, showGroup = true }) {
  const groups = [];
  for (const e of expenses) {
    const key = e.date.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) groups.push((g = { key, items: [] }));
    g.items.push(e);
  }
  return (
    <div>
      {groups.map((g) => (
        <section key={g.key} aria-label={monthLabel(g.key)}>
          <div className="month-head">
            <span className="eyebrow">{monthLabel(g.key)}</span>
          </div>
          <div className="list">
            {g.items.map((e) => (
              <ExpenseRow key={e.id} expense={e} people={people} showGroup={showGroup} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
