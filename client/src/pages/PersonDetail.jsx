import { Link, useParams } from 'react-router-dom';
import { Plus, ArrowLeftRight, Receipt } from 'lucide-react';
import { useApi } from '../lib/useApi.js';
import { useAuth } from '../lib/auth.jsx';
import { Avatar, Empty, ErrorState, ListSkeleton, Skeleton, TopBar } from '../components/ui.jsx';
import { ExpenseList } from '../components/ExpenseRow.jsx';
import { formatCAD, firstName, cls } from '../lib/format.js';

export default function PersonDetail() {
  const { username } = useParams();
  const { user } = useAuth();
  const { data, error, reload } = useApi(`/people/${encodeURIComponent(username)}`);

  if (error) return (<><TopBar back="/people" /><ErrorState error={error} onRetry={reload} /></>);
  if (!data) return (<><TopBar back="/people" /><Skeleton h={220} r={28} /><div style={{ height: 12 }} /><ListSkeleton /></>);

  const { user: other, balance, groups } = data;
  const isMe = other.id === user.id;
  const fname = firstName(other.displayName);

  return (
    <>
      <TopBar back="/people" title={<span className="hide-desktop">{other.displayName}</span>} />
      <section className="hero" style={{ '--hero-tone': balance < 0 ? 'var(--coral)' : 'var(--lime)', textAlign: 'center' }}>
        <Avatar user={other} size="xl" className="" />
        <h1 style={{ fontSize: 26, marginTop: 14 }}>{other.displayName}</h1>
        <p className="muted">@{other.username}</p>
        {!isMe && (
          <>
            <div style={{ marginTop: 20 }}>
              <span className="eyebrow">{!balance ? 'All settled up' : balance > 0 ? `${fname} owes you` : `You owe ${fname}`}</span>
              <div className={cls('display num', balance > 0 && 'pos', balance < 0 && 'neg')} style={{ fontSize: 44, fontWeight: 650, lineHeight: 1, marginTop: 6 }}>
                {formatCAD(balance)}
              </div>
            </div>
            {groups.length > 0 && (
              <div className="chips" style={{ justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                {groups.map((g) => (
                  <span key={g.groupId || 0} className={cls('pill', g.amount > 0 ? 'pos' : 'neg')}>
                    {g.groupName || 'Non-group'} {formatCAD(g.amount, { signed: true })}
                  </span>
                ))}
              </div>
            )}
            <div className="quick-actions" style={{ marginTop: 20 }}>
              <Link to={`/expenses/new?with=${other.username}`} className="btn btn-primary">
                <Plus /> Add expense
              </Link>
              <Link to={`/settle?with=${other.username}`} className="btn btn-secondary">
                <ArrowLeftRight /> Settle up
              </Link>
            </div>
          </>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Shared history</h2></div>
        {data.expenses.length ? (
          <ExpenseList expenses={data.expenses} people={data.people} />
        ) : (
          <Empty icon={Receipt} title="Nothing shared yet" action={!isMe && <Link to={`/expenses/new?with=${other.username}`} className="btn btn-secondary btn-sm"><Plus /> Split something with {fname}</Link>}>
            Expenses you split with {fname} will show up here.
          </Empty>
        )}
      </section>
    </>
  );
}
